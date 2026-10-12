import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPlayer, decodeEvent, defaultHostSpawn, encodeRequest,
  type HostProcess, type HostSpawn, type Player, type PlayerEvent, type PlayerOptions,
} from "../src/player";
import type { SpeechProcess } from "../src/speech-sink";

type FakeHost = HostProcess & {
  sent: string[];
  killed: boolean;
  emit(event: PlayerEvent | Record<string, unknown>): void;
  emitRaw(line: string): void;
  die(code?: number): void;
};
type FakeFallback = SpeechProcess & { path: string; killed: boolean; finish(code?: number): void };

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
/** Resolves with the settled value, or "pending" if the promise has not settled yet. */
const peek = <T>(promise: Promise<T>) => Promise.race([promise, tick(15).then(() => "pending" as const)]);

function harness(options: PlayerOptions = {}) {
  const hosts: FakeHost[] = [];
  const fallbacks: FakeFallback[] = [];
  let spawnError: Error | undefined;
  const spawnHost: HostSpawn = () => {
    if (spawnError) throw spawnError;
    let listener: ((line: string) => void) | undefined;
    let done!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { done = resolve; });
    const host: FakeHost = {
      sent: [], killed: false, exited,
      send: (line) => { host.sent.push(line); },
      kill: () => { host.killed = true; done(137); },
      onLine: (cb) => { listener = cb; },
      emit: (event) => listener?.(JSON.stringify(event)),
      emitRaw: (line) => listener?.(line),
      die: (code = 1) => done(code),
    };
    hosts.push(host);
    return host;
  };
  const fallback = (path: string): SpeechProcess => {
    let done!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { done = resolve; });
    const proc: FakeFallback = {
      path, killed: false, exited,
      kill: () => { proc.killed = true; done(1); },
      finish: (code = 0) => done(code),
    };
    fallbacks.push(proc);
    return proc;
  };
  const player: Player = createPlayer({
    spawnHost, fallback,
    readyTimeoutMs: 40, openTimeoutMs: 40, requestTimeoutMs: 40, stopTimeoutMs: 40,
    idleMs: 0, watchdogSlackMs: 20, fallbackTimeoutMs: 1000,
    ...options,
  });
  return { player, hosts, fallbacks, failSpawn: (error: Error | undefined) => { spawnError = error; } };
}

/** Starts one playback and walks the fake host to the "playing" state. */
async function startPlaying(h: ReturnType<typeof harness>, path = "C:\\cache\\a.wav", durationMs = 5000) {
  const handle = h.player.play(path);
  await tick();
  const host = h.hosts.at(-1)!;
  host.emit({ event: "ready" });
  await tick();
  host.emit({ event: "opened", durationMs });
  host.emit({ event: "playing" });
  await tick();
  return { handle, host };
}

describe("protocol", () => {
  test("encodes one command per line", () => {
    expect(encodeRequest({ cmd: "play", path: "C:\\a b\\ñandú #1.wav" })).toBe("play C:\\a b\\ñandú #1.wav");
    expect(encodeRequest({ cmd: "rate", value: 1.5 })).toBe("rate 1.5");
    for (const cmd of ["pause", "resume", "stop", "status", "quit"] as const) expect(encodeRequest({ cmd })).toBe(cmd);
  });

  test("refuses paths that could inject a second command", () => {
    expect(() => encodeRequest({ cmd: "play", path: "C:\\a.wav\nquit" })).toThrow();
    expect(() => encodeRequest({ cmd: "play", path: "C:\\a.wav\rquit" })).toThrow();
  });

  test("refuses non-finite rates", () => {
    expect(() => encodeRequest({ cmd: "rate", value: Number.NaN })).toThrow();
    expect(() => encodeRequest({ cmd: "rate", value: Number.POSITIVE_INFINITY })).toThrow();
  });

  test("decodes every known event", () => {
    expect(decodeEvent('{"event":"ready","ps":"5.1"}')).toEqual({ event: "ready" });
    expect(decodeEvent('{"event":"opened","durationMs":1234}')).toEqual({ event: "opened", durationMs: 1234 });
    expect(decodeEvent('{"event":"playing"}')).toEqual({ event: "playing" });
    expect(decodeEvent('{"event":"paused","positionMs":500}')).toEqual({ event: "paused", positionMs: 500 });
    expect(decodeEvent('{"event":"rate","value":2}')).toEqual({ event: "rate", value: 2 });
    expect(decodeEvent('{"event":"position","ms":10,"durationMs":99,"state":"playing","rate":1.5}'))
      .toEqual({ event: "position", ms: 10, durationMs: 99, state: "playing", rate: 1.5 });
    expect(decodeEvent('{"event":"ended"}')).toEqual({ event: "ended" });
    expect(decodeEvent('{"event":"stopped"}')).toEqual({ event: "stopped" });
    expect(decodeEvent('{"event":"error","message":"boom"}')).toEqual({ event: "error", message: "boom" });
    expect(decodeEvent('{"event":"bye","reason":"quit"}')).toEqual({ event: "bye", reason: "quit" });
  });

  test("ignores malformed lines and unknown events", () => {
    for (const line of ["", "   ", "not json", "[]", "null", "42", '{"event":"nope"}', '{"event":7}', '{"foo":1}', "{broken"]) {
      expect(decodeEvent(line)).toBeUndefined();
    }
  });

  test("fills unusable numeric fields with safe defaults", () => {
    expect(decodeEvent('{"event":"opened","durationMs":"x"}')).toEqual({ event: "opened", durationMs: -1 });
    expect(decodeEvent('{"event":"paused"}')).toEqual({ event: "paused", positionMs: 0 });
    expect(decodeEvent('{"event":"error"}')).toEqual({ event: "error", message: "" });
  });
});

describe("play lifecycle", () => {
  test("starts the host lazily and plays only after ready", async () => {
    const h = harness();
    expect(h.hosts).toHaveLength(0);
    const handle = h.player.play("C:\\cache\\one two\\ñ.wav");
    await tick();
    expect(h.hosts).toHaveLength(1);
    expect(h.hosts[0]!.sent).toEqual([]);
    h.hosts[0]!.emit({ event: "ready" });
    await tick();
    expect(h.hosts[0]!.sent).toEqual(["play C:\\cache\\one two\\ñ.wav"]);
    h.hosts[0]!.emit({ event: "opened", durationMs: 1000 });
    h.hosts[0]!.emit({ event: "playing" });
    expect(await peek(handle.exited)).toBe("pending");
    h.hosts[0]!.emit({ event: "ended" });
    expect(await handle.exited).toBe(0);
    expect(h.fallbacks).toHaveLength(0);
    await h.player.dispose();
  });

  test("reuses one host for consecutive playbacks", async () => {
    const h = harness();
    const first = await startPlaying(h);
    first.host.emit({ event: "ended" });
    await first.handle.exited;
    const second = h.player.play("C:\\cache\\b.wav");
    await tick();
    expect(h.hosts).toHaveLength(1);
    expect(h.hosts[0]!.sent.at(-1)).toBe("play C:\\cache\\b.wav");
    h.hosts[0]!.emit({ event: "opened", durationMs: 100 });
    h.hosts[0]!.emit({ event: "ended" });
    expect(await second.exited).toBe(0);
    await h.player.dispose();
  });

  test("malformed host output never disturbs playback", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h);
    for (const line of ["", "garbage", "{", '{"event":"mystery"}', "[1,2]"]) host.emitRaw(line);
    expect(await peek(handle.exited)).toBe("pending");
    host.emit({ event: "ended" });
    expect(await handle.exited).toBe(0);
    await h.player.dispose();
  });

  test("kill sends stop and settles on the stopped event, not before", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h);
    handle.kill();
    expect(host.sent.at(-1)).toBe("stop");
    expect(await peek(handle.exited)).toBe("pending");
    host.emit({ event: "stopped" });
    expect(await handle.exited).toBe(1);
    expect(host.killed).toBe(false);
    await h.player.dispose();
  });

  test("an unanswered stop settles after the ack timeout and recycles the host", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h);
    handle.kill();
    expect(await handle.exited).toBe(1);
    expect(host.killed).toBe(true);
    await h.player.dispose();
  });

  test("player.stop() stops the current playback", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h);
    h.player.stop();
    host.emit({ event: "stopped" });
    expect(await handle.exited).toBe(1);
    await h.player.dispose();
  });

  test("kill before the host is ready settles immediately and never plays", async () => {
    const h = harness();
    const handle = h.player.play("C:\\cache\\a.wav");
    await tick();
    handle.kill();
    expect(await handle.exited).toBe(1);
    h.hosts[0]!.emit({ event: "ready" });
    await tick();
    expect(h.hosts[0]!.sent).toEqual([]);
    expect(h.fallbacks).toHaveLength(0);
    await h.player.dispose();
  });

  test("a late stopped event from a finished playback cannot stop the next one", async () => {
    const h = harness();
    const first = await startPlaying(h, "C:\\cache\\a.wav");
    first.handle.kill();                       // sends stop ...
    first.host.emit({ event: "ended" });       // ... but the clip had already ended
    expect(await first.handle.exited).toBe(0);
    const second = h.player.play("C:\\cache\\b.wav");
    await tick();
    first.host.emit({ event: "stopped" });     // belongs to the first playback's stop
    first.host.emit({ event: "opened", durationMs: 1000 });
    first.host.emit({ event: "playing" });
    expect(await peek(second.exited)).toBe("pending");
    first.host.emit({ event: "ended" });
    expect(await second.exited).toBe(0);
    await h.player.dispose();
  });

  test("starting a new playback stops the previous one first", async () => {
    const h = harness();
    const first = await startPlaying(h, "C:\\cache\\a.wav");
    const second = h.player.play("C:\\cache\\b.wav");
    expect(first.host.sent.at(-1)).toBe("stop");
    expect(first.host.sent).not.toContain("play C:\\cache\\b.wav");
    first.host.emit({ event: "stopped" });
    expect(await first.handle.exited).toBe(1);
    await tick();
    expect(first.host.sent.at(-1)).toBe("play C:\\cache\\b.wav");
    first.host.emit({ event: "opened", durationMs: 100 });
    first.host.emit({ event: "ended" });
    expect(await second.exited).toBe(0);
    await h.player.dispose();
  });
});

describe("controls", () => {
  test("pause resolves with the reported position and resume with success", async () => {
    const h = harness();
    const { host } = await startPlaying(h);
    const paused = h.player.pause();
    expect(host.sent.at(-1)).toBe("pause");
    host.emit({ event: "paused", positionMs: 750 });
    expect(await paused).toBe(750);
    const resumed = h.player.resume();
    expect(host.sent.at(-1)).toBe("resume");
    host.emit({ event: "playing" });
    expect(await resumed).toBe(true);
    await h.player.dispose();
  });

  test("setRate sends the clamped rate and resolves with the applied value", async () => {
    const h = harness();
    const { host } = await startPlaying(h);
    const applied = h.player.setRate(2);
    expect(host.sent.at(-1)).toBe("rate 2");
    host.emit({ event: "rate", value: 2 });
    expect(await applied).toBe(2);
    const clamped = h.player.setRate(100);
    expect(host.sent.at(-1)).toBe("rate 8");
    host.emit({ event: "rate", value: 8 });
    expect(await clamped).toBe(8);
    await h.player.dispose();
  });

  test("a stored rate is applied when the host starts", async () => {
    const h = harness();
    expect(await h.player.setRate(1.5)).toBe(1.5);
    expect(h.hosts).toHaveLength(0);
    h.player.play("C:\\cache\\a.wav");
    await tick();
    h.hosts[0]!.emit({ event: "ready" });
    await tick();
    expect(h.hosts[0]!.sent).toEqual(["rate 1.5", "play C:\\cache\\a.wav"]);
    await h.player.dispose();
  });

  test("position maps the status reply", async () => {
    const h = harness();
    const { host } = await startPlaying(h);
    const reply = h.player.position();
    expect(host.sent.at(-1)).toBe("status");
    host.emit({ event: "position", ms: 321, durationMs: 4000, state: "playing", rate: 1.5 });
    expect(await reply).toEqual({ positionMs: 321, durationMs: 4000, state: "playing", rate: 1.5 });
    await h.player.dispose();
  });

  test("controls without a running host resolve without spawning one", async () => {
    const h = harness();
    expect(await h.player.pause()).toBeUndefined();
    expect(await h.player.resume()).toBe(false);
    expect(await h.player.position()).toBeUndefined();
    expect(h.hosts).toHaveLength(0);
    await h.player.dispose();
  });

  test("an unanswered request times out instead of hanging", async () => {
    const h = harness();
    await startPlaying(h);
    expect(await h.player.position()).toBeUndefined();
    await h.player.dispose();
  });
});

describe("watchdog", () => {
  test("a lost ended event stops the playback after duration plus slack", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h, "C:\\cache\\a.wav", 30);
    expect(await peek(handle.exited)).toBe("pending");
    await tick(60);
    expect(host.sent.at(-1)).toBe("stop");
    host.emit({ event: "stopped" });
    expect(await handle.exited).toBe(1);
    await h.player.dispose();
  });

  test("the budget scales with the playback rate", async () => {
    const h = harness({ watchdogSlackMs: 0 });
    const { handle, host } = await startPlaying(h, "C:\\cache\\a.wav", 240);
    const applied = h.player.setRate(2);
    host.emit({ event: "rate", value: 2 });
    await applied;
    await tick(40);
    expect(host.sent).not.toContain("stop");
    await tick(130);                            // 120 ms budget at 2x; the unscaled 240 ms has not elapsed
    expect(host.sent.at(-1)).toBe("stop");
    host.emit({ event: "stopped" });
    await handle.exited;
    await h.player.dispose();
  });

  test("a paused playback is not cut by the watchdog", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h, "C:\\cache\\a.wav", 20);
    const paused = h.player.pause();
    host.emit({ event: "paused", positionMs: 5 });
    await paused;
    await tick(80);
    expect(host.sent).not.toContain("stop");
    expect(await peek(handle.exited)).toBe("pending");
    await h.player.dispose();
  });
});

describe("pausable play handle", () => {
  test("pause freezes the playback: pause is sent, the ack resolves true, nothing is stopped or settled", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h);
    expect(typeof handle.pause).toBe("function");
    expect(typeof handle.resume).toBe("function");
    const paused = handle.pause!();
    expect(host.sent.at(-1)).toBe("pause");
    host.emit({ event: "paused", positionMs: 400 });
    expect(await paused).toBe(true);
    expect(host.sent).not.toContain("stop");
    expect(host.killed).toBe(false);
    expect(await peek(handle.exited)).toBe("pending");
    await h.player.dispose();
  });

  test("pausing twice acknowledges without sending a second request", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h);
    const first = handle.pause!();
    host.emit({ event: "paused", positionMs: 10 });
    await first;
    const sent = host.sent.length;
    expect(await handle.pause!()).toBe(true);
    expect(host.sent).toHaveLength(sent);
    await h.player.dispose();
  });

  test("resume sends resume, the ack resolves true, and the playback then ends normally", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h);
    const paused = handle.pause!();
    host.emit({ event: "paused", positionMs: 400 });
    await paused;
    const resumed = handle.resume!();
    expect(host.sent.at(-1)).toBe("resume");
    host.emit({ event: "playing" });
    expect(await resumed).toBe(true);
    expect(await peek(handle.exited)).toBe("pending");
    host.emit({ event: "ended" });
    expect(await handle.exited).toBe(0);
    await h.player.dispose();
  });

  test("resume without a pause is refused and sends nothing", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h);
    const sent = host.sent.length;
    expect(await handle.resume!()).toBe(false);
    expect(host.sent).toHaveLength(sent);
    await h.player.dispose();
  });

  test("the watchdog stays disarmed while paused and is re-armed on resume", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h, "C:\\cache\\a.wav", 20);   // budget 20 + 20 slack
    const paused = handle.pause!();
    host.emit({ event: "paused", positionMs: 5 });
    await paused;
    await tick(100);                                       // far beyond the budget
    expect(host.sent).not.toContain("stop");
    const resumed = handle.resume!();
    host.emit({ event: "playing" });
    await resumed;
    await tick(15);
    expect(host.sent).not.toContain("stop");               // the paused time did not count
    await tick(60);
    expect(host.sent.at(-1)).toBe("stop");                 // but a lost `ended` is still caught
    host.emit({ event: "stopped" });
    expect(await handle.exited).toBe(1);
    await h.player.dispose();
  });

  test("a rate change while paused does not re-arm the watchdog", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h, "C:\\cache\\a.wav", 20);
    const paused = handle.pause!();
    host.emit({ event: "paused", positionMs: 5 });
    await paused;
    const applied = h.player.setRate(2);
    host.emit({ event: "rate", value: 2 });
    await applied;
    await tick(100);
    expect(host.sent).not.toContain("stop");
    expect(await peek(handle.exited)).toBe("pending");
    await h.player.dispose();
  });

  test("idle shutdown is suppressed while paused and resumes after the playback ends", async () => {
    const h = harness({ idleMs: 20 });
    const { handle, host } = await startPlaying(h, "C:\\cache\\a.wav", 5000);
    const paused = handle.pause!();
    host.emit({ event: "paused", positionMs: 100 });
    await paused;
    await tick(80);
    expect(host.sent).not.toContain("quit");
    expect(host.killed).toBe(false);
    const resumed = handle.resume!();
    host.emit({ event: "playing" });
    await resumed;
    host.emit({ event: "ended" });
    await handle.exited;
    await tick(60);
    expect(host.sent.at(-1)).toBe("quit");
    await h.player.dispose();
  });

  test("an unacknowledged pause degrades to stop: host recycled, playback settled, no replay", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h);
    expect(await handle.pause!()).toBe(false);             // requestTimeoutMs is 40 ms in this harness
    expect(host.killed).toBe(true);
    expect(await handle.exited).toBe(1);
    expect(h.fallbacks).toHaveLength(0);
    await h.player.dispose();
  });

  test("an unacknowledged resume degrades to stop and never leaves the host holding the file", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h);
    const paused = handle.pause!();
    host.emit({ event: "paused", positionMs: 5 });
    await paused;
    expect(await handle.resume!()).toBe(false);
    expect(host.killed).toBe(true);
    expect(await handle.exited).toBe(1);
    expect(h.fallbacks).toHaveLength(0);
    await h.player.dispose();
  });

  test("a host crash while paused ends the playback instead of replaying it from the start", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h);
    const paused = handle.pause!();
    host.emit({ event: "paused", positionMs: 5 });
    await paused;
    host.die();
    expect(await handle.exited).toBe(1);
    await tick();
    expect(h.fallbacks).toHaveLength(0);
    await h.player.dispose();
  });

  test("a host crash while the pause is still pending also ends the playback", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h);
    const paused = handle.pause!();
    host.die();
    expect(await handle.exited).toBe(1);
    expect(await paused).toBe(false);
    expect(h.fallbacks).toHaveLength(0);
    await h.player.dispose();
  });

  test("killing a paused playback sends stop and settles on the stopped event", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h);
    const paused = handle.pause!();
    host.emit({ event: "paused", positionMs: 5 });
    await paused;
    handle.kill();
    expect(host.sent.at(-1)).toBe("stop");
    host.emit({ event: "stopped" });
    expect(await handle.exited).toBe(1);
    await h.player.dispose();
  });

  test("dispose while paused settles the playback and kills the host", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h);
    const paused = handle.pause!();
    host.emit({ event: "paused", positionMs: 5 });
    await paused;
    await h.player.dispose();
    expect(await handle.exited).toBe(1);
    expect(host.killed).toBe(true);
  });

  test("a pause that arrives while the file is still opening waits for `opened`, then freezes it", async () => {
    const h = harness({ openTimeoutMs: 1_000 });
    const early = h.player.play("C:\\cache\\a.wav");
    await tick();
    const host = h.hosts[0]!;
    host.emit({ event: "ready" });
    await tick();
    const paused = early.pause!();
    await tick();
    expect(host.sent).not.toContain("pause");              // nothing to freeze yet
    expect(await peek(paused)).toBe("pending");
    host.emit({ event: "opened", durationMs: 5000 });
    host.emit({ event: "playing" });
    await tick();
    expect(host.sent.at(-1)).toBe("pause");
    host.emit({ event: "paused", positionMs: 3 });
    expect(await paused).toBe(true);
    expect(await peek(early.exited)).toBe("pending");
    expect(h.fallbacks).toHaveLength(0);
    await h.player.dispose();
  });

  test("a pause waiting for the host to start also waits for the host to become ready", async () => {
    const h = harness();
    const early = h.player.play("C:\\cache\\a.wav");
    const paused = early.pause!();                          // the host has not even been started yet
    await tick();
    const host = h.hosts[0]!;
    expect(host.sent).toEqual([]);
    host.emit({ event: "ready" });
    await tick();
    host.emit({ event: "opened", durationMs: 5000 });
    host.emit({ event: "playing" });
    await tick();
    host.emit({ event: "paused", positionMs: 3 });
    expect(await paused).toBe(true);
    await h.player.dispose();
  });

  test("a pause waiting for the file to open answers false when the playback is killed or falls back meanwhile", async () => {
    const killed = harness();
    const a = killed.player.play("C:\\cache\\a.wav");
    await tick();
    killed.hosts[0]!.emit({ event: "ready" });
    await tick();
    const waitingA = a.pause!();
    a.kill();
    killed.hosts[0]!.emit({ event: "stopped" });
    expect(await waitingA).toBe(false);
    expect(await a.exited).toBe(1);
    expect(killed.hosts[0]!.sent).not.toContain("pause");

    const failed = harness();
    const b = failed.player.play("C:\\cache\\b.wav");
    await tick();
    failed.hosts[0]!.emit({ event: "ready" });
    await tick();
    const waitingB = b.pause!();
    failed.hosts[0]!.emit({ event: "error", message: "cannot open" });   // not opened: SoundPlayer fallback takes over
    expect(await waitingB).toBe(false);
    expect(failed.fallbacks).toHaveLength(1);
    expect(failed.hosts[0]!.sent).not.toContain("pause");
    failed.fallbacks[0]!.finish(0);
    expect(await b.exited).toBe(0);
    await killed.player.dispose();
    await failed.player.dispose();
  });

  test("a pending pause request is released immediately when the host dies, not after the request timeout", async () => {
    const h = harness({ requestTimeoutMs: 5_000 });
    const { handle, host } = await startPlaying(h);
    const paused = handle.pause!();
    const started = Date.now();
    host.die();
    expect(await paused).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await handle.exited).toBe(1);
    await h.player.dispose();
  });

  test("disposing with a pause request in flight releases it immediately", async () => {
    const h = harness({ requestTimeoutMs: 5_000 });
    const { handle } = await startPlaying(h);
    const paused = handle.pause!();
    const started = Date.now();
    await h.player.dispose();
    expect(await paused).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await handle.exited).toBe(1);
  });

  test("a fallback playback and a settled playback cannot pause", async () => {
    const h = harness();
    const early = await startPlaying(h);
    early.handle.kill();
    early.host.emit({ event: "stopped" });
    await early.handle.exited;
    expect(await early.handle.pause!()).toBe(false);       // settled
    expect(await early.handle.resume!()).toBe(false);

    const fb = harness();
    fb.failSpawn(new Error("no powershell"));
    const fallen = fb.player.play("C:\\cache\\a.wav");
    await tick();
    expect(await fallen.pause!()).toBe(false);
    expect(await fallen.resume!()).toBe(false);
    expect(fb.fallbacks[0]!.killed).toBe(false);           // asking never touches the fallback process
    fb.fallbacks[0]!.finish(0);
    expect(await fallen.exited).toBe(0);
    await h.player.dispose();
    await fb.player.dispose();
  });
});

describe("fallback", () => {
  test("host process dying before ready falls back to the SoundPlayer path", async () => {
    const h = harness();
    const handle = h.player.play("C:\\cache\\a.wav");
    await tick();
    h.hosts[0]!.die();
    await tick();
    expect(h.fallbacks.map((f) => f.path)).toEqual(["C:\\cache\\a.wav"]);
    h.fallbacks[0]!.finish(0);
    expect(await handle.exited).toBe(0);
    await h.player.dispose();
  });

  test("ready timeout kills the host and falls back", async () => {
    const h = harness();
    const handle = h.player.play("C:\\cache\\a.wav");
    await tick(80);
    expect(h.hosts[0]!.killed).toBe(true);
    expect(h.fallbacks).toHaveLength(1);
    h.fallbacks[0]!.finish(0);
    expect(await handle.exited).toBe(0);
    await h.player.dispose();
  });

  test("a spawn that throws falls back", async () => {
    const h = harness();
    h.failSpawn(new Error("no powershell"));
    const handle = h.player.play("C:\\cache\\a.wav");
    await tick();
    expect(h.fallbacks).toHaveLength(1);
    h.fallbacks[0]!.finish(0);
    expect(await handle.exited).toBe(0);
    await h.player.dispose();
  });

  test("an error event while opening falls back and stops the host", async () => {
    const h = harness();
    const handle = h.player.play("C:\\cache\\a.wav");
    await tick();
    h.hosts[0]!.emit({ event: "ready" });
    await tick();
    h.hosts[0]!.emit({ event: "error", message: "file not found" });
    await tick();
    expect(h.fallbacks).toHaveLength(1);
    expect(h.hosts[0]!.sent.at(-1)).toBe("stop");
    h.hosts[0]!.emit({ event: "stopped" });         // must not settle the fallback playback
    expect(await peek(handle.exited)).toBe("pending");
    h.fallbacks[0]!.finish(0);
    expect(await handle.exited).toBe(0);
    await h.player.dispose();
  });

  test("an open that never completes falls back", async () => {
    const h = harness();
    const handle = h.player.play("C:\\cache\\a.wav");
    await tick();
    h.hosts[0]!.emit({ event: "ready" });
    await tick(80);
    expect(h.hosts[0]!.killed).toBe(true);
    expect(h.fallbacks).toHaveLength(1);
    h.fallbacks[0]!.finish(0);
    expect(await handle.exited).toBe(0);
    await h.player.dispose();
  });

  test("a host crash during playback replays that file through the fallback", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h);
    host.die();
    await tick();
    expect(h.fallbacks.map((f) => f.path)).toEqual(["C:\\cache\\a.wav"]);
    h.fallbacks[0]!.finish(0);
    expect(await handle.exited).toBe(0);
    await h.player.dispose();
  });

  test("a crashed host is replaced on the next playback", async () => {
    const h = harness();
    const first = await startPlaying(h);
    first.host.die();
    await tick();
    h.fallbacks[0]!.finish(0);
    await first.handle.exited;
    const second = h.player.play("C:\\cache\\b.wav");
    await tick();
    expect(h.hosts).toHaveLength(2);
    h.hosts[1]!.emit({ event: "ready" });
    await tick();
    h.hosts[1]!.emit({ event: "opened", durationMs: 100 });
    h.hosts[1]!.emit({ event: "ended" });
    expect(await second.exited).toBe(0);
    await h.player.dispose();
  });

  test("repeated start failures stop respawning the host", async () => {
    const h = harness({ maxStartFailures: 2 });
    for (let i = 0; i < 3; i++) {
      const handle = h.player.play(`C:\\cache\\${i}.wav`);
      await tick();
      h.hosts[i]?.die();
      await tick();
      h.fallbacks[i]!.finish(0);
      await handle.exited;
    }
    expect(h.hosts).toHaveLength(2);
    expect(h.fallbacks).toHaveLength(3);
    await h.player.dispose();
  });

  test("a path with a line break never reaches the host", async () => {
    const h = harness();
    const handle = h.player.play("C:\\cache\\a.wav\nquit");
    await tick();
    expect(h.fallbacks).toHaveLength(1);
    expect(h.hosts.flatMap((host) => host.sent)).toEqual([]);
    h.fallbacks[0]!.finish(0);
    expect(await handle.exited).toBe(0);
    await h.player.dispose();
  });

  test("killing the handle kills the fallback process", async () => {
    const h = harness();
    h.failSpawn(new Error("no powershell"));
    const handle = h.player.play("C:\\cache\\a.wav");
    await tick();
    handle.kill();
    expect(h.fallbacks[0]!.killed).toBe(true);
    expect(await handle.exited).toBe(1);
    await h.player.dispose();
  });

  test("a fallback that cannot spawn rejects exited, like the old direct spawn", async () => {
    const h = harness({ fallback: () => { throw new Error("spawn failed"); } });
    h.failSpawn(new Error("no powershell"));
    const handle = h.player.play("C:\\cache\\a.wav");
    await expect(handle.exited).rejects.toThrow("spawn failed");
    await h.player.dispose();
  });

  test("the fallback keeps the old per-process timeout", async () => {
    const h = harness({ fallbackTimeoutMs: 20 });
    h.failSpawn(new Error("no powershell"));
    const handle = h.player.play("C:\\cache\\a.wav");
    expect(await handle.exited).toBe(1);
    expect(h.fallbacks[0]!.killed).toBe(true);
    await h.player.dispose();
  });
});

describe("idle shutdown and dispose", () => {
  test("an idle host is told to quit and a new one starts on demand", async () => {
    const h = harness({ idleMs: 30 });
    const first = await startPlaying(h);
    first.host.emit({ event: "ended" });
    await first.handle.exited;
    await tick(10);
    expect(first.host.sent).not.toContain("quit");
    await tick(50);
    expect(first.host.sent.at(-1)).toBe("quit");
    const second = h.player.play("C:\\cache\\b.wav");
    await tick();
    expect(h.hosts).toHaveLength(2);
    second.kill();
    await h.player.dispose();
  });

  test("a playing host is never shut down as idle", async () => {
    const h = harness({ idleMs: 20 });
    const { host } = await startPlaying(h, "C:\\cache\\a.wav", 5000);
    await tick(60);
    expect(host.sent).not.toContain("quit");
    await h.player.dispose();
  });

  test("dispose settles a pending playback, kills the host and is idempotent", async () => {
    const h = harness();
    const { handle, host } = await startPlaying(h);
    await h.player.dispose();
    expect(await handle.exited).toBe(1);
    expect(host.killed).toBe(true);
    await h.player.dispose();
  });

  test("dispose while the host is still starting kills it", async () => {
    const h = harness();
    const handle = h.player.play("C:\\cache\\a.wav");
    await tick();
    await h.player.dispose();
    expect(await handle.exited).toBe(1);
    expect(h.hosts[0]!.killed).toBe(true);
    expect(h.fallbacks).toHaveLength(0);
  });

  test("play after dispose settles immediately without spawning", async () => {
    const h = harness();
    await h.player.dispose();
    const handle = h.player.play("C:\\cache\\a.wav");
    expect(await handle.exited).toBe(1);
    expect(h.hosts).toHaveLength(0);
    expect(h.fallbacks).toHaveLength(0);
  });
});

describe("real host smoke (OV_PLAYER_SMOKE=1)", () => {
  /** Mono 16-bit 8 kHz silence; muted playback makes the content irrelevant. */
  function silentWav(path: string, seconds: number) {
    const rate = 8000, samples = Math.floor(rate * seconds), data = samples * 2;
    const b = Buffer.alloc(44 + data);
    b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + data, 4); b.write("WAVE", 8, "ascii");
    b.write("fmt ", 12, "ascii"); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write("data", 36, "ascii"); b.writeUInt32LE(data, 40);
    writeFileSync(path, b);
  }

  test.skipIf(process.env.OV_PLAYER_SMOKE !== "1")("plays a WAV with spaces and unicode, muted, then lets it be deleted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "open vox smoke ñ-"));
    const wav = join(dir, "clip #1 ñ.wav");
    silentWav(wav, 3);
    const player = createPlayer({
      spawnHost: defaultHostSpawn({ ...process.env, OV_PLAYER_MUTE: "1" }),
      fallback: () => { throw new Error("fallback used: the real host did not work"); },
    });
    try {
      const handle = player.play(wav);
      let before = await player.position();      // undefined until the host is up and ready
      for (let i = 0; i < 50 && before?.state !== "playing"; i++) { await Bun.sleep(50); before = await player.position(); }
      expect(before?.state).toBe("playing");
      const pausedAt = await player.pause();
      expect(pausedAt).toBeGreaterThan(0);
      await Bun.sleep(150);
      const frozen = await player.position();
      expect(frozen?.state).toBe("paused");
      expect(Math.abs((frozen?.positionMs ?? 0) - pausedAt!)).toBeLessThan(60);
      expect(await player.setRate(2)).toBe(2);
      expect(await player.resume()).toBe(true);
      expect(await handle.exited).toBe(0);
      unlinkSync(wav);                           // must not be locked once `ended` is reported
      expect(existsSync(wav)).toBe(false);
    } finally {
      await player.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test.skipIf(process.env.OV_PLAYER_SMOKE !== "1")("the play handle pauses in place, holds the position and resumes to the end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "open vox smoke ñ-"));
    const wav = join(dir, "clip #2 ñ.wav");
    silentWav(wav, 3);
    const player = createPlayer({
      spawnHost: defaultHostSpawn({ ...process.env, OV_PLAYER_MUTE: "1" }),
      fallback: () => { throw new Error("fallback used: the real host did not work"); },
    });
    try {
      const handle = player.play(wav);
      let before = await player.position();
      for (let i = 0; i < 50 && before?.state !== "playing"; i++) { await Bun.sleep(50); before = await player.position(); }
      expect(before?.state).toBe("playing");
      await Bun.sleep(200);
      expect(await handle.pause!()).toBe(true);
      const frozenAt = (await player.position())!;
      expect(frozenAt.state).toBe("paused");
      expect(frozenAt.positionMs).toBeGreaterThan(0);
      await Bun.sleep(600);                                  // the position must not advance while paused
      const later = (await player.position())!;
      expect(later.state).toBe("paused");
      expect(Math.abs(later.positionMs - frozenAt.positionMs)).toBeLessThan(60);
      expect(await Promise.race([handle.exited, Bun.sleep(100).then(() => "pending")])).toBe("pending");
      expect(await handle.resume!()).toBe(true);
      expect(await handle.exited).toBe(0);
      unlinkSync(wav);
      expect(existsSync(wav)).toBe(false);
    } finally {
      await player.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
