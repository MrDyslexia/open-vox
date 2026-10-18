import { expect, test } from "bun:test";
import plugin, { createV2Bridge, setupOpenVoxV2, type V2Context, type V2Session } from "../src/opencode-v2";
import { OPEN_VOX_RPC } from "../src/rpc";
import { createCoordinator } from "../src/plugin";
import type { Selection } from "../src/final-response";

const info = (id = "s", extra: Record<string, unknown> = {}) => ({ id, projectID: "p", time: { created: 1, updated: 2 }, ...extra });
const user = (id: string, created: number, text = "Question") => ({ id, type: "user", time: { created }, text });
const assistant = (id: string, created: number, finish: string, content: unknown[], completed = created + 1) =>
  ({ id, type: "assistant", time: { created, completed }, finish, content, agent: "build", model: { providerID: "f", modelID: "f" } });
const turn = () => [
  user("u", 1),
  assistant("a1", 2, "tool-calls", [{ type: "tool", id: "t", name: "read", state: {}, time: { created: 2 } }]),
  assistant("a2", 4, "stop", [{ type: "reasoning", text: "thinking" }, { type: "text", text: " Answer " }]),
];

function fakeSession(entries: unknown[] = turn(), session: Record<string, unknown> = info()): V2Session & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get: async ({ sessionID }) => { calls.push(`get:${sessionID}`); if (sessionID !== session.id) throw new Error("missing"); return session; },
    context: async ({ sessionID }) => { calls.push(`context:${sessionID}`); if (sessionID !== session.id) throw new Error("missing"); return entries; },
  };
}
const v2 = (type: string, data: Record<string, unknown>, directory?: string) =>
  ({ type, data, ...(directory ? { location: { directory } } : {}) });

test("default export satisfies the V2 loader contract", () => {
  expect(plugin.id).toBe("open-vox");
  expect(typeof plugin.setup).toBe("function");
});

test("a succeeded execution narrates the final stop response through the unchanged coordinator", async () => {
  const bridge = createV2Bridge(fakeSession(), "local");
  const output: Selection[] = [];
  const coordinator = createCoordinator(bridge.client, "local", async value => { output.push(value); });
  for (const event of await bridge.translate(v2("session.execution.succeeded", { sessionID: "s" }, "local")))
    await coordinator.event({ event });
  expect(output).toEqual([{ sessionID: "s", messageID: "a2", text: "Answer" }]);
});

test("a started execution announces the new user turn before any response", async () => {
  const bridge = createV2Bridge(fakeSession([user("u", 1)]), "local");
  const events = await bridge.translate(v2("session.execution.started", { sessionID: "s" }));
  expect(events.map(e => [e.type, (e.properties as any).info.role, (e.properties as any).info.id])).toEqual([["message.updated", "user", "u"]]);
});

test("only the last response after the latest user is announced", async () => {
  const bridge = createV2Bridge(fakeSession(), "local");
  const events = await bridge.translate(v2("session.execution.succeeded", { sessionID: "s" }));
  expect(events.map(e => (e.properties as any).info.id)).toEqual(["u", "a2"]);
  expect((events[1].properties as any).info).toMatchObject({ role: "assistant", parentID: "u", finish: "stop", time: { created: 4, completed: 5 } });
});

test("persisted history maps to V1 messages with parent links and a bounded limit", async () => {
  const bridge = createV2Bridge(fakeSession([...turn(), { id: "x", type: "synthetic", time: { created: 6 } }]), "local");
  const history = await bridge.client.session.messages!({ path: { id: "s" }, query: { directory: "local", limit: 2 } });
  expect(history.data!.map(m => [m.info.id, m.info.role, (m.info as any).parentID])).toEqual([["a1", "assistant", "u"], ["a2", "assistant", "u"]]);
  expect(history.data![1].parts.map(p => p.type)).toEqual(["reasoning", "text"]);
  const single = await bridge.client.session.message({ path: { id: "s", messageID: "u" }, query: { directory: "local" } });
  expect(single.data!.parts).toMatchObject([{ type: "text", text: "Question", messageID: "u", sessionID: "s" }]);
});

test("V2 call failures become V1 error results instead of throwing", async () => {
  const bridge = createV2Bridge(fakeSession(), "local");
  expect((await bridge.client.session.get({ path: { id: "other" }, query: { directory: "local" } })).error).toBeDefined();
  expect((await bridge.client.session.message({ path: { id: "s", messageID: "nope" }, query: { directory: "local" } })).error).toBeDefined();
});

test.each([
  ["session.deleted", { type: "session.deleted", properties: { info: { id: "s" } } }],
  ["session.execution.failed", { type: "session.error", properties: { sessionID: "s" } }],
  ["session.execution.interrupted", { type: "session.error", properties: { sessionID: "s" } }],
  ["session.step.failed", { type: "session.error", properties: { sessionID: "s" } }],
  ["session.revert.staged", { type: "message.removed", properties: { sessionID: "s" } }],
  ["session.revert.committed", { type: "message.removed", properties: { sessionID: "s" } }],
  ["session.compaction.ended", { type: "session.compacted", properties: { sessionID: "s" } }],
  ["session.step.started", { type: "message.part.updated", properties: { part: { sessionID: "s" } } }],
])("%s maps to its V1 invalidation event", async (type, expected) => {
  const bridge = createV2Bridge(fakeSession(), "local");
  expect(await bridge.translate(v2(type, { sessionID: "s" }))).toEqual([expected as any]);
});

test("compaction blocks selection until it ends", async () => {
  const bridge = createV2Bridge(fakeSession(), "local");
  const [updated] = await bridge.translate(v2("session.compaction.started", { sessionID: "s" }));
  expect(updated).toMatchObject({ type: "session.updated", properties: { info: { id: "s" } } });
  expect((updated.properties as any).info.time.compacting).toBeNumber();
  expect((await bridge.client.session.get({ path: { id: "s" }, query: { directory: "local" } })).data!.time.compacting).toBeNumber();
  await bridge.translate(v2("session.compaction.ended", { sessionID: "s" }));
  expect((await bridge.client.session.get({ path: { id: "s" }, query: { directory: "local" } })).data!.time.compacting).toBeUndefined();
});

test("events from another location and unknown events are ignored", async () => {
  const session = fakeSession();
  const bridge = createV2Bridge(session, "local");
  expect(await bridge.translate(v2("session.execution.succeeded", { sessionID: "s" }, "elsewhere"))).toEqual([]);
  expect(await bridge.translate(v2("session.renamed", { sessionID: "s" }))).toEqual([]);
  expect(await bridge.translate({ type: "server.connected" })).toEqual([]);
  expect(session.calls).toEqual([]);
});

function fakeContext(events: unknown[] = []) {
  const emitted: unknown[] = [];
  const state = { registered: undefined as any, handlers: undefined as any, disposed: false };
  const ctx: V2Context = {
    location: { directory: "local" },
    session: fakeSession(),
    event: { subscribe: ({ signal } = {}) => (async function* () {
      for (const event of events) yield event;
      await new Promise(resolve => signal?.addEventListener("abort", resolve, { once: true }));
    })() },
    rpc: { register: async (definition: any, handlers: any) => {
      state.registered = definition; state.handlers = handlers;
      return { events: { emit: async (name: string, data: unknown) => { emitted.push([name, data]); } }, dispose: async () => { state.disposed = true; } };
    } },
  };
  return { ctx, emitted, state };
}

test("setup bridges RPC commands both ways and cleans up", async () => {
  const { ctx, emitted, state } = fakeContext([v2("session.deleted", { sessionID: "s" })]);
  const seen: unknown[] = [];
  let publish!: (command: string) => Promise<void>;
  let disposed = false;
  const cleanup = await setupOpenVoxV2(ctx, (_client, directory, send) => {
    expect(directory).toBe("local");
    publish = send;
    return { event: async ({ event }) => { seen.push(event); }, dispose: async () => { disposed = true; } };
  });
  expect(state.registered).toBe(OPEN_VOX_RPC);
  expect(await state.handlers.command({ command: "ping" }, {})).toEqual({});
  await publish("pong");
  await Bun.sleep(10);
  expect(seen).toContainEqual({ type: "tui.command.execute", properties: { command: "ping" } });
  expect(seen).toContainEqual({ type: "session.deleted", properties: { info: { id: "s" } } });
  expect(emitted).toEqual([["command", { command: "pong" }]]);
  await cleanup();
  expect(state.disposed).toBe(true);
  expect(disposed).toBe(true);
});
