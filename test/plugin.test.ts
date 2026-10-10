import { expect, test } from "bun:test";
import type { Event } from "@opencode-ai/sdk";
import { createCoordinator, type Client } from "../src/plugin";
import type { Selection } from "../src/final-response";
import { fixture } from "./final-response.test";

const updated = (info: ReturnType<typeof fixture>["response"]["info"]): Event => ({ type: "message.updated", properties: { info } });
function harness() {
  const fixtures = [fixture(), fixture("t", "v", "b")];
  const calls: string[] = [];
  const output: Selection[] = [];
  const client: Client = { session: {
    get: async ({ path, query }) => {
      calls.push(`session:${path.id}:${query.directory}`);
      return { data: fixtures.find(f => f.session.id === path.id)?.session };
    },
    message: async ({ path, query }) => {
      calls.push(`message:${path.id}:${path.messageID}:${query.directory}`);
      const f = fixtures.find(f => f.session.id === path.id);
      return { data: path.messageID === f?.response.info.id ? f.response : path.messageID === f?.parent.info.id ? f.parent : undefined };
    },
  } };
  const coordinator = createCoordinator(client, "local", async value => { output.push(value); });
  return { fixtures, calls, output, client, coordinator };
}
test("no startup history, idle or old completion playback", async () => {
  const h = harness();
  expect(h.calls).toEqual([]);
  await h.coordinator.event({ event: { type: "session.idle", properties: { sessionID: "s" } } });
  await h.coordinator.event({ event: updated(h.fixtures[0].response.info) });
  expect(h.output).toEqual([]);
  expect(h.calls).toEqual([]);
});
test("fresh turns select once across simultaneous duplicate events and sessions", async () => {
  const h = harness();
  for (const f of h.fixtures) await h.coordinator.event({ event: updated(f.parent.info) });
  await Promise.all(h.fixtures.flatMap(f => [
    h.coordinator.event({ event: updated(f.response.info) }),
    h.coordinator.event({ event: updated(f.response.info) }),
  ]));
  expect(h.output.map(v => v.messageID).sort()).toEqual(["a", "b"]);
  expect(h.calls).toHaveLength(6);
  expect(h.calls.every(v => v.endsWith(":local"))).toBe(true);
});
test.each(["new-turn", "error", "removed", "dispose"])("invalidates pending work on %s", async kind => {
  const h = harness();
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const get = h.client.session.get;
  h.client.session.get = async input => { await wait; return get(input); };
  await h.coordinator.event({ event: updated(h.fixtures[0].parent.info) });
  const pending = h.coordinator.event({ event: updated(h.fixtures[0].response.info) });
  if (kind === "new-turn") {
    const next = fixture("s", "new").parent.info;
    next.time.created = 4;
    await h.coordinator.event({ event: updated(next) });
  }
  if (kind === "error") await h.coordinator.event({ event: { type: "session.error", properties: { sessionID: "s" } } });
  if (kind === "removed") await h.coordinator.event({ event: { type: "session.deleted", properties: { info: h.fixtures[0].session } } });
  if (kind === "dispose") h.coordinator.dispose();
  release();
  await pending;
  expect(h.output).toEqual([]);
});
test.each(["returned-error", "missing", "throw", "response-error", "response-missing", "response-throw", "parent-error", "parent-missing", "parent-throw", "identity", "session-identity", "parent-identity", "sink"])("contains %s without retry", async kind => {
  const h = harness();
  let attempts = 0;
  if (kind === "returned-error") h.client.session.get = async () => ({ data: h.fixtures[0].session, error: {} });
  if (kind === "missing") h.client.session.get = async () => ({});
  if (kind === "throw") h.client.session.get = async () => { throw Error("SDK"); };
  if (kind.startsWith("parent-") || kind.startsWith("response-")) {
    const message = h.client.session.message;
    h.client.session.message = async input => {
      const targeted = input.path.messageID === (kind.startsWith("parent-") ? "u" : "a");
      if (!targeted) return message(input);
      if (kind.endsWith("throw")) throw Error("message SDK");
      if (kind.endsWith("missing")) return {};
      if (kind.endsWith("identity")) return { data: fixture("s", "wrong").parent };
      return { error: {} };
    };
  }
  if (kind === "identity") h.fixtures[0].response.info.id = "wrong";
  if (kind === "session-identity") h.client.session.get = async () => ({ data: fixture("wrong").session });
  const coordinator = createCoordinator(h.client, "local", async () => {
    attempts++;
    if (kind === "sink") throw Error("sink");
  });
  await coordinator.event({ event: updated(h.fixtures[0].parent.info) });
  const event = updated(fixture().response.info);
  await expect(coordinator.event({ event })).resolves.toBeUndefined();
  await coordinator.event({ event });
  expect(attempts).toBe(kind === "sink" ? 1 : 0);
});
test("rejects stale parent and reload without observed turn", async () => {
  const h = harness();
  await h.coordinator.event({ event: updated(fixture("s", "new").parent.info) });
  await h.coordinator.event({ event: updated(h.fixtures[0].response.info) });
  const reload = createCoordinator(h.client, "local", async value => { h.output.push(value); });
  await reload.event({ event: updated(h.fixtures[0].response.info) });
  expect(h.output).toEqual([]);
});
test("out-of-order and duplicate user updates cannot resurrect invalidated work", async () => {
  const h = harness();
  await h.coordinator.event({ event: updated(h.fixtures[0].parent.info) });
  await h.coordinator.event({ event: { type: "session.error", properties: { sessionID: "s" } } });
  await h.coordinator.event({ event: updated(h.fixtures[0].parent.info) });
  await h.coordinator.event({ event: updated(h.fixtures[0].response.info) });
  expect(h.output).toEqual([]);
  expect(h.calls).toEqual([]);
});
test("incomplete updates do not consume a later completed candidate", async () => {
  const h = harness();
  await h.coordinator.event({ event: updated(h.fixtures[0].parent.info) });
  const incomplete = fixture().response.info;
  if (incomplete.role === "assistant") incomplete.time.completed = undefined;
  await h.coordinator.event({ event: updated(incomplete) });
  await h.coordinator.event({ event: updated(h.fixtures[0].response.info) });
  expect(h.output).toHaveLength(1);
});
test.each(["response", "parent"])("new turns invalidate asynchronous %s fetches", async phase => {
  const h = harness();
  let reached!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const message = h.client.session.message;
  h.client.session.message = async input => {
    if (input.path.messageID === (phase === "response" ? "a" : "u")) {
      reached();
      await wait;
    }
    return message(input);
  };
  await h.coordinator.event({ event: updated(h.fixtures[0].parent.info) });
  const pending = h.coordinator.event({ event: updated(h.fixtures[0].response.info) });
  await started;
  const next = fixture("s", "new").parent.info;
  next.time.created = 4;
  await h.coordinator.event({ event: updated(next) });
  release();
  await pending;
  expect(h.output).toEqual([]);
});
test("message removal and unscoped errors invalidate pending work", async () => {
  for (const event of [
    { type: "message.removed", properties: { sessionID: "s", messageID: "u" } },
    { type: "session.error", properties: {} },
  ] as Event[]) {
    const h = harness();
    await h.coordinator.event({ event: updated(h.fixtures[0].parent.info) });
    await h.coordinator.event({ event });
    await h.coordinator.event({ event: updated(h.fixtures[0].response.info) });
    expect(h.output).toEqual([]);
  }
});
test("state limits fail closed rather than replaying evicted turns", async () => {
  const h = harness();
  for (let i = 0; i < 129; i++) {
    const f = fixture(`session-${i}`);
    await h.coordinator.event({ event: updated(f.parent.info) });
  }
  await h.coordinator.event({ event: updated(fixture("s").parent.info) });
  await h.coordinator.event({ event: updated(fixture("s").response.info) });
  expect(h.calls).toEqual([]);
  const turns = harness();
  for (let i = 0; i < 65; i++) {
    const f = fixture("s", `user-${i}`);
    f.parent.info.time.created = i + 1;
    await turns.coordinator.event({ event: updated(f.parent.info) });
  }
  await turns.coordinator.event({ event: updated(fixture("s", "user-64").response.info) });
  expect(turns.calls).toEqual([]);
});
