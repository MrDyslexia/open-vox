import { expect, test } from "bun:test";
import { setupNarration, PN_ENV_PROBE, PN_PROBE, narrationProbeArgs, narrationProcessEnv, nodeNarrationDownload, nodeNarrationFs, type NarrationSetupDeps } from "../src/setup";
import { LID_MANIFEST, narrationPaths, PN_READY_RECORD } from "../src/narration-assets";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { PN_PACKAGES } from "../src/narration-assets";

const testAppHome = process.env.OPEN_VOX_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "open-vox");
const testPython = process.env.OPEN_VOX_TEST_PYTHON ?? join(testAppHome, "kokoro-venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

/** Execute only the exported probe, with all required package imports mocked. */
function probeFixture(options: { prefix?: string; outside?: string; actualOutside?: string; distributionOutside?: string; platform?: "posix"; basePrefix?: string; executable?: string; missingFile?: string; importedSpecOutside?: string; importedPathOutside?: string; namespace?: string; cuda?: string; version?: string; basic?: boolean } = {}) {
  const expected = options.platform ? "/managed/pn-venv" : "C:/managed/pn-venv";
  const script = `import sys, os, json, types, ntpath, posixpath, importlib.util, importlib.metadata, importlib
from unittest.mock import patch
options = json.loads(sys.stdin.read())
expected = ${JSON.stringify(expected)}
packages = ${JSON.stringify(PN_PACKAGES)}
path = posixpath if options.get('platform') == 'posix' else ntpath
module_names = {name: name.replace('-', '_') for name in packages}
def origin(name):
    root = 'C:/foreign/site-packages' if name == options.get('outside') or options.get('prefix') else expected + '/site-packages'
    return root + '/' + name + '/__init__.py'
specs = {name: types.SimpleNamespace(origin=origin(name), submodule_search_locations=[path.dirname(origin(name))]) for name in module_names.values()}
specs['pip'] = types.SimpleNamespace(origin=expected + '/site-packages/pip/__init__.py', submodule_search_locations=None)
if options.get('namespace'):
    specs[options['namespace']].origin = None
modules = {name: types.ModuleType(name) for name in module_names.values()}
for name, module in modules.items():
    module.__file__ = origin(name)
    module.__spec__ = specs[name]
    if name == options.get('actualOutside'):
        module.__file__ = 'C:/foreign/site-packages/' + name + '/__init__.py'
    if name == options.get('missingFile'):
        del module.__file__
    if name == options.get('importedSpecOutside'):
        module.__spec__ = types.SimpleNamespace(origin='C:/foreign/site-packages/' + name + '/__init__.py', submodule_search_locations=None)
    if name == options.get('importedPathOutside'):
        module.__path__ = ['C:/foreign/site-packages/' + name]
modules['torch'].version = types.SimpleNamespace(cuda=options.get('cuda'))
modules['transformers'].AutoTokenizer = object()
modules['transformers'].AutoModelForTokenClassification = object()
def distribution(name):
    root = 'C:/foreign/site-packages' if name == options.get('distributionOutside') or options.get('prefix') else expected + '/site-packages'
    return types.SimpleNamespace(version=options.get('version') if name == 'numpy' and options.get('version') else packages[name], locate_file=lambda unused: root)
imports = []
spec_checks = []
def find_spec(name):
    spec_checks.append(name)
    return specs[name]
def load(name):
    imports.append(name)
    return modules[name]
executable = options.get('executable') or expected + ('/bin/python' if options.get('platform') else '/Scripts/python.exe')
# POSIX venv launchers may resolve to a base interpreter outside the environment.
def realpath(value):
    value = path.abspath(value)
    return '/usr/bin/python3' if options.get('platform') and value == executable else value
with patch.object(sys, 'prefix', options.get('prefix', expected)), patch.object(sys, 'base_prefix', options.get('basePrefix', '/base/python')), \
     patch.object(sys, 'executable', executable), patch.object(sys, 'argv', ['probe', expected]), \
     patch.object(os, 'name', 'posix' if options.get('platform') else 'nt'), patch.object(os, 'path', path), \
     patch.object(path, 'realpath', side_effect=realpath), patch.dict(sys.modules, modules), \
     patch('importlib.util.find_spec', side_effect=find_spec), \
     patch('importlib.metadata.version', side_effect=lambda name: packages[name]), \
     patch('importlib.metadata.distribution', side_effect=distribution), patch('importlib.import_module', side_effect=load):
    try:
        exec(${JSON.stringify(options.basic ? PN_ENV_PROBE : PN_PROBE)}, {})
        result = {'ok': True}
    except Exception as error:
        result = {'ok': False, 'code': str(error)}
result['imports'] = imports
result['specs'] = spec_checks
print(json.dumps(result))
`;
  const child = spawnSync(testPython, ["-B", "-c", script], {
    input: JSON.stringify(options), encoding: "utf8", env: narrationProcessEnv(), timeout: 10000,
  });
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout) as { ok: boolean; code?: string; imports: string[]; specs: string[] };
}

test("exported full probe rejects matching-version CPU modules from a foreign interpreter before imports", () => {
  const result = probeFixture({ prefix: "C:/foreign/kokoro-venv" });
  expect(result.ok).toBe(false);
  expect(result.code).toBe("foreign-or-nonvirtual-managed-interpreter");
  expect(result.imports).toEqual([]);
});
test("exported full probe rejects one foreign package spec before executing any packages", () => {
  const result = probeFixture({ outside: "numpy" });
  expect(result.ok).toBe(false);
  expect(result.code).toBe("foreign-or-missing-managed-package-origin");
  expect(result.imports).toEqual([]);
});
test("exported full probe accepts isolated package origins and a real venv identity", () => {
  const result = probeFixture();
  expect(result.ok).toBe(true);
  expect(result.imports).toHaveLength(9);
});
test("exported full probe rejects foreign distributions and rechecks actual imports", () => {
  const distribution = probeFixture({ distributionOutside: "numpy" });
  expect(distribution.ok).toBe(false); expect(distribution.imports).toEqual([]);
  expect(probeFixture({ actualOutside: "numpy" }).code).toBe("foreign-or-missing-imported-package-file");
  expect(probeFixture({ missingFile: "numpy" }).code).toBe("foreign-or-missing-imported-package-file");
  expect(probeFixture({ importedSpecOutside: "numpy" }).code).toBe("foreign-imported-package-origin");
  expect(probeFixture({ importedPathOutside: "numpy" }).code).toBe("foreign-imported-package-path");
  const namespace = probeFixture({ namespace: "numpy" });
  expect(namespace.code).toBe("foreign-or-missing-managed-package-origin"); expect(namespace.imports).toEqual([]);
});
test("exported probes reject base interpreters and foreign launchers but allow POSIX base symlink targets", () => {
  expect(probeFixture({ basePrefix: "C:/managed/pn-venv" }).ok).toBe(false);
  expect(probeFixture({ executable: "C:/foreign/Scripts/python.exe" }).ok).toBe(false);
  expect(probeFixture({ platform: "posix" }).ok).toBe(true);
});
test("basic preinstallation probe does not require or import runtime dependencies", () => {
  const result = probeFixture({ basic: true, outside: "numpy", version: "wrong", cuda: "synthetic-cuda" });
  expect(result.ok).toBe(true); expect(result.imports).toEqual([]);
  expect(result.specs).toEqual(["pip"]);
});
test("full provenance probe retains exact version and CPU-only checks", () => {
  expect(probeFixture({ version: "wrong" }).code).toBe("incompatible-managed-package-version");
  expect(probeFixture({ cuda: "synthetic-cuda" }).code).toBe("non-cpu-managed-torch");
});
test("setup rejects an existing foreign interpreter before launching pip or mutating its hint", async () => {
  const f = fixture(); f.files.set(f.paths.python, "foreign interpreter"); f.files.set(f.paths.marker, PN_READY_RECORD);
  f.deps.run = async (cmd, args) => { f.calls.push({ cmd, args }); return args.includes("pip") ? 0 : 1; };
  await expect(setupNarration(f.deps)).rejects.toThrow();
  expect(f.calls.some(call => call.args.includes("pip"))).toBe(false);
  expect(f.files.get(f.paths.marker)).toBe(PN_READY_RECORD);
  expect(f.downloads).toHaveLength(0);
});

function fixture() {
  const paths = narrationPaths("R");
  const files = new Map<string, string>([["R\\kokoro\\kokoro-v1.0.onnx", "user model"], ["R\\kokoro\\voices-v1.0.bin", "user voices"]]);
  const calls: { cmd: string; args: string[] }[] = [], downloads: string[] = [], removed: string[] = [];
  let wrongHash = false, exit = 0;
  const deps: NarrationSetupDeps = {
    home: "R", systemPython: "system-python", exists: p => files.has(p), log() {},
    run: async (cmd, args) => { calls.push({ cmd, args }); files.set(paths.python, "python"); return exit; },
    download: async (url, dest) => { downloads.push(url); files.set(dest, "download"); },
    fingerprint: p => {
      const name = p.split("\\").at(-1)!;
      const file = LID_MANIFEST.files.find(f => name === f.filename || name.startsWith(`${f.filename}.`))!;
      return { bytes: file.bytes, sha256: wrongHash ? "0".repeat(64) : file.sha256 };
    },
    publish: (from, to) => { if (files.has(to)) throw Error("overwrite"); files.set(to, files.get(from)!); files.delete(from); },
    remove: p => { removed.push(p); files.delete(p); },
    writeReady: (path, data) => { files.set(path, data); },
    assertManagedPath() {},
    validateModelDirectory() {},
  };
  return { deps, paths, calls, downloads, files, removed, badHash: () => { wrongHash = true; }, fail: () => { exit = 1; } };
}

test("narration provisions only its own venv, CPU torch, pinned anonymous assets and a final ready record", async () => {
  const f = fixture();
  await setupNarration(f.deps);
  expect(f.calls[0]).toEqual({ cmd: "system-python", args: ["-m", "venv", f.paths.venv] });
  expect(f.calls[1]!.args).toEqual(narrationProbeArgs(f.paths.venv, true));
  expect(f.calls[2]!.args).toEqual(expect.arrayContaining(["torch==2.14.1+cpu", "--index-url", "https://download.pytorch.org/whl/cpu"]));
  expect(f.calls[3]!.args).toContain("https://pypi.org/simple");
  expect(f.calls[3]!.args).toContain("transformers==5.19.0");
  expect(f.calls.slice(1).every(c => c.cmd === f.paths.python)).toBe(true);
  expect(f.calls.at(-1)!.args).toContain(PN_PROBE);
  expect(f.calls.at(-1)!.args.at(-1)).toBe(win32.resolve(f.paths.venv));
  expect(f.downloads).toHaveLength(5);
  expect(f.downloads.every(url => url.startsWith(`https://huggingface.co/${LID_MANIFEST.modelId}/resolve/${LID_MANIFEST.revision}/`))).toBe(true);
  expect(f.files.get(f.paths.marker)).toBe(PN_READY_RECORD);
  expect(f.files.get("R\\kokoro\\kokoro-v1.0.onnx")).toBe("user model");
  expect(f.files.get("R\\kokoro\\voices-v1.0.bin")).toBe("user voices");
  expect([...f.files.keys()].some(p => p.includes("partial"))).toBe(false);
});
test("absent Kokoro instructs existing setup without creating an environment or downloading", async () => {
  const f = fixture(); f.files.clear();
  await expect(setupNarration(f.deps)).rejects.toThrow("setup kokoro");
  expect(f.calls).toHaveLength(0); expect(f.downloads).toHaveLength(0);
});
test("wrong downloaded hash aborts before publishing or readiness and cleans only owned staging", async () => {
  const f = fixture(); f.badHash();
  await expect(setupNarration(f.deps)).rejects.toThrow("integrity");
  expect(f.files.has(f.paths.marker)).toBe(false);
  expect(f.files.has(`${f.paths.model}\\config.json`)).toBe(false);
  expect(f.removed).toHaveLength(1);
  expect(f.removed[0]).toContain(".partial");
  expect(f.files.get("R\\kokoro\\voices-v1.0.bin")).toBe("user voices");
});
test("existing invalid model files are preserved, not overwritten or deleted", async () => {
  const f = fixture(); f.files.set(`${f.paths.model}\\config.json`, "old"); f.badHash();
  await expect(setupNarration(f.deps)).rejects.toThrow("integrity");
  expect(f.files.get(`${f.paths.model}\\config.json`)).toBe("old");
  expect(f.downloads).toHaveLength(0); expect(f.calls).toHaveLength(0); expect(f.removed).toHaveLength(0);
});
test("failed installer never writes readiness", async () => {
  const f = fixture(); f.fail();
  await expect(setupNarration(f.deps)).rejects.toThrow();
  expect(f.files.has(f.paths.marker)).toBe(false);
});
test("failed reinstallation invalidates the old dispatch hint without touching model assets", async () => {
  const f = fixture(); f.files.set(f.paths.marker, PN_READY_RECORD);
  const run = f.deps.run;
  f.deps.run = async (cmd, args) => args.includes("pip") ? 1 : run(cmd, args);
  await expect(setupNarration(f.deps)).rejects.toThrow();
  expect(f.files.has(f.paths.marker)).toBe(false);
  expect(f.files.get("R\\kokoro\\voices-v1.0.bin")).toBe("user voices");
});
test("unsafe managed directories stop before running installers or downloads", async () => {
  const f = fixture(); f.deps.assertManagedPath = () => { throw Error("unsafe"); };
  await expect(setupNarration(f.deps)).rejects.toThrow("unsafe");
  expect(f.calls).toHaveLength(0); expect(f.downloads).toHaveLength(0);
});
test("valid existing assets are reused read-only", async () => {
  const f = fixture();
  for (const file of LID_MANIFEST.files) f.files.set(`${f.paths.model}\\${file.filename}`, "existing");
  await setupNarration(f.deps);
  expect(f.downloads).toHaveLength(0);
  expect(f.files.get(`${f.paths.model}\\model.safetensors`)).toBe("existing");
});
test("child environment excludes ambient configuration, credentials and Python search paths", () => {
  const env = narrationProcessEnv({ PATH: "fixture-path", SystemRoot: "fixture-root", HF_TOKEN: "synthetic-token",
    PIP_INDEX_URL: "https://synthetic.invalid", PYTHONPATH: "synthetic-path", PYTHONHOME: "synthetic-home", HTTP_PROXY: "synthetic-proxy" });
  expect(env.PATH).toBe("fixture-path");
  expect(env.HF_TOKEN).toBe("");
  expect(env.HF_HUB_DISABLE_IMPLICIT_TOKEN).toBe("1");
  expect(env.HF_HUB_OFFLINE).toBe("1");
  expect(env.PIP_CONFIG_FILE).toBe("NUL");
  expect(env.PIP_INDEX_URL).toBeUndefined(); expect(env.PYTHONPATH).toBeUndefined(); expect(env.HTTP_PROXY).toBeUndefined();
  expect(env.PYTHONHOME).toBeUndefined();
  expect(PN_PROBE).not.toMatch(/from_pretrained|load_model|create\(/);
});
test("native staging is anonymous and exclusive; redirects cannot downgrade HTTPS", async () => {
  const root = mkdtempSync(join(tmpdir(), "open-vox-pn-download-test-"));
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("fixture bytes");
    }) as typeof fetch;
    const staging = join(root, "owned.partial"), dest = join(root, "owned.json");
    const url = `https://huggingface.co/${LID_MANIFEST.modelId}/resolve/${LID_MANIFEST.revision}/config.json`;
    await nodeNarrationDownload(url, staging);
    expect(calls[0]!.init!.credentials).toBe("omit");
    expect(calls[0]!.init!.redirect).toBe("manual");
    expect(calls[0]!.init!.headers).toEqual({ "User-Agent": "open-vox-narration-setup/1" });
    nodeNarrationFs.publish(staging, dest);
    nodeNarrationFs.remove(staging);
    expect(readFileSync(dest, "utf8")).toBe("fixture bytes");
    writeFileSync(staging, "new bytes");
    expect(() => nodeNarrationFs.publish(staging, dest)).toThrow();
    expect(readFileSync(dest, "utf8")).toBe("fixture bytes");
    globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: "http://huggingface.co/unsafe" } })) as unknown as typeof fetch;
    await expect(nodeNarrationDownload(url, join(root, "unsafe.partial"))).rejects.toThrow("Unsafe LID redirect");
    expect(existsSync(join(root, "unsafe.partial"))).toBe(false);
    await expect(nodeNarrationDownload("https://evil.test/config.json", join(root, "bad.partial"))).rejects.toThrow("Unsafe LID download URL");
  } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
});
