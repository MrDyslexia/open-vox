import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenVoxPlugin, chooseEngine, createLiveSink, createOpenVox, createPauseState, liveEngine, withPause } from "../src/plugin";
import { createNarrationPlan } from "../src/markdown-narration";
import { createConfigReader, DEFAULT_CONFIG } from "../src/config";
import type { SpeechProcess, SpeechSink } from "../src/speech-sink";
import { encodeCommand, decodeCommand } from "../src/repeat-control";

function fakeSink() {
  const spoken: string[] = [];
  let stops = 0, pauses = 0, resumes = 0;
  const sink = ((s: { text: string }) => { spoken.push(s.text); return Promise.resolve(); }) as unknown as SpeechSink;
  sink.stop = () => { stops++; };
  sink.pause = () => { pauses++; };
  sink.resume = () => { resumes++; };
  return { sink, spoken, stops: () => stops, pauses: () => pauses, resumes: () => resumes };
}
const client = { session: { get: async () => ({ error: "x" }), message: async () => ({ error: "x" }) } } as any;
const user = (id: string, created: number) => ({ type: "message.updated", properties: { info: { id, sessionID: "ses_a", role: "user", time: { created } } } }) as any;

describe("open-vox wiring", () => {
  test("host command bridge replies via injected attached publisher, removes owned session and disposes once", async () => {
    const f = fakeSink();
    const replies: string[] = [], removals: string[] = [];
    let disposals = 0, repeats = 0;
    f.sink.status = () => ({ sessionID: "ses_a", revision: 1 });
    f.sink.repeat = async () => { repeats++; };
    f.sink.removeSession = (id) => { removals.push(id); };
    f.sink.dispose = async () => { disposals++; };
    const hooks = createOpenVox(client, "/d", f.sink, undefined, { instance: "instance-a", publish: async (s) => { replies.push(s); } });
    const event = (m: any) => ({ event: { type: "tui.command.execute", properties: { command: encodeCommand(m) } } } as any);
    await hooks.event!(event({ kind: "hello", challenge: "challenge", sessionID: "ses_a", expires: Date.now() + 1500 }));
    expect(decodeCommand(replies[0])?.instance).toBe("instance-a");
    expect(f.stops()).toBe(0);
    await hooks.event!(event({ kind: "repeat", instance: "instance-a", sessionID: "ses_a", revision: 1, requestID: "one", expires: Date.now() + 1500 }));
    expect(repeats).toBe(1);
    await hooks.event!({ event: { type: "session.deleted", properties: { info: { id: "ses_a" } } } } as any);
    expect(removals).toEqual(["ses_a"]);
    await hooks.dispose!(); await hooks.dispose!();
    expect(disposals).toBe(1);
    await hooks.event!(event({ kind: "hello", challenge: "late", sessionID: "ses_a", expires: Date.now() + 1500 }));
    expect(replies).toHaveLength(1);
  });
  test("a new user turn stops current speech", async () => {
    const f = fakeSink();
    const hooks = createOpenVox(client, "/d", f.sink);
    await hooks.event!({ event: user("msg_1", 1) });
    expect(f.stops()).toBe(1);
  });

  test("a repeated update of the same user message does not stop speech", async () => {
    const f = fakeSink();
    const hooks = createOpenVox(client, "/d", f.sink);
    await hooks.event!({ event: user("msg_1", 1) });
    await hooks.event!({ event: user("msg_1", 1) });
    expect(f.stops()).toBe(1);
  });

  test("session.error stops current speech", async () => {
    const f = fakeSink();
    const hooks = createOpenVox(client, "/d", f.sink);
    await hooks.event!({ event: { type: "session.error", properties: { sessionID: "ses_a" } } as any });
    expect(f.stops()).toBe(1);
  });

  test("unrelated events do not stop speech", async () => {
    const f = fakeSink();
    const hooks = createOpenVox(client, "/d", f.sink);
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_a" } } as any });
    expect(f.stops()).toBe(0);
  });

  test("a throwing stop never escapes the hook", async () => {
    const f = fakeSink();
    f.sink.stop = () => { throw new Error("x"); };
    const hooks = createOpenVox(client, "/d", f.sink);
    await hooks.event!({ event: user("msg_1", 1) });
  });
});

describe("live sink player wiring", () => {
  const cache = {
    candidate: () => "unused.wav", current: () => ({ file: "kept.wav", sessionID: "ses_a", revision: 1 }),
    promote: () => true, discard: () => {}, hold: () => () => {}, forget: () => {}, dispose: () => {},
  };
  const config = () => createConfigReader(() => DEFAULT_CONFIG, 0);

  test("cached audio is played through the injected player", async () => {
    const played: string[] = [];
    const player = (file: string): SpeechProcess => { played.push(file); return { exited: Promise.resolve(0), kill() {} }; };
    const sink = createLiveSink({}, config(), () => {}, true, { cache, isPaused: () => false, player });
    await sink.repeat!("ses_a", 1);
    expect(played).toEqual(["kept.wav"]);
    await sink.dispose!();
  });

  test("the player backstop replaces the 120 s process timeout for playback", async () => {
    let close!: (code: number) => void;
    const proc = { killed: false, kill() { proc.killed = true; close(1); }, exited: new Promise<number>((resolve) => { close = resolve; }) };
    const sink = createLiveSink({}, config(), () => {}, true, { cache, isPaused: () => false, player: () => proc, playbackTimeoutMs: 15 });
    const replay = sink.repeat!("ses_a", 1);
    await Bun.sleep(40);
    expect(proc.killed).toBe(true);
    await replay;
    await sink.dispose!();
  });

  test("the live sink forwards pause and resume to the capabilities of the injected player handle", async () => {
    let close!: (code: number) => void;
    const calls: string[] = [];
    const handle = {
      exited: new Promise<number>((resolve) => { close = resolve; }),
      kill() { calls.push("kill"); close(1); },
      pause: async () => { calls.push("pause"); return true; },
      resume: async () => { calls.push("resume"); return true; },
    };
    let paused = false;
    const sink = createLiveSink({}, config(), () => {}, true, { cache, isPaused: () => paused, player: () => handle });
    const replay = sink.repeat!("ses_a", 1);
    await Bun.sleep(5);
    paused = true; sink.pause!();
    await Bun.sleep(5);
    paused = false; sink.resume!();
    await Bun.sleep(5);
    expect(calls).toEqual(["pause", "resume"]);
    close(0);
    await replay;
    await sink.dispose!();
  });
});

describe("chooseEngine", () => {
  test("plan dispatch selects the actual engine at execution and text fallback never receives JSON", async () => {
    const seen: string[] = [], diagnostics: string[] = [];
    const done = { exited: Promise.resolve(0), kill() {} };
    const kokoro = Object.assign(() => done, { synthesizePlan: (p: any) => { seen.push(`plan:${p.defaultLanguage}`); return done; } });
    const piper = Object.assign(() => done, { synthesize: (text: string, language: string) => { seen.push(`${language}:${text}`); return done; } });
    let wanted = "kokoro";
    const engine = liveEngine(() => wanted, { kokoro: () => kokoro, piper: () => piper }, piper, undefined, c => diagnostics.push(c));
    const plan = createNarrationPlan("**API** Open editor", "es");
    wanted = "piper";
    await engine.synthesizePlan!(plan, "candidate").exited;
    await engine.synthesizePlan!(plan, "candidate").exited;
    wanted = "kokoro";
    await engine.synthesizePlan!(plan, "candidate").exited;
    expect(seen).toEqual(["es:API Open editor", "es:API Open editor", "plan:es"]);
    expect(diagnostics).toEqual(["reduced-pronunciation:text-only-engine"]);
  });
  const kokoro = () => ({ exited: Promise.resolve(0), kill() {} });
  const mk = (k: boolean, p: boolean) => ({ kokoro: () => (k ? kokoro : undefined), piper: () => (p ? kokoro : undefined) });
  test("auto prefers kokoro, then piper, then sapi", () => {
    expect(chooseEngine("auto", true, mk(true, true)).name).toBe("kokoro");
    expect(chooseEngine("auto", true, mk(false, true)).name).toBe("piper");
    expect(chooseEngine("auto", true, mk(false, false)).name).toBe("sapi");
  });
  test("an explicit engine is honored and falls back when missing", () => {
    expect(chooseEngine("piper", true, mk(true, true)).name).toBe("piper");
    expect(chooseEngine("kokoro", true, mk(false, true)).name).toBe("piper");
    expect(chooseEngine("sapi", true, mk(true, true)).name).toBe("sapi");
  });
  test("disabled never builds an engine", () => {
    expect(chooseEngine("auto", false, mk(true, true)).engine).toBeUndefined();
  });
});

const idle = { event: { type: "session.idle", properties: { sessionID: "ses_a" } } as any };

/** One fake plugin instance: its own sink, pause state and attached publisher. */
function instance(nonce: string) {
  const f = fakeSink();
  const replies: string[] = [];
  let repeats = 0;
  f.sink.status = () => ({ sessionID: "ses_a", revision: 1 });
  f.sink.repeat = async () => { repeats++; };
  const pause = createPauseState(() => f.sink.pause?.(), () => f.sink.resume?.());
  const sink = withPause(f.sink, pause.isPaused);
  const hooks = createOpenVox(client, "/d", sink, pause, { instance: nonce, publish: async (s) => { replies.push(s); } });
  const command = (m: any) => ({ event: { type: "tui.command.execute", properties: { command: encodeCommand(m) } } } as any);
  const control = (action: string, requestID: string, target = nonce) => hooks.event!(command({
    kind: "control", instance: target, sessionID: "ses_a", requestID, action, expires: Date.now() + 1500 }));
  const status = async () => {
    await hooks.event!(command({ kind: "hello", challenge: `c-${replies.length}`, sessionID: "ses_a", expires: Date.now() + 1500 }));
    return decodeCommand(replies.at(-1)!);
  };
  return { f, sink, hooks, pause, control, status, command, replies, repeats: () => repeats };
}

describe("pause state", () => {
  test("setPaused fires onPause exactly once per false->true edge and never on resume or repeats", () => {
    let pauses = 0;
    const pause = createPauseState(() => { pauses++; });
    expect(pause.isPaused()).toBe(false);
    pause.setPaused(false);
    expect(pauses).toBe(0);
    pause.setPaused(true); pause.setPaused(true);
    expect(pause.isPaused()).toBe(true);
    expect(pauses).toBe(1);
    pause.setPaused(false);
    expect(pause.isPaused()).toBe(false);
    expect(pauses).toBe(1);
    pause.setPaused(true);
    expect(pauses).toBe(2);
  });

  test("onResume fires exactly once per true->false edge, with the state already resumed", () => {
    const edges: string[] = [];
    const seen: boolean[] = [];
    const pause: ReturnType<typeof createPauseState> = createPauseState(
      () => { edges.push("pause"); },
      () => { edges.push("resume"); seen.push(pause.isPaused()); },
    );
    pause.setPaused(false);                                 // no edge
    expect(edges).toEqual([]);
    pause.setPaused(true); pause.setPaused(true);
    pause.setPaused(false); pause.setPaused(false);
    pause.setPaused(true);
    pause.setPaused(false);
    expect(edges).toEqual(["pause", "resume", "pause", "resume"]);
    expect(seen).toEqual([false, false]);
  });

  test("the state is already paused when the pause callback runs, and throwing callbacks are contained", () => {
    const seen: boolean[] = [];
    const pause: ReturnType<typeof createPauseState> = createPauseState(
      () => { seen.push(pause.isPaused()); throw new Error("x"); },
      () => { throw new Error("y"); },
    );
    pause.setPaused(true);
    expect(seen).toEqual([true]);
    expect(pause.isPaused()).toBe(true);
    pause.setPaused(false);
    expect(pause.isPaused()).toBe(false);
  });
});

describe("pause", () => {
  test("a pause control pauses the sink once without stopping it; resume resumes it once; host events do not repeat either", async () => {
    const a = instance("instance-a");
    expect((await a.status())?.paused).toBe(false);
    await a.hooks.event!(idle);
    expect([a.f.pauses(), a.f.resumes(), a.f.stops()]).toEqual([0, 0, 0]);
    await a.control("pause", "p1");
    expect([a.f.pauses(), a.f.resumes(), a.f.stops()]).toEqual([1, 0, 0]);
    expect((await a.status())?.paused).toBe(true);
    await a.hooks.event!(idle); await a.hooks.event!(idle);
    await a.control("pause", "p2");
    expect([a.f.pauses(), a.f.stops()]).toEqual([1, 0]);
    await a.control("resume", "r1");
    expect([a.f.pauses(), a.f.resumes(), a.f.stops()]).toEqual([1, 1, 0]);
    expect((await a.status())?.paused).toBe(false);
    await a.control("resume", "r2");
    expect(a.f.resumes()).toBe(1);
    await a.hooks.event!(idle);
    await a.control("pause", "p3");
    expect([a.f.pauses(), a.f.resumes(), a.f.stops()]).toEqual([2, 1, 0]);
    await a.hooks.dispose!();
  });

  test("a new user turn while paused discards the paused audio through stop, and the instance stays paused", async () => {
    const a = instance("instance-a");
    await a.control("pause", "p1");
    await a.hooks.event!({ event: user("msg_1", 1) });
    expect(a.f.stops()).toBe(1);
    expect(a.f.pauses()).toBe(1);
    expect((await a.status())?.paused).toBe(true);
    await a.sink({ sessionID: "ses_a", messageID: "m", text: "still blocked" });
    expect(a.f.spoken).toEqual([]);
    await a.hooks.event!({ event: { type: "session.error", properties: { sessionID: "ses_a" } } as any });
    expect(a.f.stops()).toBe(2);
    expect(a.pause.isPaused()).toBe(true);
    await a.control("resume", "r1");                         // the sink decides that nothing is left to resume
    expect(a.f.resumes()).toBe(1);
    expect((await a.status())?.paused).toBe(false);
    await a.hooks.dispose!();
  });

  test("the default pause state of createOpenVox pauses and resumes the sink, and falls back to stop for sinks without pause", async () => {
    const f = fakeSink();
    const replies: string[] = [];
    const hooks = createOpenVox(client, "/d", f.sink, undefined, { instance: "instance-d", publish: async (s) => { replies.push(s); } });
    const send = (action: string, id: string) => hooks.event!({ event: { type: "tui.command.execute", properties: { command: encodeCommand({
      kind: "control", instance: "instance-d", sessionID: "ses_a", requestID: id, action, expires: Date.now() + 1500 } as any) } } } as any);
    await send("pause", "p1");
    await send("resume", "r1");
    expect([f.pauses(), f.resumes(), f.stops()]).toEqual([1, 1, 0]);
    await hooks.dispose!();

    const legacy = fakeSink();
    delete legacy.sink.pause; delete legacy.sink.resume;
    const old = createOpenVox(client, "/d", legacy.sink, undefined, { instance: "instance-e", publish: async () => {} });
    await old.event!({ event: { type: "tui.command.execute", properties: { command: encodeCommand({
      kind: "control", instance: "instance-e", sessionID: "ses_a", requestID: "p1", action: "pause", expires: Date.now() + 1500 } as any) } } } as any);
    expect(legacy.stops()).toBe(1);
    await old.dispose!();
  });

  test("withPause forwards pause and resume untouched, even while paused", () => {
    const f = fakeSink();
    const sink = withPause(f.sink, () => true);
    sink.pause?.(); sink.resume?.();
    expect([f.pauses(), f.resumes(), f.stops()]).toEqual([1, 1, 0]);
  });

  test("while paused new narrations and Repeat are blocked; resume allows them again", async () => {
    const a = instance("instance-a");
    const revision = (await a.status())!.revision!;
    const repeat = (id: string) => a.hooks.event!(a.command({ kind: "repeat", instance: "instance-a", sessionID: "ses_a", revision, requestID: id, expires: Date.now() + 1500 }));
    await a.control("pause", "p1");
    await a.sink({ sessionID: "ses_a", messageID: "m", text: "hola" });
    await repeat("rep-paused");
    await a.sink.repeat!("ses_a", revision);
    expect(a.f.spoken).toEqual([]);
    expect(a.repeats()).toBe(0);
    await a.control("resume", "r1");
    await a.sink({ sessionID: "ses_a", messageID: "m", text: "hola" });
    await repeat("rep-ok");
    expect(a.f.spoken).toEqual(["hola"]);
    expect(a.repeats()).toBe(1);
    await a.hooks.dispose!();
  });

  test("control requests are ignored when stale, repeated, malformed or for another instance", async () => {
    const a = instance("instance-a");
    await a.control("pause", "x1", "instance-b");
    await a.hooks.event!(a.command({ kind: "control", instance: "instance-a", sessionID: "ses_a", requestID: "x2", action: "toggle", expires: Date.now() + 1500 }));
    await a.hooks.event!(a.command({ kind: "control", instance: "instance-a", sessionID: "ses_a", requestID: "x3", action: "pause", expires: Date.now() - 1 }));
    expect((await a.status())?.paused).toBe(false);
    expect(a.f.stops()).toBe(0);
    await a.control("pause", "dup");
    await a.control("resume", "dup");
    expect((await a.status())?.paused).toBe(true);
    await a.hooks.dispose!();
    await a.control("resume", "late");
    expect(a.pause.isPaused()).toBe(true);
  });

  test("two instances with different nonces never affect each other", async () => {
    const a = instance("instance-a"), b = instance("instance-b");
    const deliver = async (action: string, id: string, target: string) => { await a.control(action, id, target); await b.control(action, id, target); };
    await deliver("pause", "p1", "instance-a");
    expect((await a.status())?.paused).toBe(true);
    expect((await b.status())?.paused).toBe(false);
    expect([a.f.pauses(), b.f.pauses()]).toEqual([1, 0]);
    expect([a.f.stops(), b.f.stops()]).toEqual([0, 0]);
    await b.sink({ sessionID: "ses_a", messageID: "m", text: "b speaks" });
    await a.sink({ sessionID: "ses_a", messageID: "m", text: "a silent" });
    expect(b.f.spoken).toEqual(["b speaks"]);
    expect(a.f.spoken).toEqual([]);
    await deliver("pause", "p2", "instance-b");
    await deliver("resume", "r1", "instance-a");
    expect([(await a.status())?.paused, (await b.status())?.paused]).toEqual([false, true]);
    expect([a.f.resumes(), b.f.resumes()]).toEqual([1, 0]);
    expect([a.f.pauses(), b.f.pauses()]).toEqual([1, 1]);
    await a.hooks.dispose!(); await b.hooks.dispose!();
  });


  test("withPause skips speaking while paused and passes through otherwise", async () => {
    const f = fakeSink();
    let paused = true;
    const sink = withPause(f.sink, () => paused);
    await sink({ sessionID: "s", messageID: "m", text: "hola" });
    expect(f.spoken).toEqual([]);
    paused = false;
    await sink({ sessionID: "s", messageID: "m", text: "hola" });
    expect(f.spoken).toEqual(["hola"]);
    sink.stop();
    expect(f.stops()).toBe(1);
  });
});

describe("plugin entry point", () => {
  async function withPluginEnv<T>(configJson: string | undefined, run: (home: string) => Promise<T>): Promise<T> {
    const home = mkdtempSync(join(tmpdir(), "open-vox-p2-"));
    const saved = { disabled: process.env.OPEN_VOX_DISABLED, home: process.env.OPEN_VOX_HOME };
    if (configJson !== undefined) writeFileSync(join(home, "config.json"), configJson);
    process.env.OPEN_VOX_DISABLED = "1"; process.env.OPEN_VOX_HOME = home;
    try { return await run(home); }
    finally {
      for (const [key, value] of [["OPEN_VOX_DISABLED", saved.disabled], ["OPEN_VOX_HOME", saved.home]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  }
  const boot = async () => {
    const replies: string[] = [];
    const tui = { publish: async (input: any) => { replies.push(input.body.properties.command); return { data: true }; } };
    const hooks = await OpenVoxPlugin({ client: { ...client, tui }, directory: "/d" } as any) as any;
    const send = (m: any) => hooks.event({ event: { type: "tui.command.execute", properties: { command: encodeCommand(m) } } });
    const status = async () => {
      await send({ kind: "hello", challenge: `c-${replies.length}`, sessionID: "ses_a", expires: Date.now() + 1500 });
      return decodeCommand(replies.at(-1)!)!;
    };
    return { hooks, send, status };
  };

  test("pause lives in memory: a legacy paused key is ignored and never rewritten, and no timers exist", async () => {
    const legacy = JSON.stringify({ paused: true, speed: 1.2 });
    await withPluginEnv(legacy, async (home) => {
      const intervals: unknown[] = [], original = globalThis.setInterval;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
        const timer = original(...args); intervals.push(timer); return timer;
      }) as typeof setInterval;
      try {
        const p = await boot();
        const first = await p.status();
        expect(first.paused).toBe(false);
        await p.send({ kind: "control", instance: first.instance, sessionID: "ses_a", requestID: "p1", action: "pause", expires: Date.now() + 1500 });
        expect((await p.status()).paused).toBe(true);
        await p.send({ kind: "control", instance: first.instance, sessionID: "ses_a", requestID: "r1", action: "resume", expires: Date.now() + 1500 });
        expect((await p.status()).paused).toBe(false);
        await p.hooks.dispose();
      } finally { globalThis.setInterval = original; }
      expect(intervals).toHaveLength(0);
      expect(readFileSync(join(home, "config.json"), "utf8")).toBe(legacy);
    });
  });

  test("two plugin instances stay isolated even when they receive the same control event", async () => {
    await withPluginEnv(undefined, async () => {
      const a = await boot(), b = await boot();
      const [sa, sb] = [await a.status(), await b.status()];
      expect(sa.instance).not.toBe(sb.instance);
      const pause = { kind: "control", instance: sa.instance, sessionID: "ses_a", requestID: "p1", action: "pause", expires: Date.now() + 1500 };
      await a.send(pause); await b.send(pause);
      expect([(await a.status()).paused, (await b.status()).paused]).toEqual([true, false]);
      await a.hooks.dispose(); await b.hooks.dispose();
    });
  });
});
