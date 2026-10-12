import { existsSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { envValue, homeFor } from "./brand";
import { DEFAULT_CONFIG, MAX_SPEED, MIN_SPEED, createConfigReader, kokoroLanguageCode } from "./config";
import { wavEngine, type Runner } from "./piper-engine";
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
  appHome?: string;
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
  const parsed = Number(envValue(env, "SPEED"));
  const speed = Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 2 ? parsed : 1;
  return {
    python, modelPath, voicesPath, speed,
    voices: {
      es: envValue(env, "KOKORO_VOICE_ES") || DEFAULT_KOKORO_VOICES.es,
      en: envValue(env, "KOKORO_VOICE_EN") || DEFAULT_KOKORO_VOICES.en,
    },
  };
}

export function kokoroEngine(config: KokoroConfig): Engine {
  const make = (plan: boolean) => wavEngine({
    run: config.run,
    tmpDir: config.tmpDir,
    unlink: config.unlink,
    commandFor: (language, wav) => {
      const live = config.settings?.() ?? config;
      const voice = live.voices[language];
      const speed = Number.isFinite(live.speed) && live.speed >= MIN_SPEED && live.speed <= MAX_SPEED ? live.speed : 1;
      return {
        cmd: config.python,
        args: [
          config.script,
          "--model", config.modelPath,
          "--voices", config.voicesPath,
          "--voice", voice,
          "--lang", kokoroLanguageCode(voice),
          "--speed", String(speed),
          "--out", wav,
          ...(plan ? ["--plan-json", ...(config.appHome ? ["--app-home", config.appHome] : [])] : []),
        ],
      };
    },
  });
  const engine = make(false);
  const planned = make(true);
  engine.synthesizePlan = (plan, wav) => planned.synthesize!(JSON.stringify(plan), plan.defaultLanguage, wav);
  engine.speakPlan = (plan) => planned(JSON.stringify(plan), plan.defaultLanguage);
  return engine;
}

/** Local inference only. Bound and validate helper diagnostics; never forward third-party stderr/prose. */
export function narrationRunner(onDiagnostic: (code: string) => void = () => {}): Runner {
  return (cmd, args, stdin) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: {
      ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1",
      HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1",
      HF_HUB_DISABLE_PROGRESS_BARS: "1", DO_NOT_TRACK: "1",
    } });
    let output = "", oversized = false;
    child.stdout.on("data", (data: Buffer) => {
      if (output.length + data.length > 8192) oversized = true;
      if (!oversized) output += data.toString("utf8");
    });
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => {
        if (args.includes("--plan-json") && code === 0) {
          try {
            const value = JSON.parse(output);
            if (oversized || Object.keys(value).join() !== "diagnostics" || !Array.isArray(value.diagnostics)
                || value.diagnostics.length > 32 || !value.diagnostics.every((c: unknown) =>
                  typeof c === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(c))) throw new Error();
            for (const c of value.diagnostics) { try { onDiagnostic(c); } catch {} }
          } catch { resolve(2); return; }
        }
        resolve(code ?? 1);
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "", "utf8");
    return { exited, kill: () => { child.kill(); } };
  };
}

export function defaultKokoroEngine(
  env: Record<string, string | undefined> = process.env,
  getConfig: () => import("./config").Config = createConfigReader(),
  onDiagnostic?: (code: string) => void,
): Engine | undefined {
  const root = homeFor(env);
  const paths = resolveKokoro(root, env);
  if (!paths) return undefined;
  const script = fileURLToPath(new URL("../scripts/kokoro_say.py", import.meta.url));
  if (!existsSync(script)) return undefined;
  return kokoroEngine({
    ...paths, script, appHome: root,
    // Environment variables stay as explicit overrides on top of the shared config file.
    settings: () => {
      const config = getConfig();
      return {
        voices: {
          es: envValue(env, "KOKORO_VOICE_ES") || config.voices.es,
          en: envValue(env, "KOKORO_VOICE_EN") || config.voices.en,
        },
        speed: Number.isFinite(Number(envValue(env, "SPEED"))) && envValue(env, "SPEED") ? Number(envValue(env, "SPEED")) : config.speed,
      };
    },
    run: narrationRunner(onDiagnostic),
    tmpDir: tmpdir(),
    unlink: (file) => { try { unlinkSync(file); } catch {} },
  });
}
