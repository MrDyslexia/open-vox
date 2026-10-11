import { spawn as nodeSpawn } from "node:child_process";
import type { Selection } from "./final-response";
import { detectLanguage, prepareSpeech, type Language } from "./speech-text";
import type { AudioStore } from "./audio-cache";
import type { AudioStatus } from "./repeat-control";

export type SpeechProcess = { exited: Promise<number>; kill(): void };
export type Spawn = (args: string[], stdin: string) => SpeechProcess;
export type Engine = ((text: string, language: Language) => SpeechProcess) & {
  synthesize?: (text: string, language: Language, wav: string) => SpeechProcess;
};
export type SpeechSink = ((selection: Selection) => Promise<void>) & {
  stop(): void;
  repeat?: (sessionID: string, revision: number, expires?: number) => Promise<void>;
  status?: () => AudioStatus | undefined;
  removeSession?: (sessionID: string) => void;
  dispose?: () => Promise<void>;
};
export type SpeechSinkOptions = {
  /** Preferred: a full engine (e.g. Piper). Takes precedence over `spawn`. */
  engine?: Engine;
  /** Windows SAPI fallback, driven through PowerShell. */
  spawn?: Spawn;
  enabled?: boolean;
  maxPending?: number;
  timeoutMs?: number;
  /**
   * Backstop for the cached-audio player alone. Defaults to `timeoutMs`. A persistent player watches its own
   * playback by duration, so the live wiring raises this to a generous safety net instead of a fixed 120 s.
   */
  playbackTimeoutMs?: number;
  maxLength?: number;
  onError?: (error: unknown) => void;
  cache?: AudioStore;
  player?: (wav: string) => SpeechProcess;
  isPaused?: () => boolean;
  now?: () => number;
};

// Text arrives on stdin (UTF-8) so it is never parsed as PowerShell code.
// The language is one of two fixed literals chosen by detectLanguage.
function script(language: Language, wav?: string): string {
  return [
    "$ErrorActionPreference='Stop'",
    "[Console]::InputEncoding=[System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Speech",
    `$lang='${language}'`,
    "$text=[Console]::In.ReadToEnd()",
    "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "try{",
    "$v=$s.GetInstalledVoices()|Where-Object{$_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $lang}|Select-Object -First 1",
    "if($v){$s.SelectVoice($v.VoiceInfo.Name)}",
    ...(wav ? [`$s.SetOutputToWaveFile('${quotePath(wav)}')`] : []),
    "$s.Speak($text)",
    "}finally{$s.Dispose()}",
  ].join(";");
}

export const windowsSpawn: Spawn = (args, stdin) => {
  const child = nodeSpawn("powershell.exe", args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(stdin, "utf8");
  return { exited, kill: () => { child.kill(); } };
};

/** Windows SAPI through PowerShell; the last-resort engine. */
export function sapiEngine(spawn: Spawn = windowsSpawn): Engine {
  const engine: Engine = (text, language) => spawn(["-NoProfile", "-NonInteractive", "-Command", script(language)], text);
  engine.synthesize = (text, language, wav) => spawn(["-NoProfile", "-NonInteractive", "-Command", script(language, wav)], text);
  return engine;
}

const quotePath = (value: string) => value.replace(/'/g, "''");
export function playWav(wav: string, spawn: Spawn = windowsSpawn): SpeechProcess {
  const script = `$ErrorActionPreference='Stop';$p=New-Object System.Media.SoundPlayer '${quotePath(wav)}';try{$p.PlaySync()}finally{$p.Dispose()}`;
  return spawn(["-NoProfile", "-NonInteractive", "-Command", script], "");
}

type Job = { sessionID: string; text?: string; language?: Language; revision?: number; expires?: number; done: () => void };

export function createSpeechSink(options: SpeechSinkOptions = {}): SpeechSink {
  const spawn = options.spawn ?? windowsSpawn;
  const engine: Engine = options.engine ?? sapiEngine(spawn);
  const maxPending = options.maxPending ?? 2;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const report = (error: unknown) => { try { options.onError?.(error); } catch {} };
  const queue: Job[] = [];
  let current: SpeechProcess | undefined;
  let running = false;
  let generation = 0;
  let disposed = false;
  let activeSession: string | undefined;
  let idle = Promise.resolve();
  const cache = options.cache;
  const paused = () => options.isPaused?.() ?? false;
  const now = options.now ?? Date.now;

  async function run(proc: SpeechProcess, limitMs = timeoutMs): Promise<number> {
    current = proc;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, limitMs);
    try {
      const code = await proc.exited;
      if (timedOut) throw new Error("speech process timed out");
      return code;
    } finally { clearTimeout(timer); current = undefined; }
  }

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift()!;
        const mine = generation;
        let candidate: string | undefined;
        let release: (() => void) | undefined;
        activeSession = job.sessionID;
        const valid = () => !disposed && mine === generation && !paused() && (job.expires === undefined || job.expires > now());
        try {
          if (!valid()) continue;
          if (cache) {
            if (job.text !== undefined) {
              if (!engine.synthesize) throw new Error("Engine cannot produce cached audio");
              candidate = cache.candidate();
              release = cache.hold(candidate);
              const code = await run(engine.synthesize(job.text, job.language!, candidate));
              if (code !== 0) throw new Error(`synthesis process exited with code ${code}`);
              if (!valid()) continue;
              if (!cache.promote(candidate, job.sessionID)) throw new Error("Invalid generated audio");
              candidate = undefined;
              release(); release = undefined;
            }
            const audio = cache.current();
            if (!valid() || !audio || audio.sessionID !== job.sessionID ||
                (job.revision !== undefined && audio.revision !== job.revision)) continue;
            release = cache.hold(audio.file);
            const code = await run((options.player ?? playWav)(audio.file), options.playbackTimeoutMs ?? timeoutMs);
            if (code !== 0 && valid()) report(new Error(`player exited with code ${code}`));
          } else if (job.text !== undefined) {
            const code = await run(engine(job.text, job.language!));
            if (code !== 0 && valid()) report(new Error(`speech process exited with code ${code}`));
          }
        } catch (error) {
          if (mine === generation) report(error);
        } finally {
          if (candidate) cache?.discard(candidate);
          release?.();
          activeSession = undefined;
          job.done();
        }
      }
    } finally {
      running = false;
    }
  }

  const sink = ((selection: Selection) => {
    if (disposed || options.enabled === false || paused()) return Promise.resolve();
    const text = prepareSpeech(selection.text, options.maxLength);
    if (!text) return Promise.resolve();
    return new Promise<void>((resolve) => {
      while (queue.length >= maxPending) queue.shift()!.done();
      queue.push({ sessionID: selection.sessionID, text, language: detectLanguage(text), done: resolve });
      if (!running) idle = pump();
    });
  }) as SpeechSink;

  sink.stop = () => {
    generation++;
    while (queue.length > 0) queue.shift()!.done();
    try { current?.kill(); } catch {}
  };
  sink.status = () => {
    const audio = cache?.current();
    return !disposed && options.enabled !== false && audio ? { sessionID: audio.sessionID, revision: audio.revision } : undefined;
  };
  sink.repeat = (sessionID, revision, expires) => {
    const audio = sink.status?.();
    if (disposed || paused() || (expires !== undefined && expires <= now()) || !audio || audio.sessionID !== sessionID || audio.revision !== revision) return Promise.resolve();
    sink.stop();
    return new Promise<void>((resolve) => {
      queue.push({ sessionID, revision, expires, done: resolve });
      if (!running) idle = pump();
    });
  };
  sink.removeSession = (sessionID) => {
    if (activeSession === sessionID) sink.stop();
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.sessionID === sessionID) queue.splice(i, 1)[0]!.done();
    cache?.forget(sessionID);
  };
  sink.dispose = async () => {
    disposed = true;
    sink.stop();
    cache?.dispose();
    await idle;
    cache?.dispose();
  };
  return sink;
}
