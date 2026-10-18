import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { envValue, homeFor } from "./brand";
import type { Engine, SpeechProcess } from "./speech-sink";
import type { Language } from "./speech-text";
import { modelDevices, type ModelDevices } from "./repeat-control";

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
  const models = { es: model("es", envValue(env, "VOICE_ES")), en: model("en", envValue(env, "VOICE_EN")) };
  return [exe, models.es, models.en].every((path) => exists(path)) ? { exe, models } : undefined;
}

const quote = (value: string) => value.replace(/'/g, "''");
let counter = 0;

export type WavConfig = {
  /** Builds the synthesis command; the text is delivered on stdin. */
  commandFor: (language: Language, wav: string) => { cmd: string; args: string[] };
  run: Runner;
  tmpDir: string;
  unlink: (file: string) => void;
};

/** Synthesizes a WAV (text on stdin), then plays it. Killable at either step. */
export function wavEngine(config: WavConfig): Engine {
  const engine: Engine = (text, language) => {
    const wav = win32.join(config.tmpDir, `open-vox-${process.pid}-${Date.now()}-${counter++}.wav`);
    let killed = false;
    let active: SpeechProcess | undefined;
    let devices: ModelDevices | undefined;
    const exited = (async () => {
      try {
        const command = config.commandFor(language, wav);
        active = config.run(command.cmd, command.args, text);
        const code = await active.exited;
        if (killed) return 1;
        if (code !== 0) return code;
        devices = active.devices ? modelDevices(active.devices()) : undefined;
        if (killed) return 1;
        const play = `(New-Object System.Media.SoundPlayer '${quote(wav)}').PlaySync()`;
        active = config.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", play]);
        return await active.exited;
      } finally {
        try { config.unlink(wav); } catch {}
      }
    })();
    return { exited, devices: () => !killed && devices ? { ...devices } : undefined,
      kill: () => { killed = true; devices = undefined; try { active?.kill(); } catch {} } };
  };
  engine.synthesize = (text, language, wav) => {
    const command = config.commandFor(language, wav);
    return config.run(command.cmd, command.args, text);
  };
  return engine;
}

export function piperEngine(config: PiperConfig): Engine {
  return wavEngine({
    run: config.run,
    tmpDir: config.tmpDir,
    unlink: config.unlink,
    commandFor: (language, wav) => ({ cmd: config.exe, args: ["-m", config.models[language], "-f", wav, "-q"] }),
  });
}

export function defaultPiperEngine(env: Record<string, string | undefined> = process.env): Engine | undefined {
  const root = homeFor(env);
  const paths = resolvePiper(root, env);
  if (!paths) return undefined;
  return piperEngine({
    ...paths,
    run: windowsRunner,
    tmpDir: tmpdir(),
    unlink: (file) => { try { unlinkSync(file); } catch {} },
  });
}
