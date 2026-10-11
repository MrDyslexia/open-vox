import { describe, expect, test } from "bun:test";
import { chooseEngine, createLiveSink, createOpenVox, watchPause, withPause } from "../src/plugin";
import { createConfigReader, DEFAULT_CONFIG } from "../src/config";
import type { SpeechProcess, SpeechSink } from "../src/speech-sink";
import { encodeCommand, decodeCommand } from "../src/repeat-control";

function fakeSink() {
  const spoken: string[] = [];
  let stops = 0;
  const sink = ((s: { text: string }) => { spoken.push(s.text); return Promise.resolve(); }) as unknown as SpeechSink;
  sink.stop = () => { stops++; };
  return { sink, spoken, stops: () => stops };
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
    const hooks = createOpenVox(client, "/d", f.sink, () => false, { instance: "instance-a", publish: async (s) => { replies.push(s); } });
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
});

describe("chooseEngine", () => {
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

describe("pause", () => {
  test("pausing stops current speech once and later events do not stop again", async () => {
    const f = fakeSink();
    let paused = false;
    const hooks = createOpenVox(client, "/d", f.sink, () => paused);
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_a" } } as any });
    expect(f.stops()).toBe(0);
    paused = true;
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_a" } } as any });
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_a" } } as any });
    expect(f.stops()).toBe(1);
    paused = false;
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_a" } } as any });
    paused = true;
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_a" } } as any });
    expect(f.stops()).toBe(2);
  });

  test("watchPause stops playing audio when pause flips on, without any host event", async () => {
    const f = fakeSink();
    let paused = false;
    const dispose = watchPause(f.sink, () => paused, 5);
    await Bun.sleep(30);
    expect(f.stops()).toBe(0);
    paused = true;
    await Bun.sleep(30);
    expect(f.stops()).toBe(1);
    await Bun.sleep(30);
    expect(f.stops()).toBe(1);
    paused = false;
    await Bun.sleep(30);
    paused = true;
    await Bun.sleep(30);
    expect(f.stops()).toBe(2);
    dispose();
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

