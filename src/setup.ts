import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, renameSync, rmSync } from "node:fs";
import { win32 } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DEFAULT_VOICES } from "./piper-engine";

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

/** Creates an isolated venv, installs kokoro-onnx, and downloads the model and voices (about 340 MB). */
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
