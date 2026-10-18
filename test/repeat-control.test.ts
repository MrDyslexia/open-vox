import { expect, test } from "bun:test";
import { createRepeatControl, encodeCommand, decodeCommand } from "../src/repeat-control";
import * as rateControl from "../src/repeat-control";

test("device status uses validated optional enums, correlated session reads and Off gating", async () => {
  let reads = 0;
  expect(rateControl.modelDevices({ get lid() { return ++reads === 1 ? "cpu" : "invalid"; } })).toEqual({ lid: "cpu" });
  expect(reads).toBe(1);
  let enabled = true;
  const replies: string[] = [], sessions: string[] = [];
  const control = createRepeatControl({ now: () => 1000, status: () => undefined, isPaused: () => false,
    isEnabled: () => enabled, devices: session => { sessions.push(session); return { lid: "cpu", kokoro: "gpu" }; },
    repeat: async () => {}, publish: async command => { replies.push(command); } });
  const hello = () => control.handle(encodeCommand({ kind: "hello", sessionID: "s", challenge: "c", expires: 2000 }));
  await hello();
  const status = decodeCommand(replies[0])!;
  expect(status).toMatchObject({ lidDevice: "cpu", kokoroDevice: "gpu", challenge: "c", sessionID: "s" });
  for (const value of ["cuda", "GPU", "", null, 0, {}]) {
    expect(decodeCommand(encodeCommand({ ...status, lidDevice: value } as any))).toBeUndefined();
    expect(decodeCommand(encodeCommand({ ...status, kokoroDevice: value } as any))).toBeUndefined();
  }
  enabled = false; await hello();
  expect(decodeCommand(replies[1])?.kokoroDevice).toBeUndefined(); expect(sessions).toEqual(["s"]);
  control.dispose();
});

test("Speak validates latest ownership, busy state, service gates, expiry and shared deduplication", async () => {
  let busy = true, enabled = true, paused = false, target = "b", requests = 0;
  const replies: string[] = [];
  const c = createRepeatControl({ instance: "host", now: () => 1000,
    latest: () => ({ sessionID: "s", messageID: target, busy }),
    status: () => ({ sessionID: "s", messageID: "a", revision: 1 }),
    isPaused: () => paused, isEnabled: () => enabled,
    speak: async () => { requests++; }, repeat: async () => { throw Error("old audio"); },
    publish: async command => { replies.push(command); } });
  let sequence = 0;
  const speak = (extra = {}) => c.handle(encodeCommand({ kind: "speak", instance: "host", sessionID: "s",
    messageID: "b", revision: 0, requestID: `r-${++sequence}`, expires: 2000, ...extra }));
  await c.handle(encodeCommand({ kind: "hello", sessionID: "s", challenge: "c", expires: 2000 }));
  expect(decodeCommand(replies[0])).toMatchObject({ messageID: "b", revision: 0, busy: true });
  await speak(); busy = false;
  for (const extra of [{ messageID: "a" }, { sessionID: "other" }, { instance: "other" },
    { expires: 1000 }, { expires: 3001 }, { revision: 1 }, { messageID: "bad id" }]) await speak(extra);
  paused = true; await speak(); paused = false;
  enabled = false; await speak(); enabled = true;
  expect(requests).toBe(0);
  await speak({ requestID: "once" }); await speak({ requestID: "once" });
  expect(requests).toBe(1);
  target = "c"; await speak(); expect(requests).toBe(1);
  c.dispose(); target = "b"; await speak(); expect(requests).toBe(1);
});

test("async selection rechecks expiry and Repeat can restart playback already in progress", async () => {
  let time = 1000, repeats = 0, releaseRead!: () => void, releasePlayback!: () => void;
  let refresh = async () => true;
  const c = createRepeatControl({ instance: "host", now: () => time,
    latest: () => ({ sessionID: "s", messageID: "a", busy: false }),
    status: () => ({ sessionID: "s", messageID: "a", revision: 1 }),
    isPaused: () => false, refresh: () => refresh(), publish: async () => {},
    repeat: async () => { if (++repeats === 1) await new Promise<void>(resolve => { releasePlayback = resolve; }); } });
  const request = (id: string) => c.handle(encodeCommand({ kind: "repeat", instance: "host", sessionID: "s",
    messageID: "a", revision: 1, requestID: id, expires: 2000 }));
  try {
    refresh = () => new Promise<boolean>(resolve => { releaseRead = () => resolve(true); });
    const late = request("late"); time = 2000; releaseRead(); await late;
    expect(repeats).toBe(0);
    time = 1000; refresh = async () => true;
    const first = request("first"); await Promise.resolve(); await Promise.resolve();
    await request("second"); expect(repeats).toBe(2);
    releasePlayback(); await first;
  } finally { releasePlayback?.(); c.dispose(); }
});

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
    .toEqual(["challenge", "enabled", "expires", "instance", "kind", "paused", "playbackSpeed", "revision", "sessionID"]);
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

test("playback rates form the closed 1x -> 1.5x -> 2x cycle, independent of synthesis speed", () => {
  expect([...rateControl.PLAYBACK_SPEEDS]).toEqual([1, 1.5, 2]);
  expect(rateControl.nextPlaybackSpeed(1)).toBe(1.5);
  expect(rateControl.nextPlaybackSpeed(1.5)).toBe(2);
  expect(rateControl.nextPlaybackSpeed(2)).toBe(1);
  for (const invalid of [undefined, null, NaN, 0, -1, 2.5, 3, 1.25, Infinity, "1.5", "2", {}, [1]])
    expect(rateControl.nextPlaybackSpeed(invalid)).toBe(1.5);
  for (const start of rateControl.PLAYBACK_SPEEDS)
    expect(rateControl.nextPlaybackSpeed(rateControl.nextPlaybackSpeed(rateControl.nextPlaybackSpeed(start)))).toBe(start);
});

test("speed actions round-trip explicit targets and reject free-form values and aliases", () => {
  for (const speed of rateControl.PLAYBACK_SPEEDS) {
    expect(rateControl.speedAction(speed)).toBe(`speed:${speed}`);
    expect(rateControl.speedOfAction(rateControl.speedAction(speed))).toBe(speed);
    expect(decodeCommand(controlCommand(rateControl.speedAction(speed)))).toMatchObject({
      kind: "control", instance: "instance-a", action: `speed:${speed}`, requestID: "req-1" });
  }
  for (const action of ["pause", "resume", "disable", "enable"] as const)
    expect(rateControl.speedOfAction(action)).toBeUndefined();
  for (const action of ["speed:2.5", "speed:0", "speed:3", "speed:1.0", "speed:2.0", "speed:1.50", "speed:", "speed", "speed:abc",
    "speed:1x", "speed:-1", "speed:Infinity", "speed:NaN", "SPEED:1", "speed:1 ", "speed:1\n", " speed:1", "speed:1e0", 1.5, 2])
    expect(decodeCommand(controlCommand(action))).toBeUndefined();
});

test("speed commands retain identity, nonce shape and safe-integer envelope validation", () => {
  for (const extra of [{ requestID: undefined }, { requestID: "bad id!" }, { instance: undefined }, { instance: "bad nonce!" },
    { sessionID: "bad id!" }, { expires: 1.5 }, { requestID: "x".repeat(2100) }])
    expect(decodeCommand(controlCommand("speed:1.5", extra))).toBeUndefined();
});

const rateStatus = (extra = {}) => encodeCommand({ kind: "status", challenge: "nonce-a",
  instance: "instance-a", sessionID: "s", revision: 2, paused: false, expires: 2000, ...extra });

test("status validates closed playbackSpeed and retains legacy enabled and 1x defaults", () => {
  for (const playbackSpeed of [1, 1.5, 2])
    expect(decodeCommand(rateStatus({ playbackSpeed, enabled: false }))).toMatchObject({ playbackSpeed, enabled: false });
  expect(decodeCommand(rateStatus())).toMatchObject({ playbackSpeed: 1, enabled: true, challenge: "nonce-a" });
  for (const playbackSpeed of [0, -1, 0.5, 2.5, 3, 8, "1", "1.5", "2x", null, true, false, {}, [], [1]])
    expect(decodeCommand(rateStatus({ playbackSpeed }))).toBeUndefined();
  expect(decodeCommand(rateStatus({ playbackSpeed: 1.5, challenge: "bad nonce!" }))).toBeUndefined();
});

test("hello reports an optional instance rate reader, defaulting absent or invalid values to 1x", async () => {
  let speed: number = 1;
  const replies: string[] = [];
  const base = { instance: "instance-a", now: () => 1000, status: () => undefined,
    isPaused: () => false, repeat: async () => {}, publish: async (s: string) => { replies.push(s); } };
  const c = createRepeatControl({ ...base, getPlaybackSpeed: () => speed as never });
  for (const value of [1, 1.5, 2, 7] as const) {
    speed = value;
    const challenge = `nonce-${String(value).replace(".", "-")}`;
    await c.handle(encodeCommand({ kind: "hello", challenge, sessionID: "s", expires: 2000 }));
    expect(decodeCommand(replies.at(-1))?.playbackSpeed).toBe(value === 7 ? 1 : value);
    expect(decodeCommand(replies.at(-1))?.challenge).toBe(challenge);
  }
  c.dispose();
  const plain = createRepeatControl(base);
  await plain.handle(encodeCommand({ kind: "hello", challenge: "legacy", sessionID: "s", expires: 2000 }));
  expect(decodeCommand(replies.at(-1))?.playbackSpeed).toBe(1);
  plain.dispose();
});

test("speed dispatch retains instance, expiry, replay and shared bounded history guards", async () => {
  const seen: string[] = [];
  const c = createRepeatControl({ instance: "instance-a", now: () => 1000, status: () => undefined,
    isPaused: () => false, control: a => { seen.push(a); }, repeat: async () => {}, publish: async () => {} });
  await c.handle(controlCommand("speed:1.5", { requestID: "s1" }));
  await c.handle(controlCommand("speed:1.5", { requestID: "s1" }));
  for (const extra of [{ instance: "instance-b" }, { expires: 1000 }, { expires: 3001 }])
    await c.handle(controlCommand("speed:2", { requestID: "invalid", ...extra }));
  await c.handle(controlCommand("speed:2.5", { requestID: "invalid-rate" }));
  await c.handle(controlCommand("enable", { requestID: "s1" }));
  expect(seen).toEqual(["speed:1.5"]);
  for (let i = 0; i < 70; i++) await c.handle(controlCommand(i % 2 ? "speed:1" : "speed:2", { requestID: `bulk-${i}` }));
  expect(seen).toHaveLength(64);
  c.dispose(); await c.handle(controlCommand("speed:1", { requestID: "late" }));
  expect(seen).toHaveLength(64);
});

test("synchronous and asynchronous rate handler failures are contained and remain consumed", async () => {
  let attempts = 0, mode: "sync" | "async" = "sync";
  const c = createRepeatControl({ instance: "instance-a", now: () => 1000, status: () => undefined,
    isPaused: () => false, repeat: async () => {}, publish: async () => {}, control: () => {
      attempts++;
      if (mode === "sync") throw new Error("sync failure");
      return Promise.reject(new Error("async failure"));
    } });
  expect(await c.handle(controlCommand("speed:2", { requestID: "x1" }))).toBe(true);
  mode = "async";
  expect(await c.handle(controlCommand("speed:1.5", { requestID: "x2" }))).toBe(true);
  await c.handle(controlCommand("speed:2", { requestID: "x1" }));
  expect(attempts).toBe(2);
  c.dispose();
});
