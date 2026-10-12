import { describe, expect, test } from "bun:test";
import { createSpeechSink, sapiEngine, playWav, type SpeechProcess, type Spawn } from "../src/speech-sink";
import { createNarrationPlan } from "../src/markdown-narration";

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
  test("plan preparation contains errors and stops that occur during parsing", async () => {
    const errors: unknown[] = [];
    const h = harness();
    const sink = createSpeechSink({ spawn: h.spawn, onError: e => errors.push(e),
      preparePlan: () => { throw new Error("parser failure"); } });
    await sink(item("m", "Original"));
    expect(errors).toHaveLength(1);
    expect(h.procs).toHaveLength(0);
    const raced = createSpeechSink({ spawn: h.spawn, preparePlan: (text, language) => {
      raced.stop(); return createNarrationPlan(text, language);
    } });
    await raced(item("n", "Cancelled during parsing"));
    expect(h.procs).toHaveLength(0);
  });
  test("reads configured base once per selection and passes untouched Unicode plan", async () => {
    const plans: any[] = [];
    let reads = 0;
    const engine = Object.assign(() => { throw new Error("legacy path"); }, {
      speakPlan(plan: any) { plans.push(plan); return { exited: Promise.resolve(0), kill() {} }; },
    });
    const sink = createSpeechSink({ engine, narrationLanguage: () => { reads++; return reads === 1 ? "es" : "en"; } });
    await sink(item("a", "😀 **é** Open editor API"));
    await sink(item("b", "Second"));
    expect(reads).toBe(2);
    expect(plans.map(p => p.defaultLanguage)).toEqual(["es", "en"]);
    expect(plans[0].original).toBe("😀 **é** Open editor API");
  });
  test("speaks derived structural text", async () => {
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
    let language: "es" | "en" = "en";
    const sink = createSpeechSink({ narrationLanguage: () => language,
      spawn: (args) => { calls.push(args); return { exited: Promise.resolve(0), kill() {} }; } });
    await sink(item("m1", "Here is the answer that you need for the project."));
    language = "es";
    await sink(item("m2", "Aquí está la respuesta que necesitas para el proyecto."));
    expect(calls[0]!.join(" ")).toContain("en");
    expect(calls[1]!.join(" ")).toContain("es");
  });

  test("skips messages that are empty after preparation", async () => {
    const h = harness();
    const sink = createSpeechSink({ spawn: h.spawn });
    await sink(item("m1", "<!-- omitted only -->"));
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
  function replayHarness(options: Record<string, unknown> = {}) {
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
    const sink = createSpeechSink({ engine, cache, player: engine.play, isPaused: () => paused, now: () => now, ...options } as any) as any;
    return { ...h, sink, cache, played, generated, removed, pause: (value: boolean) => { paused = value; }, time: (value: number) => { now = value; } };
  }

  test("plan-aware Repeat bypasses parser/resolver/inference callbacks; late cancelled success cannot promote", async () => {
    let parses = 0, syntheses = 0;
    const process = harness();
    const engine = Object.assign(() => { throw new Error("legacy"); }, {
      synthesizePlan: () => { syntheses++; return process.spawn([], "resolved/model mock"); },
    });
    const h = replayHarness({ engine, preparePlan: (text: string, language: "es" | "en") => {
      parses++; return createNarrationPlan(text, language);
    } });
    const first = h.sink(item("m", "API Open editor"));
    process.procs[0]!.finish();
    await tick(); h.procs[0]!.finish(); await first;
    const repeat = h.sink.repeat("s", 1);
    await tick(); h.procs[1]!.finish(); await repeat;
    expect([parses, syntheses]).toEqual([1, 1]);
    expect(h.played).toEqual(["wav-1", "wav-1"]);
    const stale = h.sink(item("n", "Cancelled new plan"));
    process.procs[1]!.kill = () => {};
    h.sink.stop(); process.procs[1]!.finish(0); await stale;
    expect(h.cache.current()?.file).toBe("wav-1");
    expect(h.removed).toContain("wav-2");
    await h.sink.dispose();
  });

  test("limit outcome is observable, fallback uses flattened bounded text and configured language", async () => {
    const seen: { text: string; language: string }[] = [], diagnostics: string[] = [];
    const sink = createSpeechSink({ maxLength: 12, narrationLanguage: "en", onDiagnostic: c => diagnostics.push(c),
      engine: (text, language) => { seen.push({ text, language }); return { exited: Promise.resolve(0), kill() {} }; } });
    await sink(item("a", "**hello** world additional text"));
    await sink(item("b", "short"));
    expect(seen[0]).toEqual({ text: "hello world", language: "en" });
    expect(diagnostics.filter(c => c.startsWith("reduced"))).toHaveLength(1);
    expect(diagnostics).toContain("narration-limit:truncated");
    expect(seen[0]!.text).not.toContain("schemaVersion");
  });

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

  function playbackTimeoutHarness(options: { timeoutMs: number; playbackTimeoutMs?: number }) {
    const players: Fake[] = [];
    const h = harness();
    const cache = {
      candidate: () => "wav-1", current: () => ({ file: "wav-1", sessionID: "s", revision: 1 }),
      promote: () => true, discard: () => {}, hold: () => () => {}, forget: () => {}, dispose: () => {},
    };
    const engine = Object.assign(() => { throw new Error("must generate an artifact"); }, {
      synthesize: () => ({ exited: Promise.resolve(0), kill() {} }),
    });
    const player = (_file: string) => { const proc = h.spawn([], "player"); players.push(h.procs.at(-1)!); return proc; };
    const sink = createSpeechSink({ engine, cache, player, ...options }) as any;
    return { sink, players };
  }

  test("playback is bounded by playbackTimeoutMs, separately from the synthesis timeout", async () => {
    const h = playbackTimeoutHarness({ timeoutMs: 20, playbackTimeoutMs: 200 });
    const pending = h.sink(item("m", "Long narration that outlasts the synthesis timeout."));
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.players[0]!.killed).toBe(false);
    h.players[0]!.finish();
    await pending;
    await h.sink.dispose();
  });

  test("playback falls back to timeoutMs when playbackTimeoutMs is not set", async () => {
    const h = playbackTimeoutHarness({ timeoutMs: 20 });
    await h.sink(item("m", "Hung player is killed by the default timeout."));
    expect(h.players[0]!.killed).toBe(true);
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

type Pausable = Fake & {
  pauses: number;
  resumes: number;
  /** Outcome of the next pause()/resume(): a boolean, "throw", "hang" (never settles) or a controlled promise. */
  pauseOutcome: boolean | "throw" | "hang" | Promise<boolean>;
  resumeOutcome: boolean | "throw" | "hang" | Promise<boolean>;
};

describe("real pause and resume", () => {
  const outcome = (value: Pausable["pauseOutcome"]): Promise<boolean> => {
    if (value === "hang") return new Promise<boolean>(() => {});
    if (value === "throw") return Promise.reject(new Error("host exploded"));
    return Promise.resolve(value);
  };

  function pausableProc(): Pausable {
    let done!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { done = resolve; });
    const proc = {
      stdin: "", killed: false, exited, pauses: 0, resumes: 0, pauseOutcome: true, resumeOutcome: true,
      kill() { proc.killed = true; done(1); },
      finish(code = 0) { done(code); },
      fail() {},
      pause() { proc.pauses++; return outcome(proc.pauseOutcome); },
      resume() { proc.resumes++; return outcome(proc.resumeOutcome); },
    } as unknown as Pausable;
    return proc;
  }

  /** A plain handle with only the original `SpeechProcess` contract (the SoundPlayer fallback path). */
  function plainProc(): Fake {
    let done!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { done = resolve; });
    const proc: Fake = {
      stdin: "", killed: false, exited,
      kill() { proc.killed = true; done(1); },
      finish(code = 0) { done(code); },
      fail() {},
    };
    return proc;
  }

  /** Cached sink whose player hands out pausable (or, with `pausable: false`, plain) playback handles. */
  function pauseHarness(options: Record<string, unknown> = {}, pausable = true) {
    const base = harness();
    const players: Fake[] = [];
    const errors: unknown[] = [];
    const holds = new Map<string, number>();
    let last: { file: string; sessionID: string; revision: number } | undefined;
    let paused = false;
    let count = 0;
    const cache = {
      candidate: () => `wav-${++count}`,
      current: () => last,
      promote(file: string, sessionID: string) { last = { file, sessionID, revision: count }; return true; },
      discard: () => {},
      hold(file: string) {
        holds.set(file, (holds.get(file) ?? 0) + 1);
        let released = false;
        return () => { if (!released) { released = true; holds.set(file, holds.get(file)! - 1); } };
      },
      forget(sessionID: string) { if (last?.sessionID === sessionID) last = undefined; },
      dispose() { last = undefined; },
    };
    const engine = Object.assign(() => { throw new Error("must generate an artifact"); }, {
      synthesize: (text: string, _language: string, _file: string) => base.spawn([], text),
    });
    const player = (_file: string) => {
      const proc = pausable ? pausableProc() : plainProc();
      players.push(proc);
      return proc;
    };
    const sink = createSpeechSink({
      engine, cache, player, isPaused: () => paused, onError: (e: unknown) => errors.push(e), ...options,
    } as any) as any;
    /** Mirrors the plugin: the paused flag flips first, then the matching sink method runs. */
    const setPaused = (value: boolean) => {
      paused = value;
      if (value) sink.pause?.(); else sink.resume?.();
    };
    /** Synthesizes and starts the cached playback of one narration. */
    async function startPlayback(text = "A narration that is playing right now.") {
      const narration = sink(item("m", text));
      await tick();
      base.procs[0]!.finish();                 // synthesis ends, playback starts
      await tick();
      return { narration, playback: players[0] as Pausable };
    }
    return { sink, base, players, errors, holds, cache, setPaused, startPlayback, isPaused: () => paused };
  }
  const settled = (promise: Promise<unknown>) =>
    Promise.race([promise.then(() => "settled"), new Promise((resolve) => setTimeout(() => resolve("pending"), 25))]);
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test("pause freezes the active playback: no kill, job pending, hold kept, backstop silent", async () => {
    const h = pauseHarness({ timeoutMs: 20, playbackTimeoutMs: 20 });
    const { narration, playback } = await h.startPlayback();
    h.setPaused(true);
    await tick();
    expect(playback.pauses).toBe(1);
    await wait(80);                                               // 4x the backstop while frozen
    expect(playback.killed).toBe(false);
    expect(await settled(narration)).toBe("pending");
    expect(h.holds.get("wav-1")).toBe(1);
    expect(h.errors).toEqual([]);
    h.sink.stop();
    await narration;
    await h.sink.dispose();
  });

  test("resume continues the same playback to completion and releases the hold afterwards", async () => {
    const h = pauseHarness();
    const { narration, playback } = await h.startPlayback();
    h.setPaused(true);
    await tick();
    h.setPaused(false);
    await tick();
    expect(playback.resumes).toBe(1);
    expect(playback.killed).toBe(false);
    expect(h.players).toHaveLength(1);
    playback.finish();
    await narration;
    expect(h.holds.get("wav-1")).toBe(0);
    expect(h.errors).toEqual([]);
    await h.sink.dispose();
  });

  test("plan-aware paused transport keeps its exact old artifact and cancels queued preparation without new synthesis", async () => {
    let parses = 0;
    const h = pauseHarness({ preparePlan: (text: string, language: "es" | "en") => {
      parses++; return createNarrationPlan(text, language);
    } });
    const { narration, playback } = await h.startPlayback("API Open editor");
    const queued = h.sink(item("next", "A queued new plan"));
    h.setPaused(true); await queued; await tick();
    expect(h.holds.get("wav-1")).toBe(1);
    expect(h.cache.current()?.file).toBe("wav-1");
    h.setPaused(false); await tick();
    expect(playback.resumes).toBe(1);
    expect(h.base.procs).toHaveLength(1);
    expect(parses).toBe(2);
    playback.finish(); await narration;
    expect(h.holds.get("wav-1")).toBe(0);
    await h.sink.dispose();
  });

  test("resume re-arms the backstop and the paused time is not counted", async () => {
    const h = pauseHarness({ timeoutMs: 40, playbackTimeoutMs: 40 });
    const { narration, playback } = await h.startPlayback();
    h.setPaused(true);
    await wait(90);                                               // longer than the backstop
    h.setPaused(false);
    await tick();
    expect(playback.killed).toBe(false);                          // paused time is forgiven
    await wait(90);
    expect(playback.killed).toBe(true);                           // but a hung playback is still bounded
    await narration;
    await h.sink.dispose();
  });

  test("jobs queued at the moment of pause are cancelled", async () => {
    const h = pauseHarness({ maxPending: 2 });
    const { narration, playback } = await h.startPlayback();
    const queued = h.sink(item("n", "Queued narration that never started."));
    h.setPaused(true);
    await queued;                                                 // resolved by the cancellation
    h.setPaused(false);
    await tick();
    playback.finish();
    await narration;
    await tick();
    expect(h.base.procs).toHaveLength(1);                         // no second synthesis
    expect(h.players).toHaveLength(1);
    await h.sink.dispose();
  });

  test("a synthesis in flight is cancelled on pause (nothing to hold yet)", async () => {
    const h = pauseHarness();
    const narration = h.sink(item("m", "Still being synthesized when paused."));
    await tick();
    h.setPaused(true);
    await narration;
    expect(h.base.procs[0]!.killed).toBe(true);
    expect(h.players).toHaveLength(0);
    h.setPaused(false);                                           // resume with nothing paused
    await tick();
    expect(h.cache.current()).toBeUndefined();
    await h.sink.dispose();
  });

  test("the fallback (non-pausable) playback is stopped on pause and resume is a no-op", async () => {
    const h = pauseHarness({}, false);
    const { narration, playback } = await h.startPlayback();
    h.setPaused(true);
    await narration;
    expect(playback.killed).toBe(true);
    expect(h.holds.get("wav-1")).toBe(0);
    h.setPaused(false);
    await tick();
    expect(h.players).toHaveLength(1);                            // resume did not start anything
    expect(h.errors).toEqual([]);
    await h.sink.dispose();
  });

  test("a handle that declines to pause (returns false) is stopped", async () => {
    const h = pauseHarness();
    const { narration, playback } = await h.startPlayback();
    playback.pauseOutcome = false;
    h.setPaused(true);
    await narration;
    expect(playback.killed).toBe(true);
    expect(h.holds.get("wav-1")).toBe(0);
    await h.sink.dispose();
  });

  test.each(["hang", "throw"] as const)("a pause that answers %s degrades to stop and never hangs the queue", async (mode) => {
    const h = pauseHarness({ pauseTimeoutMs: 20 });
    const { narration, playback } = await h.startPlayback();
    playback.pauseOutcome = mode;
    h.setPaused(true);
    await narration;
    expect(playback.killed).toBe(true);
    expect(h.holds.get("wav-1")).toBe(0);
    expect(h.errors).toHaveLength(1);
    expect(String((h.errors[0] as Error).message)).not.toContain("wav-1");
    h.setPaused(false);
    const again = h.sink(item("n", "The queue keeps working afterwards."));
    await tick();
    h.base.procs[1]!.finish();
    await tick();
    h.players[1]!.finish();
    await again;
    await h.sink.dispose();
  });

  test.each(["hang", "throw", false] as const)("a resume that answers %s degrades to stop", async (mode) => {
    const h = pauseHarness({ pauseTimeoutMs: 20 });
    const { narration, playback } = await h.startPlayback();
    playback.resumeOutcome = mode;
    h.setPaused(true);
    await tick();
    h.setPaused(false);
    await narration;
    expect(playback.killed).toBe(true);
    expect(h.holds.get("wav-1")).toBe(0);
    expect(h.errors).toHaveLength(1);
    await h.sink.dispose();
  });

  test("resume issued before the pause is acknowledged runs after it, in order", async () => {
    const h = pauseHarness();
    const { narration, playback } = await h.startPlayback();
    let acknowledge!: (value: boolean) => void;
    playback.pauseOutcome = new Promise<boolean>((resolve) => { acknowledge = resolve; });
    h.setPaused(true);
    h.setPaused(false);
    await tick();
    expect(playback.resumes).toBe(0);
    acknowledge(true);
    await tick();
    expect(playback.resumes).toBe(1);
    expect(playback.killed).toBe(false);
    playback.finish();
    await narration;
    await h.sink.dispose();
  });

  test("stop while paused discards the audio and releases the hold, but the instance stays paused", async () => {
    const h = pauseHarness();
    const { narration, playback } = await h.startPlayback();
    h.setPaused(true);
    await tick();
    h.sink.stop();                                                // new user turn, session.error, ...
    await narration;
    expect(playback.killed).toBe(true);
    expect(h.holds.get("wav-1")).toBe(0);
    expect(h.isPaused()).toBe(true);
    await h.sink(item("n", "Rejected because the instance is still paused."));
    expect(h.base.procs).toHaveLength(1);
    h.setPaused(false);                                           // nothing paused any more: harmless
    await tick();
    expect(playback.resumes).toBe(0);
    expect(h.errors).toEqual([]);
    await h.sink.dispose();
  });

  test("pausing twice sends one request to the handle", async () => {
    const h = pauseHarness();
    const { narration, playback } = await h.startPlayback();
    h.sink.pause();
    h.sink.pause();
    await tick();
    h.sink.pause();
    await tick();
    expect(playback.pauses).toBe(1);
    expect(playback.killed).toBe(false);
    h.sink.stop();
    await narration;
    await h.sink.dispose();
  });

  test("stop right after pause discards the playback at once: hold released and the late acknowledgement timeout reports nothing", async () => {
    const h = pauseHarness({ pauseTimeoutMs: 20 });
    const { narration, playback } = await h.startPlayback();
    playback.pauseOutcome = "hang";
    h.setPaused(true);                                            // acknowledgement now pending
    h.sink.stop();                                                // ...and the user starts a new turn at once
    await narration;
    expect(playback.killed).toBe(true);
    expect(h.holds.get("wav-1")).toBe(0);
    await wait(80);                                               // far beyond pauseTimeoutMs
    expect(h.errors).toEqual([]);
    await h.sink.dispose();
  });

  test("an acknowledgement that arrives after the pause was given up does not revive the playback", async () => {
    const h = pauseHarness({ pauseTimeoutMs: 15 });
    const { narration, playback } = await h.startPlayback();
    let late!: (value: boolean) => void;
    playback.pauseOutcome = new Promise<boolean>((resolve) => { late = resolve; });
    h.setPaused(true);
    await narration;                                              // degraded to stop after pauseTimeoutMs
    expect(playback.killed).toBe(true);
    expect(h.errors).toHaveLength(1);
    late(true);
    await tick();
    h.setPaused(false);
    await tick();
    expect(playback.resumes).toBe(0);
    expect(h.errors).toHaveLength(1);
    expect(h.holds.get("wav-1")).toBe(0);
    await h.sink.dispose();
  });

  test("dispose while the pause acknowledgement is pending stops the playback and reports nothing later", async () => {
    const h = pauseHarness({ pauseTimeoutMs: 20 });
    const { narration, playback } = await h.startPlayback();
    playback.pauseOutcome = "hang";
    h.setPaused(true);
    await h.sink.dispose();
    await narration;
    expect(playback.killed).toBe(true);
    await wait(60);
    expect(h.errors).toEqual([]);
  });

  test("removing the owning session while paused discards the paused playback", async () => {
    const h = pauseHarness();
    const { narration, playback } = await h.startPlayback();
    h.setPaused(true);
    await tick();
    h.sink.removeSession("s");
    await narration;
    expect(playback.killed).toBe(true);
    expect(h.holds.get("wav-1")).toBe(0);
    expect(h.sink.status()).toBeUndefined();
    await h.sink.dispose();
  });

  test("dispose while paused stops the playback cleanly and releases the hold", async () => {
    const h = pauseHarness({ timeoutMs: 20, playbackTimeoutMs: 20 });
    const { narration, playback } = await h.startPlayback();
    h.setPaused(true);
    await tick();
    await h.sink.dispose();
    await narration;
    expect(playback.killed).toBe(true);
    expect(h.holds.get("wav-1")).toBe(0);
  });

  test("pause and resume keep the revision, never synthesize, and gate Repeat only through the paused flag", async () => {
    const h = pauseHarness();
    const { narration, playback } = await h.startPlayback();
    const before = h.sink.status();
    expect(before).toEqual({ sessionID: "s", revision: 1 });
    h.setPaused(true);
    await tick();
    await h.sink.repeat("s", 1);                                  // disabled while paused
    expect(h.players).toHaveLength(1);
    expect(h.sink.status()).toEqual(before);
    h.setPaused(false);
    await tick();
    expect(h.sink.status()).toEqual(before);
    expect(h.base.procs).toHaveLength(1);                         // still the one original synthesis
    playback.finish();
    await narration;
    const repeat = h.sink.repeat("s", 1);                         // available again after resume
    await tick();
    expect(h.players).toHaveLength(2);
    expect(h.base.procs).toHaveLength(1);
    h.players[1]!.finish();
    await repeat;
    await h.sink.dispose();
  });

  test("pause with nothing playing only cancels queued work and never throws", async () => {
    const h = pauseHarness();
    expect(() => h.setPaused(true)).not.toThrow();
    expect(() => h.setPaused(false)).not.toThrow();
    expect(h.players).toHaveLength(0);
    await h.sink.dispose();
  });
});
