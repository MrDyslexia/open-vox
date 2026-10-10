import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, createConfigReader, kokoroLanguageCode } from "./config";
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
  /** Read on every utterance so voice and speed changes apply immediately. */
  settings?: () => KokoroSettings;
  run: Runner;
  tmpDir: string;
  unlink: (file: string) => void;
};

export type KokoroSettings = { voices: Record<Language, string>; speed: number };
export const DEFAULT_KOKORO_VOICES: Record<Language, string> = DEFAULT_CONFIG.voices;

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
    commandFor: (language, wav) => {
      const live = config.settings?.() ?? config;
      const voice = live.voices[language];
      return {
        cmd: config.python,
        args: [
          config.script,
          "--model", config.modelPath,
          "--voices", config.voicesPath,
          "--voice", voice,
          "--lang", kokoroLanguageCode(voice),
          "--speed", String(live.speed),
          "--out", wav,
        ],
      };
    },
  });
}

export function defaultKokoroEngine(
  env: Record<string, string | undefined> = process.env,
  getConfig: () => import("./config").Config = createConfigReader(),
): Engine | undefined {
  const root = env.AGENTVOZ_HOME?.trim() || win32.join(env.LOCALAPPDATA ?? "", "agentVoz");
  const paths = resolveKokoro(root, env);
  if (!paths) return undefined;
  const script = fileURLToPath(new URL("../scripts/kokoro_say.py", import.meta.url));
  if (!existsSync(script)) return undefined;
  return kokoroEngine({
    ...paths, script,
    // Environment variables stay as explicit overrides on top of the shared config file.
    settings: () => {
      const config = getConfig();
      return {
        voices: {
          es: env.AGENTVOZ_KOKORO_VOICE_ES?.trim() || config.voices.es,
          en: env.AGENTVOZ_KOKORO_VOICE_EN?.trim() || config.voices.en,
        },
        speed: env.AGENTVOZ_SPEED?.trim() && Number.isFinite(Number(env.AGENTVOZ_SPEED)) ? Number(env.AGENTVOZ_SPEED) : config.speed,
      };
    },
    run: windowsRunner,
    tmpDir: tmpdir(),
    unlink: (file) => { try { unlinkSync(file); } catch {} },
  });
}
