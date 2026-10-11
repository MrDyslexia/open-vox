import { describe, expect, test } from "bun:test";
import { createSpeechSink, sapiEngine, playWav, type SpeechProcess, type Spawn } from "../src/speech-sink";

type Fake = SpeechProcess & { stdin: string; killed: boolean; finish(code?: number): void; fail(error: Error): void };

function harness() {
  const procs: Fake[] = [];
  const spawn: Spawn = (_args, stdin) => {
    let done!: (code: number) => void;
    let failed!: (error: Error) => void;
    const exited = new Promise<number>((resolve, reject) => { done = resolve; failed = reject; });
    const proc: Fake = {
      stdin, killed: false, exited,
      kill() { proc.killed = true; done(1); },
      finish(code = 0) { done(code); },
      fail(error) { failed(error); },
    };
    procs.push(proc);
    return proc;
  };
  return { procs, spawn };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const item = (id: string, text: string) => ({ sessionID: "s", messageID: id, text });

describe("speech sink", () => {
  test("speaks prepared text with the detected language", async () => {
    const h = harness();
    const sink = createSpeechSink({ spawn: h.spawn });
    const pending = sink(item("m1", "**Hola**, esta es la respuesta que necesitas para el proyecto."));
    await tick();
    expect(h.procs).toHaveLength(1);
    expect(h.procs[0]!.stdin).toContain("esta es la respuesta");
    expect(h.procs[0]!.stdin).not.toContain("**");
    h.procs[0]!.finish();
    await pending;
  });

  test("passes the language to the process arguments", async () => {
    const calls: string[][] = [];
    const sink = createSpeechSink({ spawn: (args) => { calls.push(args); return { exited: Promise.resolve(0), kill() {} }; } });
    await sink(item("m1", "Here is the answer that you need for the project."));
    await sink(item("m2", "Aquí está la respuesta que necesitas para el proyecto."));
    expect(calls[0]!.join(" ")).toContain("en");
    expect(calls[1]!.join(" ")).toContain("es");
  });

  test("skips messages that are empty after preparation", async () => {
    const h = harness();
    const sink = createSpeechSink({ spawn: h.spawn });
    await sink(item("m1", "```\ncode only\n```"));
    expect(h.procs).toHaveLength(0);
  });

  test("speaks queued messages serially", async () => {
    const h = harness();
    const sink = createSpeechSink({ spawn: h.spawn });
    const a = sink(item("m1", "First message here for the user."));
    const b = sink(item("m2", "Second message here for the user."));
    await tick();
    expect(h.procs).toHaveLength(1);
    h.procs[0]!.finish();
    await a;
    await tick();
    expect(h.procs).toHaveLength(2);
    h.procs[1]!.finish();
    await b;
  });

  test("drops the oldest pending item beyond the queue limit", async () => {
    const h = harness();
    const sink = createSpeechSink({ spawn: h.spawn, maxPending: 1 });
    const a = sink(item("m1", "Playing now for the user."));
    const b = sink(item("m2", "Pending that gets dropped by the next."));
    const c = sink(item("m3", "Latest pending message for the user."));
    await tick();
    h.procs[0]!.finish();
    await Promise.all([a, b]);
    await tick();
    expect(h.procs).toHaveLength(2);
    expect(h.procs[1]!.stdin).toContain("Latest pending");
    h.procs[1]!.finish();
    await c;
  });

  test("stop kills the current process and clears the queue", async () => {
    const h = harness();
    const sink = createSpeechSink({ spawn: h.spawn });
    const a = sink(item("m1", "Currently playing message here."));
    const b = sink(item("m2", "Queued message never played here."));
    await tick();
    sink.stop();
    await Promise.all([a, b]);
    await tick();
    expect(h.procs[0]!.killed).toBe(true);
    expect(h.procs).toHaveLength(1);
  });

  test("contains spawn failures", async () => {
    const errors: unknown[] = [];
    const sink = createSpeechSink({ spawn: () => { throw new Error("no powershell"); }, onError: (e) => errors.push(e) });
    await sink(item("m1", "This message will fail to spawn."));
    expect(errors).toHaveLength(1);
  });

  test("contains process errors and nonzero exits, then continues", async () => {
    const h = harness();
    const errors: unknown[] = [];
    const sink = createSpeechSink({ spawn: h.spawn, onError: (e) => errors.push(e) });
    const a = sink(item("m1", "Fails with a process error here."));
    const b = sink(item("m2", "Exits with a nonzero status here."));
    const c = sink(item("m3", "Succeeds after the failures here."));
    await tick();
    h.procs[0]!.fail(new Error("boom"));
    await a;
    await tick();
    h.procs[1]!.finish(3);
    await b;
    await tick();
    h.procs[2]!.finish(0);
    await c;
    expect(errors).toHaveLength(2);
  });

  test("a hung process is killed after the timeout", async () => {
    const h = harness();
    const sink = createSpeechSink({ spawn: h.spawn, timeoutMs: 20 });
    const a = sink(item("m1", "This will hang forever for the user."));
    await a;
    expect(h.procs[0]!.killed).toBe(true);
  });

  test("disabled sink never spawns", async () => {
    const h = harness();
    const sink = createSpeechSink({ spawn: h.spawn, enabled: false });
    await sink(item("m1", "Muted message that should not play."));
    expect(h.procs).toHaveLength(0);
  });
});

describe("exact-audio replay", () => {
  test("SAPI generates a WAV with escaped owned path and player does not invoke Speak", async () => {
    const calls: { args: string[]; text: string }[] = [];
    const spawn: Spawn = (args, text) => { calls.push({ args, text }); return { exited: Promise.resolve(0), kill() {} }; };
    await sapiEngine(spawn).synthesize!("stdin only", "en", "C:\\o'brien\\owned.wav").exited;
    await playWav("C:\\o'brien\\owned.wav", spawn).exited;
    expect(calls[0]!.args.join(" ")).toContain("SetOutputToWaveFile('C:\\o''brien\\owned.wav')");
    expect(calls[0]!.text).toBe("stdin only");
    expect(calls[1]!.args.join(" ")).toContain("PlaySync()");
    expect(calls[1]!.args.join(" ")).not.toContain("Speak");
  });
  function replayHarness() {
    const h = harness();
    let last: { file: string; sessionID: string; revision: number } | undefined;
    let paused = false;
    let now = 1000;
    const played: string[] = [];
    const generated: string[] = [];
    const removed: string[] = [];
    let count = 0;
    const cache = {
      candidate: () => `wav-${++count}`,
      current: () => last,
      promote(file: string, sessionID: string) { last = { file, sessionID, revision: count }; return true; },
      discard: (file: string) => { removed.push(file); },
      hold: (_file: string) => () => {},
      forget(sessionID: string) { if (last?.sessionID === sessionID) last = undefined; },
      dispose() { last = undefined; },
    };
    const engine = Object.assign(() => { throw new Error("must generate an artifact"); }, {
      synthesize(text: string, _language: string, file: string) { generated.push(file); return h.spawn([], text); },
      play(file: string) { played.push(file); return h.spawn([], "player"); },
    });
    const sink = createSpeechSink({ engine, cache, player: engine.play, isPaused: () => paused, now: () => now } as any) as any;
    return { ...h, sink, cache, played, generated, removed, pause: (value: boolean) => { paused = value; }, time: (value: number) => { now = value; } };
  }

  test("replays the exact retained artifact without synthesizing, only for its session", async () => {
    const h = replayHarness();
    const first = h.sink(item("m", "Original voice and speed."));
    await tick();
    h.procs[0]!.finish();
    await tick();
    h.procs[1]!.finish();
    await first;
    await h.sink.repeat("other", 1);
    const repeat = h.sink.repeat("s", 1);
    await tick();
    expect(h.generated).toEqual(["wav-1"]);
    expect(h.played).toEqual(["wav-1", "wav-1"]);
    h.procs[2]!.finish();
    await repeat;
    await h.sink.dispose();
  });

  test("failed or cancelled generation retains prior audio; pause rejects queued replay", async () => {
    const h = replayHarness();
    h.cache.promote("old", "s");
    const first = h.sink(item("m", "New synthesis fails."));
    await tick();
    h.procs[0]!.finish(2);
    await first;
    expect(h.cache.current()?.file).toBe("old");
    const cancelled = h.sink(item("n", "Cancelled synthesis."));
    await tick();
    h.sink.stop();
    await cancelled;
    expect(h.cache.current()?.file).toBe("old");
    h.pause(true);
    await h.sink.repeat("s", 0);
    expect(h.played).toEqual([]);
    await h.sink.dispose();
  });

  test("repeat stops active playback and serializes restart; deletion and disposal retain no audio", async () => {
    const h = replayHarness();
    h.cache.promote("old", "s");
    const first = h.sink.repeat("s", 0);
    await tick();
    const restart = h.sink.repeat("s", 0);
    await tick();
    expect(h.procs[0]!.killed).toBe(true);
    expect(h.played).toEqual(["old", "old"]);
    h.sink.removeSession("s");
    await Promise.all([first, restart]);
    expect(h.cache.current()).toBeUndefined();
    await h.sink.dispose();
    await h.sink.repeat("s", 0);
    expect(h.played).toHaveLength(2);
  });

  test("stale generation after deletion cannot resurrect audio, and pause before restart consumes queued replay", async () => {
    const h = replayHarness();
    const pending = h.sink(item("m", "Deleted while generating."));
    await tick();
    h.sink.removeSession("s");
    await pending;
    expect(h.cache.current()).toBeUndefined();
    h.cache.promote("retained", "s");
    const first = h.sink.repeat("s", 1);
    await tick();
    const next = h.sink.repeat("s", 1);
    h.pause(true);
    await Promise.all([first, next]);
    h.pause(false);
    await tick();
    expect(h.played).toEqual(["retained"]);
    expect(h.cache.current()?.file).toBe("retained");
    await h.sink.dispose();
  });

  test("a replay expiring while the previous player closes is consumed without late playback", async () => {
    const h = replayHarness();
    h.cache.promote("old", "s");
    const first = h.sink.repeat("s", 0);
    await tick();
    h.procs[0]!.kill = () => { h.procs[0]!.killed = true; }; // Closing is controlled separately.
    const pending = h.sink.repeat("s", 0, 1500);
    h.time(2000);
    h.procs[0]!.finish(1);
    await Promise.all([first, pending]);
    expect(h.played).toEqual(["old"]);
    expect(h.cache.current()?.file).toBe("old");
    await h.sink.dispose();
  });
});
