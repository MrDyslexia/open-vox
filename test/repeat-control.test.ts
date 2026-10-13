import { expect, test } from "bun:test";
import { createRepeatControl, encodeCommand, decodeCommand } from "../src/repeat-control";

test("attached hello replies with correlated metadata; bounded replay consumes paused and duplicate requests", async () => {
  let paused = false, now = 1000;
  const replies: string[] = [], repeats: string[] = [];
  const c = createRepeatControl({ instance: "instance-a", now: () => now,
    status: () => ({ sessionID: "s", revision: 3 }), isPaused: () => paused,
    repeat: async (s) => { repeats.push(s); }, publish: async (s) => { replies.push(s); } });
  await c.handle(encodeCommand({ kind: "hello", challenge: "challenge-a", sessionID: "s", expires: 2000 }));
  expect(decodeCommand(replies[0])?.instance).toBe("instance-a");
  expect(replies[0]).not.toContain("file");
  const request = (requestID: string, extra = {}) => encodeCommand({ kind: "repeat", instance: "instance-a", sessionID: "s", revision: 3, requestID, expires: 2000, ...extra });
  paused = true; await c.handle(request("paused"));
  paused = false; await c.handle(request("paused")); expect(repeats).toEqual([]);
  await c.handle(request("ok")); await c.handle(request("ok")); expect(repeats).toEqual(["s"]);
  await c.handle(request("wrong", { instance: "instance-b" }));
  await c.handle(request("session", { sessionID: "other" }));
  await c.handle(request("stale", { revision: 2 }));
  now = 2001; await c.handle(request("expired")); expect(repeats).toEqual(["s"]);
  c.dispose(); await c.handle(request("disposed", { expires: 3000 })); expect(repeats).toEqual(["s"]);
});

test("malformed/oversized namespace is consumed without action; unrelated host commands pass through", async () => {
  const c = createRepeatControl({ instance: "a", status: () => undefined, isPaused: () => false,
    repeat: async () => { throw new Error("unexpected"); }, publish: async () => { throw new Error("unexpected"); } });
  expect(await c.handle("help.show")).toBe(false);
  expect(await c.handle("open-vox.repeat.v1:{bad")).toBe(true);
  expect(await c.handle("open-vox.repeat.v1:" + "x".repeat(4096))).toBe(true);
  c.dispose();
});

const controlCommand = (action: unknown, extra: Record<string, unknown> = {}) => encodeCommand({
  kind: "control", instance: "instance-a", sessionID: "s", requestID: "req-1", action, expires: 2000, ...extra,
} as never);

test("control messages round-trip and only a validated action enum decodes", () => {
  for (const action of ["pause", "resume"]) {
    const m = decodeCommand(controlCommand(action));
    expect(m).toMatchObject({ kind: "control", instance: "instance-a", sessionID: "s", requestID: "req-1", action, expires: 2000 });
  }
  for (const action of ["toggle", "stop", "PAUSE", "", undefined, null, 1, {}, ["pause"]])
    expect(decodeCommand(controlCommand(action))).toBeUndefined();
  expect(decodeCommand(controlCommand("pause", { requestID: undefined }))).toBeUndefined();
  expect(decodeCommand(controlCommand("pause", { requestID: "bad id!" }))).toBeUndefined();
  expect(decodeCommand(controlCommand("pause", { instance: undefined }))).toBeUndefined();
  expect(decodeCommand(controlCommand("pause", { sessionID: "bad id!" }))).toBeUndefined();
  expect(decodeCommand(controlCommand("pause", { expires: 1.5 }))).toBeUndefined();
  expect(decodeCommand(controlCommand("pause", { requestID: "x".repeat(2100) }))).toBeUndefined();
});

function controlHarness(now = { value: 1000 }) {
  let paused = false;
  const applied: string[] = [], replies: string[] = [];
  let failure: Error | undefined;
  const c = createRepeatControl({ instance: "instance-a", now: () => now.value,
    status: () => ({ sessionID: "s", revision: 2 }), isPaused: () => paused,
    control: (action) => {
      if (failure) throw failure;
      applied.push(action); paused = action === "pause";
    },
    repeat: async () => {}, publish: async (s) => { replies.push(s); } });
  const hello = async () => {
    await c.handle(encodeCommand({ kind: "hello", challenge: "challenge-a", sessionID: "s", expires: now.value + 1000 }));
    return decodeCommand(replies.at(-1)!);
  };
  return { c, now, applied, hello, fail(error: Error | undefined) { failure = error; } };
}

test("a control action is applied once and the next status reply reflects it", async () => {
  const h = controlHarness();
  expect((await h.hello())?.paused).toBe(false);
  expect(await h.c.handle(controlCommand("pause", { requestID: "p1" }))).toBe(true);
  expect(h.applied).toEqual(["pause"]);
  expect((await h.hello())?.paused).toBe(true);
  await h.c.handle(controlCommand("pause", { requestID: "p1" }));
  expect(h.applied).toEqual(["pause"]);
  await h.c.handle(controlCommand("resume", { requestID: "r1" }));
  expect(h.applied).toEqual(["pause", "resume"]);
  expect((await h.hello())?.paused).toBe(false);
  expect(Object.keys(await h.hello() as object).sort())
    .toEqual(["challenge", "enabled", "expires", "instance", "kind", "paused", "revision", "sessionID"]);
  h.c.dispose();
});

test("control requests from the wrong instance, outside the window or malformed are ignored", async () => {
  const h = controlHarness();
  await h.c.handle(controlCommand("pause", { requestID: "w1", instance: "instance-b" }));
  await h.c.handle(controlCommand("pause", { requestID: "e1", expires: 1000 }));
  await h.c.handle(controlCommand("pause", { requestID: "e2", expires: 999 }));
  await h.c.handle(controlCommand("pause", { requestID: "e3", expires: 3001 }));
  await h.c.handle(controlCommand("toggle", { requestID: "a1" }));
  expect(await h.c.handle("open-vox.repeat.v1:{bad")).toBe(true);
  expect(h.applied).toEqual([]);
  await h.c.handle(controlCommand("pause", { requestID: "edge", expires: 3000 }));
  expect(h.applied).toEqual(["pause"]);
  h.c.dispose();
  await h.c.handle(controlCommand("resume", { requestID: "late", expires: 3000 }));
  expect(h.applied).toEqual(["pause"]);
});

test("control and repeat share one bounded request history that purges expired entries", async () => {
  const h = controlHarness();
  let repeats = 0;
  const c = createRepeatControl({ instance: "instance-a", now: () => h.now.value,
    status: () => ({ sessionID: "s", revision: 2 }), isPaused: () => false,
    control: () => { repeats += 1000; }, repeat: async () => { repeats++; }, publish: async () => {} });
  for (let i = 0; i < 32; i++) {
    await c.handle(encodeCommand({ kind: "repeat", instance: "instance-a", sessionID: "s", revision: 2, requestID: `rep-${i}`, expires: 2000 }));
    await c.handle(controlCommand("pause", { requestID: `ctl-${i}` }));
  }
  expect(repeats).toBe(32 + 32 * 1000);
  await c.handle(controlCommand("pause", { requestID: "over-cap" }));
  expect(repeats).toBe(32 + 32 * 1000);
  h.now.value = 2000; // every earlier entry expired; the history frees up again.
  await c.handle(controlCommand("pause", { requestID: "after-purge", expires: 3000 }));
  expect(repeats).toBe(32 + 33 * 1000);
  c.dispose();
  h.c.dispose();
});

test("a failing control handler is contained and its request stays consumed", async () => {
  const h = controlHarness();
  h.fail(new Error("boom"));
  expect(await h.c.handle(controlCommand("pause", { requestID: "f1" }))).toBe(true);
  h.fail(undefined);
  await h.c.handle(controlCommand("pause", { requestID: "f1" }));
  expect(h.applied).toEqual([]);
  await h.c.handle(controlCommand("pause", { requestID: "f2" }));
  expect(h.applied).toEqual(["pause"]);
  h.c.dispose();
});

test("an async control handler rejection is contained", async () => {
  const c = createRepeatControl({ instance: "instance-a", now: () => 1000,
    status: () => undefined, isPaused: () => false,
    control: async () => { throw new Error("async boom"); },
    repeat: async () => {}, publish: async () => {} });
  expect(await c.handle(controlCommand("pause"))).toBe(true);
  c.dispose();
});

test("two instances with the same session remain targeted, and request history is bounded", async () => {
  let a = 0, b = 0;
  const make = (instance: string, repeat: () => void) => createRepeatControl({ instance, now: () => 1000,
    status: () => ({ sessionID: "s", revision: 1 }), isPaused: () => false,
    repeat: async () => { repeat(); }, publish: async () => {} });
  const first = make("a", () => { a++; }), second = make("b", () => { b++; });
  for (let i = 0; i < 80; i++) {
    const request = encodeCommand({ kind: "repeat", instance: "a", sessionID: "s", revision: 1, requestID: `request-${i}`, expires: 2000 });
    await first.handle(request); await second.handle(request);
  }
  expect(a).toBe(64); expect(b).toBe(0);
  first.dispose(); second.dispose();
});

test("service actions validate request identity and reject aliases or unsupported rate actions", () => {
  for (const action of ["enable", "disable"] as const) {
    expect(decodeCommand(controlCommand(action))?.action).toBe(action);
    for (const extra of [{ requestID: "bad id" }, { instance: undefined }, { expires: 1.5 }])
      expect(decodeCommand(controlCommand(action, extra))).toBeUndefined();
  }
  for (const action of ["on", "off", "ENABLE", "disable ", "rate", "setRate"])
    expect(decodeCommand(controlCommand(action))).toBeUndefined();
});

test("status decodes confirmed enabled state and defaults old messages to enabled", () => {
  const status = (extra = {}) => encodeCommand({ kind: "status", challenge: "nonce-a",
    instance: "instance-a", sessionID: "s", revision: 2, paused: false, expires: 2000, ...extra });
  expect(decodeCommand(status())?.enabled).toBe(true);
  for (const enabled of [true, false])
    expect(decodeCommand(status({ enabled }))).toMatchObject({ enabled, challenge: "nonce-a" });
  for (const enabled of [null, 0, 1, "false", {}, []])
    expect(decodeCommand(status({ enabled }))).toBeUndefined();
});

test("hello reports actual enabled state with correlated nonce and compatible default", async () => {
  let enabled = false;
  const replies: string[] = [];
  const base = { instance: "instance-a", now: () => 1000, status: () => undefined,
    isPaused: () => false, repeat: async () => {}, publish: async (s: string) => { replies.push(s); } };
  const c = createRepeatControl({ ...base, isEnabled: () => enabled });
  const hello = encodeCommand({ kind: "hello", challenge: "nonce-a", sessionID: "s", expires: 2000 });
  await c.handle(hello);
  expect(decodeCommand(replies.at(-1))).toMatchObject({ enabled: false, challenge: "nonce-a", instance: "instance-a", revision: 0 });
  enabled = true; await c.handle(hello);
  expect(decodeCommand(replies.at(-1))?.enabled).toBe(true);
  const plain = createRepeatControl(base);
  await plain.handle(hello);
  expect(decodeCommand(replies.at(-1))?.enabled).toBe(true);
  c.dispose(); plain.dispose();
});

test("service controls retain instance/TTL/replay bounds and consume handler failures", async () => {
  const applied: string[] = [];
  let fail: "sync" | "async" | undefined;
  const c = createRepeatControl({ instance: "instance-a", now: () => 1000, status: () => undefined,
    isPaused: () => false, repeat: async () => {}, publish: async () => {}, control: (action) => {
      applied.push(action);
      if (fail === "sync") throw new Error("sync failure");
      if (fail === "async") return Promise.reject(new Error("async failure"));
    } });
  for (const extra of [{ instance: "instance-b" }, { expires: 1000 }, { expires: 3001 }])
    await c.handle(controlCommand("disable", extra));
  expect(applied).toEqual([]);
  fail = "sync"; await c.handle(controlCommand("disable", { requestID: "d1" }));
  fail = "async"; await c.handle(controlCommand("enable", { requestID: "e1" }));
  fail = undefined;
  await c.handle(controlCommand("disable", { requestID: "d1" }));
  await c.handle(controlCommand("enable", { requestID: "e1" }));
  expect(applied).toEqual(["disable", "enable"]);
  for (let i = 0; i < 70; i++) await c.handle(controlCommand("enable", { requestID: `bulk-${i}` }));
  expect(applied).toHaveLength(64);
  c.dispose(); await c.handle(controlCommand("disable", { requestID: "disposed" }));
  expect(applied).toHaveLength(64);
});

test("disabled Repeat is consumed, not deferred, and shares history with service controls", async () => {
  let enabled = false, repeats = 0;
  const c = createRepeatControl({ instance: "instance-a", now: () => 1000,
    status: () => ({ sessionID: "s", revision: 3 }), isPaused: () => false, isEnabled: () => enabled,
    repeat: async () => { repeats++; }, control: (action) => { enabled = action === "enable"; }, publish: async () => {} });
  const repeat = (requestID: string) => encodeCommand({ kind: "repeat", instance: "instance-a",
    sessionID: "s", revision: 3, requestID, expires: 2000 });
  await c.handle(repeat("off"));
  await c.handle(controlCommand("enable", { requestID: "enable" }));
  await c.handle(repeat("off"));
  await c.handle(repeat("enable"));
  expect(repeats).toBe(0);
  await c.handle(repeat("fresh"));
  expect(repeats).toBe(1);
  c.dispose();
});
