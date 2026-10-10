import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import type { Engine, SpeechProcess } from "./speech-sink";
import type { Language } from "./speech-text";

export type Runner = (cmd: string, args: string[], stdin?: string) => SpeechProcess;
export type PiperPaths = { exe: string; models: Record<Language, string> };
export type PiperConfig = PiperPaths & {
  run: Runner;
  tmpDir: string;
  unlink: (file: string) => void;
};

export const DEFAULT_VOICES: Record<Language, string> = { es: "es_MX-claude-high", en: "en_US-lessac-high" };

export const windowsRunner: Runner = (cmd, args, stdin) => {
  const child = nodeSpawn(cmd, args, { stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "ignore"], windowsHide: true });
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (stdin !== undefined && child.stdin) {
    child.stdin.on("error", () => {});
    child.stdin.end(stdin, "utf8");
  }
  return { exited, kill: () => { child.kill(); } };
};

/** Locates Piper and both voice models under `root`; undefined when anything is missing. */
export function resolvePiper(
  root: string,
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): PiperPaths | undefined {
  const exe = win32.join(root, "piper", "piper.exe");
  const model = (language: Language, override: string | undefined) =>
    win32.join(root, "voices", `${override?.trim() || DEFAULT_VOICES[language]}.onnx`);
  const models = { es: model("es", env.AGENTVOZ_VOICE_ES), en: model("en", env.AGENTVOZ_VOICE_EN) };
  return [exe, models.es, models.en].every((path) => exists(path)) ? { exe, models } : undefined;
}

const quote = (value: string) => value.replace(/'/g, "''");
let counter = 0;

/** Synthesizes a WAV with Piper (text on stdin), then plays it. Killable at either step. */
export function piperEngine(config: PiperConfig): Engine {
  return (text, language) => {
    const wav = win32.join(config.tmpDir, `agentvoz-${process.pid}-${Date.now()}-${counter++}.wav`);
    let killed = false;
    let active: SpeechProcess | undefined;
    const exited = (async () => {
      try {
        active = config.run(config.exe, ["-m", config.models[language], "-f", wav, "-q"], text);
        const code = await active.exited;
        if (killed) return 1;
        if (code !== 0) return code;
        const play = `(New-Object System.Media.SoundPlayer '${quote(wav)}').PlaySync()`;
        active = config.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", play]);
        return await active.exited;
      } finally {
        try { config.unlink(wav); } catch {}
      }
    })();
    return { exited, kill: () => { killed = true; try { active?.kill(); } catch {} } };
  };
}

export function defaultPiperEngine(env: Record<string, string | undefined> = process.env): Engine | undefined {
  const root = env.AGENTVOZ_HOME?.trim() || win32.join(env.LOCALAPPDATA ?? "", "agentVoz");
  const paths = resolvePiper(root, env);
  if (!paths) return undefined;
  return piperEngine({
    ...paths,
    run: windowsRunner,
    tmpDir: tmpdir(),
    unlink: (file) => { try { unlinkSync(file); } catch {} },
  });
}
