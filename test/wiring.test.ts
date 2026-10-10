import { describe, expect, test } from "bun:test";
import { chooseEngine, createAgentVoz } from "../src/plugin";
import type { SpeechSink } from "../src/speech-sink";

function fakeSink() {
  const spoken: string[] = [];
  let stops = 0;
  const sink = ((s: { text: string }) => { spoken.push(s.text); return Promise.resolve(); }) as unknown as SpeechSink;
  sink.stop = () => { stops++; };
  return { sink, spoken, stops: () => stops };
}
const client = { session: { get: async () => ({ error: "x" }), message: async () => ({ error: "x" }) } } as any;
const user = (id: string, created: number) => ({ type: "message.updated", properties: { info: { id, sessionID: "ses_a", role: "user", time: { created } } } }) as any;

describe("agentVoz wiring", () => {
  test("a new user turn stops current speech", async () => {
    const f = fakeSink();
    const hooks = createAgentVoz(client, "/d", f.sink);
    await hooks.event!({ event: user("msg_1", 1) });
    expect(f.stops()).toBe(1);
  });

  test("a repeated update of the same user message does not stop speech", async () => {
    const f = fakeSink();
    const hooks = createAgentVoz(client, "/d", f.sink);
    await hooks.event!({ event: user("msg_1", 1) });
    await hooks.event!({ event: user("msg_1", 1) });
    expect(f.stops()).toBe(1);
  });

  test("session.error stops current speech", async () => {
    const f = fakeSink();
    const hooks = createAgentVoz(client, "/d", f.sink);
    await hooks.event!({ event: { type: "session.error", properties: { sessionID: "ses_a" } } as any });
    expect(f.stops()).toBe(1);
  });

  test("unrelated events do not stop speech", async () => {
    const f = fakeSink();
    const hooks = createAgentVoz(client, "/d", f.sink);
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_a" } } as any });
    expect(f.stops()).toBe(0);
  });

  test("a throwing stop never escapes the hook", async () => {
    const f = fakeSink();
    f.sink.stop = () => { throw new Error("x"); };
    const hooks = createAgentVoz(client, "/d", f.sink);
    await hooks.event!({ event: user("msg_1", 1) });
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
