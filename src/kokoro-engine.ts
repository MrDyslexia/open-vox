import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsRunner, wavEngine, type Runner } from "./piper-engine";
import type { Engine } from "./speech-sink";
import type { Language } from "./speech-text";

export type KokoroPaths = {
  python: string;
  modelPath: string;
  voicesPath: string;
  voices: Record<Language, string>;
  speed: number;
};
export type KokoroConfig = KokoroPaths & {
  script: string;
  run: Runner;
  tmpDir: string;
  unlink: (file: string) => void;
};

export const DEFAULT_KOKORO_VOICES: Record<Language, string> = { es: "ef_dora", en: "af_heart" };
// Kokoro's phonemizer language codes.
const LANGUAGE_CODE: Record<Language, string> = { es: "es", en: "en-us" };

/** Locates the Kokoro venv, model and voices under `root`; undefined when anything is missing. */
export function resolveKokoro(
  root: string,
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): KokoroPaths | undefined {
  const python = win32.join(root, "kokoro-venv", "Scripts", "python.exe");
  const modelPath = win32.join(root, "kokoro", "kokoro-v1.0.onnx");
  const voicesPath = win32.join(root, "kokoro", "voices-v1.0.bin");
  if (![python, modelPath, voicesPath].every((path) => exists(path))) return undefined;
  const parsed = Number(env.AGENTVOZ_SPEED);
  const speed = Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 2 ? parsed : 1;
  return {
    python, modelPath, voicesPath, speed,
    voices: {
      es: env.AGENTVOZ_KOKORO_VOICE_ES?.trim() || DEFAULT_KOKORO_VOICES.es,
      en: env.AGENTVOZ_KOKORO_VOICE_EN?.trim() || DEFAULT_KOKORO_VOICES.en,
    },
  };
}

export function kokoroEngine(config: KokoroConfig): Engine {
  return wavEngine({
    run: config.run,
    tmpDir: config.tmpDir,
    unlink: config.unlink,
    commandFor: (language, wav) => ({
      cmd: config.python,
      args: [
        config.script,
        "--model", config.modelPath,
        "--voices", config.voicesPath,
        "--voice", config.voices[language],
        "--lang", LANGUAGE_CODE[language],
        "--speed", String(config.speed),
        "--out", wav,
      ],
    }),
  });
}

export function defaultKokoroEngine(env: Record<string, string | undefined> = process.env): Engine | undefined {
  const root = env.AGENTVOZ_HOME?.trim() || win32.join(env.LOCALAPPDATA ?? "", "agentVoz");
  const paths = resolveKokoro(root, env);
  if (!paths) return undefined;
  const script = fileURLToPath(new URL("../scripts/kokoro_say.py", import.meta.url));
  if (!existsSync(script)) return undefined;
  return kokoroEngine({
    ...paths, script,
    run: windowsRunner,
    tmpDir: tmpdir(),
    unlink: (file) => { try { unlinkSync(file); } catch {} },
  });
}
