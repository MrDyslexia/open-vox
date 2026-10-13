import { spawn as nodeSpawn } from "node:child_process";
import type { Selection } from "./final-response";
import { type Language } from "./speech-text";
import { createNarrationPlan } from "./markdown-narration";
import { defaultNarrationPolicies, flattenNarrationPlan, type NarrationPlan } from "./narration-plan";
import type { AudioStore } from "./audio-cache";
import type { AudioStatus } from "./repeat-control";

export type SpeechProcess = {
  exited: Promise<number>;
  kill(): void;
  /**
   * Optional capability of a controllable playback. Resolves true once the audio is frozen in place (same
   * file, same position, `exited` still pending). Resolves false when this playback cannot be paused (for
   * example the one-shot SoundPlayer fallback) or the freeze failed; the caller then stops it with `kill()`.
   * A handle without these methods keeps the original contract and is treated as not pausable.
   */
  pause?(): Promise<boolean>;
  /** Continues a playback frozen by `pause()`. Resolves false when it could not be continued. */
  resume?(): Promise<boolean>;
};
export type Spawn = (args: string[], stdin: string) => SpeechProcess;
export type Engine = ((text: string, language: Language) => SpeechProcess) & {
  synthesize?: (text: string, language: Language, wav: string) => SpeechProcess;
  synthesizePlan?: (plan: NarrationPlan, wav: string) => SpeechProcess;
  speakPlan?: (plan: NarrationPlan) => SpeechProcess;
};
export type SpeechSink = ((selection: Selection) => Promise<void>) & {
  stop(): void;
  /**
   * Cancels narration that belongs to one session: its queued jobs and, only when it is the active job, the
   * current synthesis or playback. Other sessions keep their place and the cache is not forgotten.
   */
  stopSession?: (sessionID: string) => void;
  /**
   * Freezes the active cached playback in place (real pause) and cancels everything that has no audio yet:
   * queued jobs and a synthesis in flight. A playback that cannot be frozen is stopped instead.
   */
  pause?: () => void;
  /** Continues a playback frozen by `pause()`; a harmless no-op when nothing is paused. */
  resume?: () => void;
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
  /** Time a playback handle gets to acknowledge `pause()`/`resume()` before it is stopped instead. */
  pauseTimeoutMs?: number;
  maxLength?: number;
  narrationLanguage?: Language | (() => Language);
  preparePlan?: (...args: Parameters<typeof createNarrationPlan>) => NarrationPlan | Promise<NarrationPlan>;
  onDiagnostic?: (code: string) => void;
  onError?: (error: unknown) => void;
  cache?: AudioStore;
  player?: (wav: string) => SpeechProcess;
  isPaused?: () => boolean;
  isEnabled?: () => boolean;
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

type Job = { sessionID: string; plan?: NarrationPlan; revision?: number; expires?: number; done: () => void };

/** The process the pump is waiting on, with its backstop timer under the sink's control. */
type Active = { proc: SpeechProcess; audible: boolean; arm(): void; disarm(): void };
/** A cached playback that was asked to pause. It stays the owner of its audio until it ends or is stopped. */
type Frozen = {
  active: Active;
  /** The host acknowledged the freeze and the audio has not been continued since. */
  paused: boolean;
  /** Latest requested direction; the backstop is only re-armed when no further pause is pending. */
  want: boolean;
  /** Serializes pause/resume requests so they reach the handle in the order they were made. */
  ops: Promise<void>;
  /** Cancels the acknowledgement wait in flight (used when the playback is stopped meanwhile). */
  abort?: () => void;
};
type Ack = "ok" | "declined" | "failed" | "aborted";

export function createSpeechSink(options: SpeechSinkOptions = {}): SpeechSink {
  const spawn = options.spawn ?? windowsSpawn;
  const engine: Engine = options.engine ?? sapiEngine(spawn);
  const maxPending = options.maxPending ?? 2;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pauseTimeoutMs = options.pauseTimeoutMs ?? 3_000;
  const report = (error: unknown) => { try { options.onError?.(error); } catch {} };
  const diagnostic = (code: string) => { try { options.onDiagnostic?.(code); } catch {} };
  let reducedReported = false;
  const reduced = () => { if (!reducedReported) { reducedReported = true; diagnostic("reduced-pronunciation:text-only-engine"); } };
  const queue: Job[] = [];
  let current: Active | undefined;
  let frozen: Frozen | undefined;
  let running = false;
  let generation = 0;
  let disposed = false;
  let activeSession: string | undefined;
  let idle = Promise.resolve();
  const cache = options.cache;
  const paused = () => options.isPaused?.() ?? false;
  // Observing Off permanently invalidates pending work; On never revives that generation.
  const enabled = () => {
    const on = options.enabled !== false && (options.isEnabled?.() ?? true);
    if (!on) sink.stop();
    return on;
  };
  const now = options.now ?? Date.now;

  /** `audible` marks the cached-audio playback, the only process that can be frozen instead of stopped. */
  async function run(proc: SpeechProcess, limitMs = timeoutMs, audible = false): Promise<number> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disarm = () => { if (timer) clearTimeout(timer); timer = undefined; };
    const arm = () => {
      disarm();
      timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, limitMs);
    };
    const active: Active = { proc, audible, arm, disarm };
    current = active;
    arm();
    // A predicate has no notification channel. Observe it even while playback is frozen.
    const gate = options.isEnabled ? setInterval(() => {
      try { enabled(); } catch (error) { report(error); sink.stop(); }
    }, 20) : undefined;
    try {
      const code = await proc.exited;
      if (timedOut) throw new Error("speech process timed out");
      return code;
    } finally {
      if (gate) clearInterval(gate);
      disarm();
      if (frozen?.active === active) { frozen.abort?.(); frozen = undefined; }
      current = undefined;
    }
  }

  /** Waits for a pause/resume acknowledgement without ever hanging: a silent or throwing handle is "failed". */
  function acknowledge(f: Frozen, call: () => Promise<boolean>): Promise<Ack> {
    return new Promise<Ack>((resolve) => {
      let finished = false;
      const end = (value: Ack) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (f.abort === abort) f.abort = undefined;
        resolve(value);
      };
      const abort = () => end("aborted");
      const timer = setTimeout(() => end("failed"), pauseTimeoutMs);
      f.abort = abort;
      let result: Promise<boolean>;
      try { result = call(); } catch { end("failed"); return; }
      result.then((ok) => end(ok === true ? "ok" : "declined"), () => end("failed"));
    });
  }

  /** A playback that cannot be frozen or continued is stopped: never hang the queue or hold the file. */
  function degrade(f: Frozen, reason?: string): void {
    if (frozen === f) frozen = undefined;
    generation++;                      // this playback is cancelled, so its late exit is not a player failure
    if (reason) report(new Error(reason));
    try { f.active.proc.kill(); } catch {}
  }

  async function freeze(f: Frozen): Promise<void> {
    if (!enabled() || frozen !== f || f.paused) return;
    f.active.disarm();                 // a frozen playback is not bounded by the backstop
    const result = await acknowledge(f, () => f.active.proc.pause!());
    if (!enabled() || frozen !== f) return;
    if (result === "ok") { f.paused = true; return; }
    // "declined" is the normal answer of a playback that cannot pause (e.g. fallback), so it is not an error.
    degrade(f, result === "failed" ? "player did not acknowledge pause; playback stopped" : undefined);
  }

  async function thaw(f: Frozen): Promise<void> {
    if (!enabled() || frozen !== f || !f.paused) return;
    const result = await acknowledge(f, () => f.active.proc.resume!());
    if (!enabled() || frozen !== f) return;
    if (result !== "ok") { degrade(f, "player did not acknowledge resume; playback stopped"); return; }
    f.paused = false;
    if (!f.want) f.active.arm();       // fresh budget: the time spent paused is not counted
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
        const valid = () => enabled() && !disposed && mine === generation && !paused() && (job.expires === undefined || job.expires > now());
        try {
          if (!valid()) continue;
          if (cache) {
            if (job.plan !== undefined) {
              if (!engine.synthesizePlan && !engine.synthesize) throw new Error("Engine cannot produce cached audio");
              candidate = cache.candidate();
              release = cache.hold(candidate);
              if (!engine.synthesizePlan) reduced();
              if (!valid()) continue;
              const proc = engine.synthesizePlan ? engine.synthesizePlan(job.plan, candidate)
                : engine.synthesize!(flattenNarrationPlan(job.plan), job.plan.defaultLanguage, candidate);
              const code = await run(proc);
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
            const code = await run((options.player ?? playWav)(audio.file), options.playbackTimeoutMs ?? timeoutMs, true);
            if (code !== 0 && valid()) report(new Error(`player exited with code ${code}`));
          } else if (job.plan !== undefined) {
            if (!engine.speakPlan) reduced();
            if (!valid()) continue;
            const code = await run(engine.speakPlan ? engine.speakPlan(job.plan)
              : engine(flattenNarrationPlan(job.plan), job.plan.defaultLanguage));
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

  const sink = (async (selection: Selection) => {
    if (disposed || !enabled() || paused()) return;
    const mine = generation;
    let plan: NarrationPlan;
    try {
      const language = typeof options.narrationLanguage === "function" ? options.narrationLanguage() : options.narrationLanguage ?? "es";
      const policy = options.maxLength === undefined ? defaultNarrationPolicies : {
        ...defaultNarrationPolicies, maxNarrationLength: Math.min(4000, options.maxLength),
      };
      const prepared = (options.preparePlan ?? createNarrationPlan)(selection.text, language, policy);
      plan = prepared instanceof Promise ? await prepared : prepared;
      if (disposed || !enabled() || mine !== generation || paused()) return;
      if (plan.outcome !== "complete") diagnostic(`narration-limit:${plan.outcome}`);
      if (plan.outcome === "unsplittable") throw new Error("Narration contains an unsplittable technical unit");
    } catch (error) { report(error); return Promise.resolve(); }
    // Preparation callbacks/diagnostics may invalidate this selection synchronously.
    if (disposed || !enabled() || mine !== generation || paused() || !flattenNarrationPlan(plan)) return;
    return new Promise<void>((resolve) => {
      while (queue.length >= maxPending) queue.shift()!.done();
      queue.push({ sessionID: selection.sessionID, plan, done: resolve });
      if (!running) idle = pump();
    });
  }) as SpeechSink;

  /** Cancels the active job. A stopped playback is discarded even when frozen: it is never resumed, and
   *  killing it lets the pump close the file and release the cache hold. */
  const cancelActive = () => {
    generation++;
    const f = frozen;
    frozen = undefined;
    f?.abort?.();
    try { current?.proc.kill(); } catch {}
  };
  sink.stop = () => {
    while (queue.length > 0) queue.shift()!.done();
    cancelActive();
  };
  // Jobs read the generation when they start, so queued jobs of other sessions are not invalidated by the bump.
  sink.stopSession = (sessionID) => {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.sessionID === sessionID) queue.splice(i, 1)[0]!.done();
    if (activeSession === sessionID) cancelActive();
  };
  /**
   * Real pause. What can be held is held: the active cached playback keeps its place, its job and its cache
   * hold. What has no audio yet cannot be held and is cancelled: queued jobs are dropped and a synthesis in
   * flight is killed (generation bump, as in stop()). A playback that cannot pause (SoundPlayer fallback,
   * a handle without pause support) is stopped instead, and resume() then has nothing to do.
   */
  sink.pause = () => {
    if (!enabled()) return;
    while (queue.length > 0) queue.shift()!.done();
    const active = current;
    if (disposed || !active) return;
    if (!active.audible || !active.proc.pause || !active.proc.resume) { sink.stop(); return; }
    let f = frozen?.active === active ? frozen : undefined;
    if (!f) { f = { active, paused: false, want: true, ops: Promise.resolve() }; frozen = f; }
    f.want = true;
    active.disarm();
    const target = f;
    target.ops = target.ops.then(() => freeze(target)).catch(() => {});   // one failed step must not wedge the chain
  };
  sink.resume = () => {
    if (!enabled()) return;
    const f = frozen;
    if (!f) return;
    f.want = false;
    f.ops = f.ops.then(() => thaw(f)).catch(() => {});
  };
  sink.status = () => {
    if (!enabled()) return;
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
