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
