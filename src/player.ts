import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { playWav, type SpeechProcess } from "./speech-sink";

/**
 * Persistent, controllable audio player.
 *
 * One long-lived `powershell.exe -STA` child (scripts/player.ps1, WPF MediaPlayer) is driven through a
 * line protocol. `play()` keeps the `SpeechProcess` contract the speech sink already uses, so a playback
 * is just another killable process. Any problem with the host degrades to the old SoundPlayer spawn for
 * that playback: audio failures must never block OpenCode or the written reply.
 */

// --- Wire protocol ---------------------------------------------------------------------------------

export type PlayerRequest =
  | { cmd: "play"; path: string }
  | { cmd: "rate"; value: number }
  | { cmd: "pause" | "resume" | "stop" | "status" | "quit" };

export type PlayerEvent =
  | { event: "ready" }
  | { event: "opened"; durationMs: number }
  | { event: "playing" }
  | { event: "paused"; positionMs: number }
  | { event: "rate"; value: number }
  | { event: "position"; ms: number; durationMs: number; state: string; rate: number }
  | { event: "ended" }
  | { event: "stopped" }
  | { event: "error"; message: string }
  | { event: "bye"; reason: string };

export const MIN_RATE = 0.25;
export const MAX_RATE = 8;
const lineBreak = /[\r\n]/;

/** One request is exactly one line; a path containing a line break could smuggle a second command. */
export function encodeRequest(request: PlayerRequest): string {
  if (request.cmd === "play") {
    if (lineBreak.test(request.path)) throw new Error("Player path must be a single line");
    return `play ${request.path}`;
  }
  if (request.cmd === "rate") {
    if (!Number.isFinite(request.value)) throw new Error("Player rate must be finite");
    return `rate ${request.value}`;
  }
  return request.cmd;
}

const number = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Parses one host stdout line. Anything that is not a known event object is ignored (returns undefined). */
export function decodeEvent(line: string): PlayerEvent | undefined {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return undefined; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  switch (e.event) {
    case "ready": case "playing": case "ended": case "stopped":
      return { event: e.event };
    case "opened": return { event: "opened", durationMs: number(e.durationMs, -1) };
    case "paused": return { event: "paused", positionMs: number(e.positionMs, 0) };
    case "rate": return { event: "rate", value: number(e.value, 1) };
    case "position":
      return { event: "position", ms: number(e.ms, 0), durationMs: number(e.durationMs, -1), state: text(e.state), rate: number(e.rate, 1) };
    case "error": return { event: "error", message: text(e.message) };
    case "bye": return { event: "bye", reason: text(e.reason) };
    default: return undefined;
  }
}

// --- Host process ----------------------------------------------------------------------------------

export type HostProcess = {
  send(line: string): void;
  kill(): void;
  exited: Promise<number>;
  /** Registers the single listener for complete stdout lines. */
  onLine(listener: (line: string) => void): void;
};
export type HostSpawn = () => HostProcess;

/** Same lookup as scripts/kokoro_say.py: relative to this module, so it works from the checkout the plugin loads from. */
export const playerScriptPath = () => fileURLToPath(new URL("../scripts/player.ps1", import.meta.url));

export function defaultHostSpawn(env: Record<string, string | undefined> = process.env, script = playerScriptPath()): HostSpawn {
  return () => {
    if (!existsSync(script)) throw new Error("player script missing");
    const child = nodeSpawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script], {
      stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env: env as NodeJS.ProcessEnv,
    });
    const exited = new Promise<number>((resolve) => {
      child.once("error", () => resolve(1));
      child.once("close", (code) => resolve(code ?? 1));
    });
    child.stdin.on("error", () => {});
    return {
      exited,
      send: (line) => { child.stdin.write(`${line}\n`, "utf8"); },
      kill: () => { child.kill(); },
      onLine: (listener) => {
        let buffer = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          let at: number;
          while ((at = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, at).trim();
            buffer = buffer.slice(at + 1);
            if (line) listener(line);
          }
        });
      },
    };
  };
}

// --- Player ----------------------------------------------------------------------------------------

export type PlayerPosition = { positionMs: number; durationMs: number; state: string; rate: number };

export interface Player {
  /**
   * Plays one WAV. `exited` settles when playback ends (0), is stopped or fails (non-zero); `kill()` stops it.
   * The handle also carries `pause()`/`resume()` for this playback only: they resolve true when the persistent
   * host froze/continued it, and false when it cannot (SoundPlayer fallback, already over or stopped) or the host
   * did not answer within `requestTimeoutMs`. A pause that arrives before the file is open waits for it to open. An unanswered request or a host that dies while paused ends
   * the playback (`exited` settles non-zero) instead of replaying it, so a failed pause degrades to stop.
   */
  play(path: string): SpeechProcess;
  /** Pauses and resolves with the position in ms, or undefined when no host is running. */
  pause(): Promise<number | undefined>;
  resume(): Promise<boolean>;
  /** Sets the playback rate (clamped to 0.25-8); applies live and to later playbacks. Resolves with the applied rate. */
  setRate(rate: number): Promise<number>;
  position(): Promise<PlayerPosition | undefined>;
  /** Stops the current playback, if any. */
  stop(): void;
  /** Kills the host and settles any pending playback. Idempotent. */
  dispose(): Promise<void>;
}

export type PlayerOptions = {
  spawnHost?: HostSpawn;
  /** Used when the host is unavailable; defaults to the one-shot SoundPlayer spawn. */
  fallback?: (path: string) => SpeechProcess;
  /** Non-sensitive diagnostics only (never paths or audio text). */
  log?: (message: string) => void;
  readyTimeoutMs?: number;
  /** Time allowed between sending `play` and the host reporting `opened`. */
  openTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Time allowed for the host to acknowledge `stop` before it is considered wedged and killed. */
  stopTimeoutMs?: number;
  /** The idle host is asked to quit after this long without playback; 0 disables. */
  idleMs?: number;
  /** Added to the duration-based watchdog budget. */
  watchdogSlackMs?: number;
  /** Per-process limit for the SoundPlayer fallback (it reports no duration). */
  fallbackTimeoutMs?: number;
  /** After this many consecutive failed starts the host is no longer retried by this instance. */
  maxStartFailures?: number;
};

type Playback = {
  path: string;
  handle: SpeechProcess;
  resolve(code: number): void;
  reject(error: unknown): void;
  settled: boolean;
  killed: boolean;
  /** `play` was written to the host; its events now belong to this playback. */
  sent: boolean;
  opened: boolean;
  /** The host reported `paused` for this playback; cleared by the next `playing`. */
  paused: boolean;
  /** A `pause` request is in flight; a host crash now must end the playback, not replay it. */
  pausing: boolean;
  /** Callers of `pause()` waiting for the file to open; released when it opens, falls back or settles. */
  openWaiters: (() => void)[];
  fellBack: boolean;
  durationMs: number;
  fallbackProcess?: SpeechProcess;
  cancelTimer?: () => void;
};

type Host = { proc: HostProcess; ready: boolean };
type Waiter = (event: PlayerEvent) => void;

const clampRate = (rate: number) => Math.min(MAX_RATE, Math.max(MIN_RATE, rate));

export function createPlayer(options: PlayerOptions = {}): Player {
  const spawnHost = options.spawnHost ?? defaultHostSpawn();
  const fallback = options.fallback ?? ((path: string) => playWav(path));
  const log = (message: string) => { try { options.log?.(message); } catch {} };
  const readyTimeoutMs = options.readyTimeoutMs ?? 5_000;
  const openTimeoutMs = options.openTimeoutMs ?? 5_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 2_000;
  const idleMs = options.idleMs ?? 60_000;
  const slackMs = options.watchdogSlackMs ?? 5_000;
  const fallbackTimeoutMs = options.fallbackTimeoutMs ?? 120_000;
  const maxStartFailures = options.maxStartFailures ?? 2;

  let disposed = false;
  let disposing: Promise<void> | undefined;
  let host: Host | undefined;
  let starting: Promise<Host | undefined> | undefined;
  let startFailures = 0;
  let rate = 1;
  /** Most recent playback requested; target of stop() and the idle check. */
  let latest: Playback | undefined;
  /** The playback whose `play` is currently in the host; host events belong to it. */
  let live: Playback | undefined;
  /** Owners of outstanding `stop` requests, oldest first; `stopped` events answer them in order. */
  const stops: (Playback | undefined)[] = [];
  const waiters = new Map<PlayerEvent["event"], Waiter[]>();
  /** Releases the outstanding `request()` calls (resolve undefined, cancel their timers), see `dropWaiters`. */
  const releases = new Set<() => void>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Timers guarding a pending promise stay referenced: if they were unref'd, a runtime with nothing else
   * scheduled could exit (or stall) while a caller still awaits the result. Only housekeeping timers unref.
   */
  const timer = (fn: () => void, ms: number, unref = false) => {
    const id = setTimeout(fn, ms);
    if (unref) id.unref?.();
    return () => clearTimeout(id);
  };

  // -- settling ---------------------------------------------------------------------------------

  function finish(pb: Playback, complete: () => void): void {
    if (pb.settled) return;
    pb.settled = true;
    pb.cancelTimer?.();
    if (live === pb) live = undefined;
    if (latest === pb) latest = undefined;
    complete();
    releaseOpenWaiters(pb);
    scheduleIdle();
  }

  /** Lets `pause()` callers that were waiting for the file to open re-check the playback. */
  function releaseOpenWaiters(pb: Playback): void {
    const waiting = pb.openWaiters.splice(0);
    for (const wake of waiting) wake();
  }

  const settle = (pb: Playback, code: number) => finish(pb, () => pb.resolve(code));
  const fail = (pb: Playback, error: unknown) => finish(pb, () => pb.reject(error));

  // -- idle shutdown ----------------------------------------------------------------------------

  function cancelIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  function scheduleIdle(): void {
    cancelIdle();
    if (idleMs <= 0 || disposed || !host || latest || live) return;
    idleTimer = setTimeout(retireIdleHost, idleMs);
    idleTimer.unref?.();
  }

  function retireIdleHost(): void {
    idleTimer = undefined;
    const retired = host;
    if (!retired || latest || live) return;
    host = undefined;
    stops.length = 0;
    try { retired.proc.send(encodeRequest({ cmd: "quit" })); } catch {}
    // `quit` is the clean path; the kill is only a backstop and is a no-op once the process has exited.
    timer(() => { try { retired.proc.kill(); } catch {} }, 2_000, true);
  }

  // -- host lifecycle ---------------------------------------------------------------------------

  /** Nobody can answer these requests any more: release them now instead of leaving their timers to expire. */
  function dropWaiters(): void {
    waiters.clear();
    for (const release of [...releases]) release();
  }

  function recycleHost(reason: string): void {
    log(`player host recycled: ${reason}`);
    const dead = host;
    host = undefined;
    stops.length = 0;
    try { dead?.proc.kill(); } catch {}
  }

  function startHost(): Promise<Host | undefined> {
    if (host?.ready) return Promise.resolve(host);
    if (starting) return starting;
    if (disposed || startFailures >= maxStartFailures) return Promise.resolve(undefined);
    starting = new Promise<Host | undefined>((resolve) => {
      let proc: HostProcess;
      try { proc = spawnHost(); }
      catch (error) {
        startFailures++;
        log(`player host failed to start: ${error instanceof Error ? error.message : String(error)}`);
        resolve(undefined);
        return;
      }
      const h: Host = { proc, ready: false };
      host = h;
      let done = false;
      const finish = (value: Host | undefined) => { if (done) return; done = true; cancelReady(); resolve(value); };
      const cancelReady = timer(() => {
        if (h.ready) return;
        startFailures++;
        log("player host did not become ready");
        if (host === h) host = undefined;
        try { proc.kill(); } catch {}
        finish(undefined);
      }, readyTimeoutMs);
      proc.onLine((line) => {
        const event = decodeEvent(line);
        if (!event || host !== h) return;
        if (event.event === "ready") {
          if (h.ready) return;
          h.ready = true;
          startFailures = 0;
          if (rate !== 1) { try { proc.send(encodeRequest({ cmd: "rate", value: rate })); } catch {} }
          finish(h);
          return;
        }
        if (h.ready) onEvent(event);
      });
      proc.exited.then(() => onHostExit(h, finish), () => onHostExit(h, finish));
    }).finally(() => { starting = undefined; });
    return starting;
  }

  function onHostExit(h: Host, finish: (value: Host | undefined) => void): void {
    const wasCurrent = host === h;
    if (wasCurrent) host = undefined;
    if (!h.ready) {
      if (wasCurrent) { startFailures++; log("player host exited before ready"); }
      finish(undefined);
      return;
    }
    if (!wasCurrent) return;
    log("player host exited");
    stops.length = 0;
    dropWaiters();
    const pb = live;
    if (pb && !pb.settled && !disposed) {
      // Replaying a paused file would restart it from the beginning behind the user's back: end it instead.
      if (pb.paused || pb.pausing) { log("player host exited while paused; playback ended"); settle(pb, 1); }
      else replayWithFallback(pb, "host exited");
    }
    scheduleIdle();
  }

  // -- host events ------------------------------------------------------------------------------

  function answer(event: PlayerEvent): void {
    const queue = waiters.get(event.event);
    const next = queue?.shift();
    if (queue && queue.length === 0) waiters.delete(event.event);
    next?.(event);
  }

  function onEvent(event: PlayerEvent): void {
    const pb = live;
    switch (event.event) {
      case "opened":
        if (pb && !pb.settled) { pb.opened = true; pb.durationMs = event.durationMs; armWatchdog(pb); releaseOpenWaiters(pb); }
        return;
      case "playing":
        if (pb && !pb.settled) { pb.paused = false; armWatchdog(pb); }
        answer(event);
        return;
      case "paused":
        if (pb && !pb.settled) {
          pb.cancelTimer?.();
          if (pb.opened) pb.paused = true;
        }
        answer(event);
        return;
      case "rate":
        if (pb && !pb.settled && pb.opened) armWatchdog(pb);
        answer(event);
        return;
      case "position":
        answer(event);
        return;
      case "ended":
        if (pb) settle(pb, 0);
        return;
      case "stopped": {
        const owner = stops.shift();
        if (owner) settle(owner, 1);
        return;
      }
      case "error":
        if (pb && !pb.settled && !pb.fellBack) {
          if (pb.opened) settle(pb, 1);
          else replayWithFallback(pb, "host could not open the file");
        }
        return;
      default:
        return;
    }
  }

  // -- playback ---------------------------------------------------------------------------------

  /** Budget: the full clip at the current rate plus slack. Re-armed on every state change; off while paused. */
  function armWatchdog(pb: Playback): void {
    if (pb.paused) return;      // a frozen clip makes no progress; `playing` re-arms it with a fresh budget
    pb.cancelTimer?.();
    const budget = pb.durationMs > 0 ? pb.durationMs / rate + slackMs : fallbackTimeoutMs;
    pb.cancelTimer = timer(() => {
      if (pb.settled) return;
      log("player watchdog fired; stopping playback");
      requestStop(pb);
    }, budget);
  }

  /** Asks the host to stop `owner`'s playback. A host that does not acknowledge in time is considered wedged. */
  function requestStop(owner: Playback | undefined): void {
    const h = host;
    if (!h?.ready) { if (owner) settle(owner, 1); return; }
    stops.push(owner);
    try { h.proc.send(encodeRequest({ cmd: "stop" })); }
    catch { if (owner) settle(owner, 1); return; }
    if (!owner) return;
    owner.cancelTimer?.();
    owner.cancelTimer = timer(() => {
      if (owner.settled) return;
      recycleHost("stop was not acknowledged");
      settle(owner, 1);
    }, stopTimeoutMs);
  }

  /** Plays through the one-shot SoundPlayer path. Used whenever the host cannot play this file. */
  function replayWithFallback(pb: Playback, reason: string): void {
    if (pb.settled || pb.fellBack) return;
    if (pb.killed || disposed) { settle(pb, 1); return; }
    pb.fellBack = true;
    log(`player fallback: ${reason}`);
    releaseOpenWaiters(pb);           // a one-shot SoundPlayer playback cannot pause
    pb.cancelTimer?.();
    // The host may still hold the half-opened file; stop it so nothing plays twice.
    if (host?.ready && pb.sent) requestStop(undefined);
    if (live === pb) live = undefined;
    let proc: SpeechProcess;
    try { proc = fallback(pb.path); }
    catch (error) { fail(pb, error); return; }
    pb.fallbackProcess = proc;
    pb.cancelTimer = timer(() => { try { proc.kill(); } catch {} }, fallbackTimeoutMs);
    proc.exited.then((code) => settle(pb, code), (error) => fail(pb, error));
  }

  /**
   * Freezes `pb` in the host (same file, same position). Only a playback that is open in the host can pause;
   * anything else answers false and the caller stops it. A host that does not acknowledge in time is
   * considered wedged: it is recycled and the playback ends, so a paused host never holds the file forever.
   */
  async function pausePlayback(pb: Playback): Promise<boolean> {
    const pausable = () => !pb.settled && !pb.killed && !pb.fellBack && !disposed;
    if (!pausable()) return false;
    // A pause that arrives while the host is starting or opening the file has nothing to freeze yet. It waits
    // for `opened` (the ready/open timeouts bound the wait: they settle or fall back) instead of stopping.
    if (!pb.opened) {
      await new Promise<void>((wake) => { pb.openWaiters.push(wake); });
      if (!pausable() || !pb.opened) return false;
    }
    if (live !== pb) return false;
    if (pb.paused) return true;
    pb.pausing = true;
    const event = await request({ cmd: "pause" }, "paused");
    pb.pausing = false;
    if (pb.settled) return false;           // it ended, was stopped or the host died while we waited
    if (event?.event === "paused") return true;
    log("player pause was not acknowledged; stopping playback");
    recycleHost("pause was not acknowledged");
    settle(pb, 1);
    return false;
  }

  /** Continues a playback frozen by `pausePlayback`; the `playing` ack re-arms the watchdog with a fresh budget. */
  async function resumePlayback(pb: Playback): Promise<boolean> {
    if (pb.settled || pb.killed || !pb.paused || live !== pb || disposed) return false;
    const event = await request({ cmd: "resume" }, "playing");
    if (pb.settled) return false;
    if (event) return true;
    log("player resume was not acknowledged; stopping playback");
    recycleHost("resume was not acknowledged");
    settle(pb, 1);
    return false;
  }

  function killPlayback(pb: Playback): void {
    if (pb.settled) return;
    pb.killed = true;
    if (pb.fallbackProcess) { try { pb.fallbackProcess.kill(); } catch {} return; }
    if (!pb.sent) { settle(pb, 1); return; }
    requestStop(pb);
  }

  async function run(pb: Playback, previous: Playback | undefined): Promise<void> {
    // A new playback supersedes the old one: wait until the host has released the previous file.
    if (previous) await previous.handle.exited.catch(() => {});
    if (pb.settled) return;
    if (lineBreak.test(pb.path)) { replayWithFallback(pb, "unsafe path"); return; }
    const h = await startHost();
    if (pb.settled) return;
    if (!h || host !== h) { replayWithFallback(pb, "host unavailable"); return; }
    pb.sent = true;
    live = pb;
    try { h.proc.send(encodeRequest({ cmd: "play", path: pb.path })); }
    catch { live = undefined; pb.sent = false; replayWithFallback(pb, "host write failed"); return; }
    pb.cancelTimer = timer(() => {
      if (pb.settled || pb.opened) return;
      recycleHost("open timed out");
      replayWithFallback(pb, "open timed out");
    }, openTimeoutMs);
  }

  function play(path: string): SpeechProcess {
    let resolve!: (code: number) => void;
    let reject!: (error: unknown) => void;
    const exited = new Promise<number>((res, rej) => { resolve = res; reject = rej; });
    const pb: Playback = {
      path, resolve, reject, settled: false, killed: false, sent: false, opened: false, paused: false, pausing: false,
      openWaiters: [], fellBack: false, durationMs: -1,
      handle: { exited, kill: () => killPlayback(pb), pause: () => pausePlayback(pb), resume: () => resumePlayback(pb) },
    };
    if (disposed) { resolve(1); return pb.handle; }
    cancelIdle();
    const previous = latest;
    previous?.handle.kill();
    latest = pb;
    void run(pb, previous).catch((error) => replayWithFallback(pb, `unexpected error: ${error instanceof Error ? error.message : String(error)}`));
    return pb.handle;
  }

  // -- controls ---------------------------------------------------------------------------------

  function request(req: PlayerRequest, expect: PlayerEvent["event"]): Promise<PlayerEvent | undefined> {
    const h = host;
    if (!h?.ready || disposed) return Promise.resolve(undefined);
    cancelIdle();
    return new Promise<PlayerEvent | undefined>((resolve) => {
      const queue = waiters.get(expect) ?? [];
      const release = () => { cancelTimer(); releases.delete(release); resolve(undefined); };
      const waiter: Waiter = (event) => { cancelTimer(); releases.delete(release); resolve(event); };
      const cancelTimer = timer(() => {
        const q = waiters.get(expect);
        const at = q?.indexOf(waiter) ?? -1;
        if (q && at >= 0) q.splice(at, 1);
        releases.delete(release);
        resolve(undefined);
      }, requestTimeoutMs);
      releases.add(release);
      queue.push(waiter);
      waiters.set(expect, queue);
      try { h.proc.send(encodeRequest(req)); }
      catch { cancelTimer(); releases.delete(release); queue.splice(queue.indexOf(waiter), 1); resolve(undefined); }
    }).finally(scheduleIdle);
  }

  const player: Player = {
    play,
    async pause() {
      const event = await request({ cmd: "pause" }, "paused");
      return event?.event === "paused" ? event.positionMs : undefined;
    },
    async resume() {
      return (await request({ cmd: "resume" }, "playing")) !== undefined;
    },
    async setRate(value) {
      rate = clampRate(Number.isFinite(value) ? value : 1);
      const event = await request({ cmd: "rate", value: rate }, "rate");
      return event?.event === "rate" ? event.value : rate;
    },
    async position() {
      const event = await request({ cmd: "status" }, "position");
      return event?.event === "position"
        ? { positionMs: event.ms, durationMs: event.durationMs, state: event.state, rate: event.rate }
        : undefined;
    },
    stop() { latest?.handle.kill(); },
    dispose() {
      disposing ??= (async () => {
        disposed = true;
        cancelIdle();
        dropWaiters();
        stops.length = 0;
        for (const pb of [latest, live]) {
          if (!pb || pb.settled) continue;
          try { pb.fallbackProcess?.kill(); } catch {}
          settle(pb, 1);
        }
        const h = host;
        host = undefined;
        if (!h) return;
        try { h.proc.send(encodeRequest({ cmd: "quit" })); } catch {}
        try { h.proc.kill(); } catch {}
        let cancelGrace = () => {};
        const grace = new Promise<void>((r) => { cancelGrace = timer(r, 1_000); });
        await Promise.race([h.proc.exited.catch(() => {}), grace]);
        cancelGrace();
      })();
      return disposing;
    },
  };
  return player;
}
