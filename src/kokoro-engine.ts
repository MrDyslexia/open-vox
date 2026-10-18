import { existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { envValue, homeFor } from "./brand";
import { DEFAULT_CONFIG, MAX_SPEED, MIN_SPEED, createConfigReader, kokoroLanguageCode, validToneVoice, validToneWeight } from "./config";
import { wavEngine, type Runner } from "./piper-engine";
import type { Engine, SpeechProcess } from "./speech-sink";
import type { Language } from "./speech-text";
import { LID_MANIFEST_PATH, narrationPaths } from "./narration-assets";
import { createNarrationRuntimeSource, type NarrationRuntime } from "./narration-runtime";
import type { ModelDevices } from "./repeat-control";
import { selectGpuPython } from "./gpu-runtime";
import { NarrationWorker, type WorkerOptions } from "./narration-worker";

export type KokoroPaths = {
  python: string;
  modelPath: string;
  voicesPath: string;
  voices: Record<Language, string>;
  speed: number;
  toneVoice?: Partial<Record<Language, string>>;
  toneWeight?: Partial<Record<Language, number>>;
};
export type KokoroConfig = KokoroPaths & {
  script: string;
  appHome?: string;
  narrationPython?: () => string | undefined;
  lidManifest?: string;
  /**
   * Coherent interpreter/manifest/model-dir tuple for planned runs, resolved per plan call.
   * When absent the legacy `narrationPython`/`lidManifest` pair is used unchanged.
   */
  narrationRuntime?: () => NarrationRuntime | undefined;
  directPython?: () => string | undefined;
  /** Read on every utterance so voice, tone and speed changes apply immediately. */
  settings?: () => KokoroSettings;
  run: Runner;
  tmpDir: string;
  unlink: (file: string) => void;
  /** Production enables private persistent transport. Omit only for legacy one-shot Runner callers. */
  worker?: WorkerOptions;
  /** Optional read-only asset identity injection for deterministic tests. */
  workerIdentity?: (paths: string[]) => string;
  /** Requested backend/profile, including a selection that currently falls back to the same CPU tuple. */
  workerRuntimeIdentity?: () => string;
};

export type KokoroSettings = Pick<KokoroPaths, "voices" | "speed" | "toneVoice" | "toneWeight">;
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
  const worker = config.worker ? new NarrationWorker(config.worker) : undefined;
  const run: Runner = worker ? (cmd, args, input) => {
    if (cmd === "powershell.exe") return config.run(cmd, args, input);
    const value = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
    const wav = value("--out")!;
    const root = dirname(resolve(wav));
    const dynamic = new Set(["--voice", "--lang", "--speed", "--out", "--tone-voice", "--tone-weight"]);
    const launchArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (dynamic.has(args[i]!)) { i++; continue; }
      if (args[i] === "--plan-json") continue;
      launchArgs.push(args[i]!);
    }
    launchArgs.push("--output-root", root);
    const paths = [cmd, config.modelPath, config.voicesPath, config.script,
      ...relevantWorkerAssets(config.script), ...[value("--lid-manifest"), value("--lid-dir")].filter((p): p is string => !!p)];
    if (args.includes("--plan-json") && config.appHome && !value("--lid-dir")) {
      const torch = narrationPaths(config.appHome);
      paths.push(torch.model, torch.marker);
    }
    if (["pn-onnx-gpu-venv", "kokoro-gpu-venv"].includes(win32.basename(win32.dirname(win32.dirname(cmd))))) {
      const venv = win32.dirname(win32.dirname(cmd));
      for (const name of ["gpu-dependencies.json", "gpu-qualification.json", "lid-cuda-evidence.json", "kokoro-cuda-evidence.json"])
        paths.push(win32.join(venv, name));
    }
    // Readiness still runs in the existing runtime selectors on EVERY admission. No profile-only cache.
    const identity = JSON.stringify([cmd, launchArgs, config.workerRuntimeIdentity?.(),
      (config.workerIdentity ?? workerAssetIdentity)(paths)]);
    return worker.request({ command: cmd, args: launchArgs, identity }, {
      mode: args.includes("--plan-json") ? "plan" : "text", input: args.includes("--plan-json") ? JSON.parse(input!) : input,
      output: resolve(wav), voice: value("--voice")!, lang: value("--lang")!, speed: Number(value("--speed")),
      toneVoice: value("--tone-voice") ?? "", toneWeight: Number(value("--tone-weight") ?? 0),
    });
  } : config.run;
  const make = (plan: boolean) => wavEngine({
    run,
    tmpDir: config.tmpDir,
    unlink: config.unlink,
    commandFor: (language, wav) => {
      const live = config.settings?.() ?? config;
      const voice = live.voices[language];
      const speed = Number.isFinite(live.speed) && live.speed >= MIN_SPEED && live.speed <= MAX_SPEED ? live.speed : 1;
      const donor = live.toneVoice?.[language];
      const weight = live.toneWeight?.[language];
      // Python only interpolates planned synthesis. Direct text keeps the legacy argument list.
      const toneArgs = plan && donor && validToneVoice(donor) && validToneWeight(weight) && weight > 0
        ? ["--tone-voice", donor, "--tone-weight", String(weight)] : [];
      const runtime = plan ? config.narrationRuntime?.() : undefined;
      const python = plan ? runtime?.python ?? config.narrationPython?.() ?? config.python : config.directPython?.() ?? config.python;
      const managedGpu = ["pn-onnx-gpu-venv", "kokoro-gpu-venv"].includes(win32.basename(win32.dirname(win32.dirname(python))));
      return {
        cmd: python,
        args: [
          ...(managedGpu ? ["-I", "-B", "-X", "utf8", "-c", worker
            ? "import sys,runpy,pathlib,os;script=sys.argv[1];sys.argv=sys.argv[1:];sys.path.insert(0,str(pathlib.Path(script).parent));protocol=os.dup(1);os.dup2(2,1);import gpu_runtime_probe as p;p.prepare_worker();p.preload_for_worker(None);sys.stdout.flush();os.dup2(protocol,1);os.close(protocol);runpy.run_path(script,run_name='__main__')"
            : "import sys,runpy,pathlib;script=sys.argv[1];sys.argv=sys.argv[1:];sys.path.insert(0,str(pathlib.Path(script).parent));import gpu_runtime_probe as p;p.prepare_worker();p.preload_for_worker(None);runpy.run_path(script,run_name='__main__')"] : worker ? ["-B", "-X", "utf8"] : []),
          config.script,
          "--model", config.modelPath,
          "--voices", config.voicesPath,
          "--voice", voice,
          "--lang", kokoroLanguageCode(voice),
          "--speed", String(speed),
          "--out", wav,
          ...toneArgs,
          ...(plan ? ["--plan-json", ...(config.appHome ? ["--app-home", config.appHome] : []),
            "--lid-manifest", runtime?.lidManifest ?? config.lidManifest ?? LID_MANIFEST_PATH,
            ...(runtime?.backend === "onnx" && runtime.lidDirectory
              ? ["--lid-backend", "onnx", "--lid-dir", runtime.lidDirectory] : [])] : []),
        ],
      };
    },
  });
  const direct = make(false);
  const planned = make(true);
  // AudioCache already supplies exclusive UUID placeholders. The uncached CLI path needs a UUID
  // candidate too; wavEngine's legacy open-vox-* filename is intentionally not accepted by Python.
  const speak = (synthesize: (wav: string) => SpeechProcess): SpeechProcess => {
    const wav = join(config.tmpDir, `${randomUUID()}.wav`);
    let active: SpeechProcess | undefined, killed = false;
    let devices: ModelDevices | undefined;
    const exited = (async () => {
      try {
        active = synthesize(wav);
        const code = await active.exited;
        if (killed || code !== 0) return code || 1;
        devices = active.devices?.();
        const quote = wav.replace(/'/g, "''");
        active = config.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
          `(New-Object System.Media.SoundPlayer '${quote}').PlaySync()`]);
        return await active.exited;
      } finally { try { config.unlink(wav); } catch {} }
    })();
    return { exited, devices: () => !killed && devices ? { ...devices } : undefined,
      kill() { killed = true; devices = undefined; active?.kill(); } };
  };
  const engine: Engine = worker ? Object.assign((text: string, language: Language) =>
    speak(wav => direct.synthesize!(text, language, wav)), { synthesize: direct.synthesize }) : direct;
  engine.synthesizePlan = (plan, wav) => planned.synthesize!(JSON.stringify(plan), plan.defaultLanguage, wav);
  engine.speakPlan = (plan) => worker ? speak(wav => engine.synthesizePlan!(plan, wav)) : planned(JSON.stringify(plan), plan.defaultLanguage);
  if (worker) { engine.release = () => worker.release(); engine.dispose = () => worker.dispose();
    engine.workerSnapshot = () => worker.snapshot(); }
  return engine;
}

function relevantWorkerAssets(script: string): string[] {
  try { return readdirSync(dirname(script)).filter(name => name.endsWith(".py")).map(name => join(dirname(script), name)); }
  catch { return []; }
}

/** Lightweight stamps, not a replacement for GPU qualification or Python's pinned LID verification. */
function workerAssetIdentity(paths: string[]): string {
  const stamps: unknown[] = [];
  const visit = (path: string) => {
    if (stamps.length > 4096) throw Error("Too many narration assets");
    let s: ReturnType<typeof statSync>;
    try { s = statSync(path); } catch { stamps.push([path, "unavailable"]); return; }
    stamps.push([path, s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]);
    if (s.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  paths.forEach(visit);
  return JSON.stringify(stamps);
}

/** Local inference only. Bound and validate helper diagnostics; never forward third-party stderr/prose. */
export function narrationRunner(onDiagnostic: (code: string) => void = () => {}): Runner {
  return (cmd, args, stdin) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: {
      ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1",
      HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1",
      HF_HUB_DISABLE_PROGRESS_BARS: "1", DO_NOT_TRACK: "1",
      HF_HUB_DISABLE_IMPLICIT_TOKEN: "1", HF_TOKEN: "", HUGGING_FACE_HUB_TOKEN: "", PYTHONNOUSERSITE: "1",
    } });
    let output = "", oversized = false;
    let devices: ModelDevices | undefined, killed = false;
    child.stdout.on("data", (data: Buffer) => {
      if (output.length + data.length > 8192) oversized = true;
      if (!oversized) output += data.toString("utf8");
    });
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => {
        if (code === 0 && !killed && (args.includes("--plan-json") || output.trim() || oversized)) {
          try {
            const value = JSON.parse(output);
            if (oversized || Object.keys(value).join() !== "diagnostics" || !Array.isArray(value.diagnostics)
                || value.diagnostics.length > 32 || !value.diagnostics.every((c: unknown) =>
                  typeof c === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(c))) throw new Error();
            devices = {};
            for (const model of ["lid", "kokoro"] as const) {
              if (model === "lid" && !args.includes("--plan-json")) continue;
              const codes = value.diagnostics.filter((c: string) =>
                (model === "lid" ? /^lid-(onnx-provider|torch-device)-(cpu|cuda)$/ : /^kokoro-onnx-provider-(cpu|cuda)$/).test(c));
              const selected = new Set<string>(codes.map((c: string) => c.endsWith("-cuda") ? "gpu" : "cpu"));
              if (selected.size === 1 && new Set(codes).size === 1) devices[model] = selected.has("gpu") ? "gpu" : "cpu";
            }
            for (const c of value.diagnostics) { try { onDiagnostic(c); } catch {} }
          } catch { resolve(2); return; }
        }
        resolve(code ?? 1);
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "", "utf8");
    return { exited, devices: () => !killed && devices ? { ...devices } : undefined,
      kill: () => { killed = true; devices = undefined; child.kill(); } };
  };
}

export function defaultKokoroEngine(
  env: Record<string, string | undefined> = process.env,
  getConfig: () => import("./config").Config = createConfigReader(),
  onDiagnostic?: (code: string) => void,
  inspection: { idleMs?: number } = {},
): Engine | undefined {
  const root = homeFor(env);
  const paths = resolveKokoro(root, env);
  if (!paths) return undefined;
  const script = fileURLToPath(new URL("../scripts/narration_worker.py", import.meta.url));
  if (!existsSync(script)) return undefined;
  return kokoroEngine({
    ...paths, script, appHome: root, worker: { onDiagnostic, idleMs: inspection.idleMs },
    workerRuntimeIdentity: () => { const current = getConfig(); return JSON.stringify([current.narrationBackend, current.runtimeProfile]); },
    // One tuple per plan call: interpreter, manifest and model directory always match the backend.
    narrationRuntime: createNarrationRuntimeSource({
      root, backend: () => getConfig().narrationBackend, profile: () => getConfig().runtimeProfile,
      fallbackPython: paths.python, onDiagnostic,
    }),
    directPython: () => {
      const config = getConfig();
      if (config.narrationBackend !== "onnx") {
        if (config.runtimeProfile === "cuda13") { try { onDiagnostic?.("gpu-profile-requires-onnx"); } catch {} }
        return undefined;
      }
      const selected = selectGpuPython(root, "kokoro", config.runtimeProfile);
      if (config.runtimeProfile === "cuda13" && !selected) { try { onDiagnostic?.("gpu-profile-unavailable"); } catch {} }
      return selected;
    },
    // Environment variables stay as explicit overrides on top of the shared config file.
    settings: () => {
      const config = getConfig();
      return {
        voices: {
          es: envValue(env, "KOKORO_VOICE_ES") || config.voices.es,
          en: envValue(env, "KOKORO_VOICE_EN") || config.voices.en,
        },
        speed: Number.isFinite(Number(envValue(env, "SPEED"))) && envValue(env, "SPEED") ? Number(envValue(env, "SPEED")) : config.speed,
        toneVoice: config.toneVoice,
        toneWeight: config.toneWeight,
      };
    },
    run: narrationRunner(onDiagnostic),
    tmpDir: tmpdir(),
    unlink: (file) => { try { unlinkSync(file); } catch {} },
  });
}
