import { spawn } from "node:child_process";
import { createWriteStream, existsSync, linkSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_VOICES } from "./piper-engine";
import { LID_BYTES, LID_MANIFEST, PN_PACKAGES, PN_READY_RECORD, assertLidDirectory, fileFingerprint, lidDownloadUrl, matchesLidFile, narrationPaths, type Fingerprint } from "./narration-assets";

export type SetupDeps = {
  home: string;
  systemPython: string;
  exists: (path: string) => boolean;
  run: (cmd: string, args: string[]) => Promise<number>;
  download: (url: string, dest: string) => Promise<void>;
  log: (line: string) => void;
};

const KOKORO_BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0";
export const KOKORO_FILES = [
  { name: "kokoro-v1.0.onnx", note: "310 MB" },
  { name: "voices-v1.0.bin", note: "27 MB" },
] as const;

const PIPER_ZIP = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip";
const PIPER_VOICES = "https://huggingface.co/rhasspy/piper-voices/resolve/main";
const PIPER_FILES = [
  { dir: "es/es_MX/claude/high", name: `${DEFAULT_VOICES.es}` },
  { dir: "en/en_US/lessac/high", name: `${DEFAULT_VOICES.en}` },
];

async function must(deps: SetupDeps, cmd: string, args: string[]): Promise<void> {
  const code = await deps.run(cmd, args);
  if (code !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed with exit code ${code}`);
}

/** Custom voices shipped with open-vox (resources/voices/<id>.npy) and the helper that merges them into the pack. */
export const BUNDLED_VOICES_SCRIPT = fileURLToPath(new URL("../scripts/add_voices.py", import.meta.url));
export const BUNDLED_VOICES_DIR = fileURLToPath(new URL("../resources/voices", import.meta.url));

/**
 * Creates an isolated venv, installs kokoro-onnx, and downloads the model and voices (about 340 MB).
 * Then merges the bundled custom voices into the voices pack. That step is idempotent and also runs on
 * existing installs, so re-running `setup kokoro` is how an older install receives a new bundled voice.
 */
export async function setupKokoro(deps: SetupDeps): Promise<void> {
  const venv = win32.join(deps.home, "kokoro-venv");
  const python = win32.join(venv, "Scripts", "python.exe");
  if (!deps.exists(python)) {
    deps.log("Creating Python virtual environment...");
    await must(deps, deps.systemPython, ["-m", "venv", venv]);
  }
  deps.log("Installing kokoro-onnx and soundfile...");
  await must(deps, python, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "kokoro-onnx", "soundfile"]);
  for (const file of KOKORO_FILES) {
    const dest = win32.join(deps.home, "kokoro", file.name);
    if (deps.exists(dest)) continue;
    deps.log(`Downloading ${file.name} (${file.note})...`);
    await deps.download(`${KOKORO_BASE}/${file.name}`, dest);
  }
  deps.log("Adding bundled voices...");
  await must(deps, python, [
    BUNDLED_VOICES_SCRIPT,
    "--pack", win32.join(deps.home, "kokoro", "voices-v1.0.bin"),
    "--voices-dir", BUNDLED_VOICES_DIR,
  ]);
  deps.log("Kokoro is ready.");
}

/** Downloads the Piper binary and the default Spanish and English voices (about 190 MB). */
export async function setupPiper(deps: SetupDeps): Promise<void> {
  const exe = win32.join(deps.home, "piper", "piper.exe");
  if (!deps.exists(exe)) {
    const zip = win32.join(deps.home, "piper.zip");
    deps.log("Downloading Piper (21 MB)...");
    await deps.download(PIPER_ZIP, zip);
    await must(deps, "powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${deps.home.replace(/'/g, "''")}' -Force; Remove-Item -LiteralPath '${zip.replace(/'/g, "''")}'`,
    ]);
  }
  for (const voice of PIPER_FILES) {
    for (const suffix of [".onnx", ".onnx.json"]) {
      const dest = win32.join(deps.home, "voices", voice.name + suffix);
      if (deps.exists(dest)) continue;
      deps.log(`Downloading ${voice.name}${suffix}...`);
      await deps.download(`${PIPER_VOICES}/${voice.dir}/${voice.name}${suffix}`, dest);
    }
  }
  deps.log("Piper is ready.");
}

export type NarrationSetupDeps = SetupDeps & {
  fingerprint: (path: string) => Fingerprint;
  publish: (from: string, to: string) => void;
  remove: (path: string) => void;
  writeReady: (path: string, record: string) => void;
  assertManagedPath: (path: string) => void;
  validateModelDirectory: (path: string) => void;
};

/** Caller-supplied managed root, never a root inferred from the interpreter being checked. */
export const PN_ENV_PROBE = `import os, sys, re, importlib.util
def require(condition, code):
    if not condition:
        raise RuntimeError(code)
require(len(sys.argv) == 2 and os.path.isabs(sys.argv[1]), 'missing-expected-managed-root')
root = os.path.normcase(os.path.realpath(sys.argv[1]))
def real(value):
    return os.path.normcase(os.path.realpath(value))
def concrete_inside(value):
    if not isinstance(value, str) or not os.path.isabs(value):
        return False
    try:
        return os.path.commonpath([root, real(value)]) == root
    except (ValueError, OSError):
        return False
require(real(sys.prefix) == root and real(sys.base_prefix) != root, 'foreign-or-nonvirtual-managed-interpreter')
# Keep the launcher lexical: POSIX venv bin/python normally symlinks to base Python.
executable = os.path.normcase(os.path.abspath(sys.executable))
launcher = os.path.normcase(os.path.join(os.path.abspath(sys.argv[1]), 'Scripts' if os.name == 'nt' else 'bin'))
require(os.path.dirname(executable) == launcher and bool(re.fullmatch(r'python(?:3(?:\\.\\d+)?)?(?:\\.exe)?', os.path.basename(executable))), 'foreign-managed-launcher')
def check_spec(spec, code):
    require(spec is not None and concrete_inside(spec.origin), code)
    locations = getattr(spec, 'submodule_search_locations', None)
    require(locations is None or all(concrete_inside(location) for location in locations), code)
check_spec(importlib.util.find_spec('pip'), 'foreign-or-missing-managed-pip')
`;

/** Provenance/version/CPU probe only; no model construction, text, inference or downloads. */
export const PN_PROBE = `${PN_ENV_PROBE}import importlib, importlib.metadata as m
expected = ${JSON.stringify(PN_PACKAGES)}
names = {name: name.replace('-', '_') for name in expected}
# Preflight EVERY required origin/distribution before executing any required import.
for package, version in expected.items():
    check_spec(importlib.util.find_spec(names[package]), 'foreign-or-missing-managed-package-origin')
    distribution = m.distribution(package)
    require(concrete_inside(str(distribution.locate_file(''))), 'foreign-managed-distribution-root')
    require(distribution.version == version, 'incompatible-managed-package-version')
loaded = {}
for package, name in names.items():
    module = importlib.import_module(name)
    require(concrete_inside(getattr(module, '__file__', None)), 'foreign-or-missing-imported-package-file')
    check_spec(getattr(module, '__spec__', None), 'foreign-imported-package-origin')
    require(all(concrete_inside(location) for location in getattr(module, '__path__', [])), 'foreign-imported-package-path')
    distribution = m.distribution(package)
    require(concrete_inside(str(distribution.locate_file(''))) and distribution.version == expected[package], 'changed-managed-distribution')
    loaded[name] = module
require(loaded['torch'].version.cuda is None, 'non-cpu-managed-torch')
from transformers import AutoTokenizer, AutoModelForTokenClassification
`;

export function narrationProbeArgs(expectedVenv: string, basic = false): string[] {
  return ["-B", "-c", basic ? PN_ENV_PROBE : PN_PROBE, win32.resolve(expectedVenv)];
}

export async function setupNarration(deps: NarrationSetupDeps): Promise<void> {
  const paths = narrationPaths(deps.home);
  if (!KOKORO_FILES.every(file => deps.exists(win32.join(deps.home, "kokoro", file.name)))) {
    throw new Error("Existing Kokoro model/voices are required; run: open-vox setup kokoro");
  }
  deps.assertManagedPath(paths.venv);
  deps.assertManagedPath(paths.model);
  deps.validateModelDirectory(paths.model);
  // Reject existing corrupt files before installing anything. Never overwrite user assets.
  for (const file of LID_MANIFEST.files) {
    const dest = win32.join(paths.model, file.filename);
    if (deps.exists(dest) && !matchesLidFile(deps.fingerprint(dest), file)) {
      throw new Error(`Existing LID integrity failure: ${file.filename}; preserved for manual inspection`);
    }
  }
  deps.log(`Contextual narration: ${LID_BYTES} model bytes (~712 MB), plus isolated CPU environment (~2 GB total estimate; varies by Python/wheels/cache).`);
  if (!deps.exists(paths.python)) await must(deps, deps.systemPython, ["-m", "venv", paths.venv]);
  // Reject a hijacked existing launcher before pip or even invalidating its old hint.
  await must(deps, paths.python, narrationProbeArgs(paths.venv, true));
  if (deps.exists(paths.marker)) deps.remove(paths.marker);
  const pip = ["-m", "pip", "--isolated", "install", "--disable-pip-version-check", "--no-input", "--no-cache-dir", "--only-binary=:all:", "--keyring-provider", "disabled", "--extra-index-url", ""];
  await must(deps, paths.python, [...pip, "--index-url", "https://download.pytorch.org/whl/cpu", `torch==${PN_PACKAGES.torch}`]);
  await must(deps, paths.python, [...pip, "--index-url", "https://pypi.org/simple",
    ...Object.entries(PN_PACKAGES).filter(([name]) => name !== "torch").map(([name, version]) => `${name}==${version}`)]);
  await must(deps, paths.python, narrationProbeArgs(paths.venv));
  for (const file of LID_MANIFEST.files) {
    const dest = win32.join(paths.model, file.filename);
    if (deps.exists(dest)) continue;
    const partial = `${dest}.${randomUUID()}.partial`;
    try {
      deps.log(`Downloading pinned ${file.filename} (${file.bytes} bytes)...`);
      await deps.download(lidDownloadUrl(file), partial);
      if (!matchesLidFile(deps.fingerprint(partial), file)) throw new Error(`LID integrity failure: ${file.filename}`);
      deps.publish(partial, dest);
    } finally { deps.remove(partial); }
  }
  // Recheck the whole set before the dispatch hint is published.
  for (const file of LID_MANIFEST.files) {
    if (!matchesLidFile(deps.fingerprint(win32.join(paths.model, file.filename)), file)) throw new Error("LID integrity failure");
  }
  deps.writeReady(paths.marker, PN_READY_RECORD);
  deps.log("Contextual narration assets/dependencies are ready; live inference/listening compatibility still requires validation. Run: open-vox doctor");
}

/** Reject junction/symlink ancestors; managed provisioning never follows redirected directories. */
export function assertManagedPath(path: string): void {
  let current = win32.resolve(path);
  for (;;) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Unsafe managed narration path");
    const parent = win32.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export const nodeNarrationFs = {
  fingerprint: fileFingerprint,
  assertManagedPath,
  validateModelDirectory: (path: string) => { assertLidDirectory(path, true); },
  publish: (from: string, to: string) => {
    assertManagedPath(win32.dirname(to));
    // Exclusive link publication refuses an existing destination, including a race.
    linkSync(from, to);
  },
  remove: (path: string) => { rmSync(path, { force: true }); },
  writeReady: (path: string, record: string) => {
    assertManagedPath(win32.dirname(path));
    const partial = `${path}.${randomUUID()}.partial`;
    try { writeFileSync(partial, record, { flag: "wx" }); renameSync(partial, path); }
    finally { rmSync(partial, { force: true }); }
  },
};

/** Child-only isolation: no ambient installer configuration or implicit Hub credentials. */
export const narrationProcessEnv = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA"]) {
    if (source[name]) env[name] = source[name];
  }
  return { ...env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1",
    PIP_CONFIG_FILE: "NUL", HF_HUB_DISABLE_IMPLICIT_TOKEN: "1", HF_TOKEN: "", HUGGING_FACE_HUB_TOKEN: "",
    HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" };
};

export const nodeNarrationRun = (cmd: string, args: string[]): Promise<number> => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true, env: narrationProcessEnv() });
  const timer = setTimeout(() => { child.kill(); resolve(1); }, args.includes("-c") ? 30000 : 20 * 60 * 1000);
  child.once("error", error => { clearTimeout(timer); reject(error); });
  child.once("close", code => { clearTimeout(timer); resolve(code ?? 1); });
});

/** Raw anonymous HTTPS, no SDK/session/token/netrc and no arbitrary manifest URL. */
export async function nodeNarrationDownload(url: string, dest: string): Promise<void> {
  if (!LID_MANIFEST.files.some(file => lidDownloadUrl(file) === url)) throw new Error("Unsafe LID download URL");
  assertManagedPath(win32.dirname(dest));
  mkdirSync(win32.dirname(dest), { recursive: true });
  let target = url;
  const signal = AbortSignal.timeout(20 * 60 * 1000);
  for (let redirects = 0; redirects <= 6; redirects++) {
    const parsed = new URL(target);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password
        || !(parsed.hostname === "huggingface.co" || parsed.hostname.endsWith(".huggingface.co") || parsed.hostname.endsWith(".hf.co"))) {
      throw new Error("Unsafe LID redirect");
    }
    const response = await fetch(target, { redirect: "manual", credentials: "omit",
      headers: { "User-Agent": "open-vox-narration-setup/1" }, signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Missing LID redirect");
      target = new URL(location, target).href;
      continue;
    }
    if (!response.ok || !response.body) throw new Error("Pinned LID download failed");
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(dest, { flags: "wx" }));
    return;
  }
  throw new Error("Too many LID redirects");
}

export const nodeRun = (cmd: string, args: string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

/** Streams a URL to disk through a temp file, so an interrupted download never leaves a partial target. */
export async function nodeDownload(url: string, dest: string): Promise<void> {
  mkdirSync(win32.dirname(dest), { recursive: true });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`);
  const tmp = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp));
    renameSync(tmp, dest);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
