import { spawn as nodeSpawn } from "node:child_process";
import type { Selection } from "./final-response";
import { detectLanguage, prepareSpeech, type Language } from "./speech-text";

export type SpeechProcess = { exited: Promise<number>; kill(): void };
export type Spawn = (args: string[], stdin: string) => SpeechProcess;
export type Engine = (text: string, language: Language) => SpeechProcess;
export type SpeechSink = ((selection: Selection) => Promise<void>) & { stop(): void };
export type SpeechSinkOptions = {
  /** Preferred: a full engine (e.g. Piper). Takes precedence over `spawn`. */
  engine?: Engine;
  /** Windows SAPI fallback, driven through PowerShell. */
  spawn?: Spawn;
  enabled?: boolean;
  maxPending?: number;
  timeoutMs?: number;
  maxLength?: number;
  onError?: (error: unknown) => void;
};

// Text arrives on stdin (UTF-8) so it is never parsed as PowerShell code.
// The language is one of two fixed literals chosen by detectLanguage.
function script(language: Language): string {
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
  return (text, language) => spawn(["-NoProfile", "-NonInteractive", "-Command", script(language)], text);
}

type Job = { text: string; language: Language; done: () => void };

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

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift()!;
        const mine = generation;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const proc = engine(job.text, job.language);
          current = proc;
          timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
          const code = await proc.exited;
          if (code !== 0 && mine === generation) report(new Error(`speech process exited with code ${code}`));
        } catch (error) {
          report(error);
        } finally {
          if (timer) clearTimeout(timer);
          current = undefined;
          job.done();
        }
      }
    } finally {
      running = false;
    }
  }

  const sink = ((selection: Selection) => {
    if (options.enabled === false) return Promise.resolve();
    const text = prepareSpeech(selection.text, options.maxLength);
    if (!text) return Promise.resolve();
    return new Promise<void>((resolve) => {
      while (queue.length >= maxPending) queue.shift()!.done();
      queue.push({ text, language: detectLanguage(text), done: resolve });
      void pump();
    });
  }) as SpeechSink;

  sink.stop = () => {
    generation++;
    while (queue.length > 0) queue.shift()!.done();
    try { current?.kill(); } catch {}
  };
  return sink;
}
