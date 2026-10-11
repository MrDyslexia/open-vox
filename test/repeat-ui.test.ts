import { expect, test } from "bun:test";
import { createRepeatUi, buttonHandlers, publishAttached, sameView } from "../src/repeat-ui";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { readFileSync } from "node:fs";
import { encodeCommand, decodeCommand, type ControlMessage } from "../src/repeat-control";

function renewalHarness() {
  let now = 1000, sequence = 0, listener!: (command: string) => void;
  let publish: (message: ControlMessage) => Promise<void> = async () => {};
  const sent: ControlMessage[] = [], changes: boolean[] = [];
  const ui = createRepeatUi({ now: () => now, id: () => `id-${++sequence}`,
    subscribe(fn) { listener = fn; return () => {}; },
    publish(command) { const message = decodeCommand(command)!; sent.push(message); return publish(message); },
    onChange() { changes.push(ui.available("s")); } });
  const reply = (hello = sent.filter((m) => m.kind === "hello").at(-1)!, overrides: Partial<ControlMessage> = {}) =>
    listener(encodeCommand({ kind: "status", challenge: hello.challenge, sessionID: hello.sessionID,
      expires: hello.expires, instance: "a", revision: 1, paused: false, ...overrides }));
  return { ui, sent, changes, reply, receive: (command: string) => listener(command),
    time(value: number) { now = value; }, transport(fn: typeof publish) { publish = fn; },
    async accept() { ui.refresh("s"); await Promise.resolve(); reply(); now = 1250; expect(ui.available("s")).toBe(true); } };
}

test("healthy renewal stays available through unresolved hello publication and settlement", async () => {
  const h = renewalHarness(); await h.accept();
  let resolve!: () => void;
  h.transport((m) => m.kind === "hello" ? new Promise<void>((done) => { resolve = done; }) : Promise.resolve());
  h.time(2750); h.changes.length = 0; h.ui.refresh("s");
  expect(h.ui.available("s")).toBe(true);
  h.reply(); h.time(2999); expect(h.ui.available("s")).toBe(true);
  await h.ui.repeat("s");
  expect(h.sent.filter((m) => m.kind === "repeat")).toHaveLength(1);
  resolve(); await Promise.resolve(); await Promise.resolve();
  h.time(3000); expect(h.ui.available("s")).toBe(true);
  expect(h.changes).not.toContain(false);
  h.transport(async () => {});
  h.time(4500); h.ui.refresh("s"); await Promise.resolve(); h.reply();
  h.time(4750); expect(h.ui.available("s")).toBe(true);
  h.ui.dispose();
});

test("missing, malformed and stale renewal replies cannot extend accepted expiry", async () => {
  const h = renewalHarness(); await h.accept(); const old = h.sent[0]!;
  h.time(2750); h.ui.refresh("s"); await Promise.resolve();
  h.reply(old); h.reply(undefined, { expires: 9999 }); h.reply(undefined, { sessionID: "other" });
  h.receive("open-vox.repeat.v1:{malformed"); h.reply(undefined, { revision: -1 });
  h.time(2999); expect(h.ui.available("s")).toBe(true);
  h.time(3000); expect(h.ui.available("s")).toBe(false);
  h.time(4750); h.reply(); expect(h.ui.available("s")).toBe(false);
  h.ui.dispose();

  const stalled = renewalHarness(); await stalled.accept();
  stalled.transport(() => new Promise<void>(() => {}));
  stalled.time(2750); stalled.ui.refresh("s");
  stalled.time(2999); expect(stalled.ui.available("s")).toBe(true);
  stalled.time(3000); expect(stalled.ui.available("s")).toBe(false);
  stalled.time(5000); stalled.ui.refresh("s");
  expect(stalled.sent.filter((m) => m.kind === "hello")).toHaveLength(2);
  expect(stalled.ui.available("s")).toBe(false); stalled.ui.dispose();
});

test("renewal preserves instance conflict checks before and after settlement", async () => {
  for (const replyTime of [2800, 3000]) {
    const h = renewalHarness(); await h.accept();
    h.time(2750); h.ui.refresh("s"); await Promise.resolve(); h.reply();
    h.time(replyTime); expect(h.ui.available("s")).toBe(true);
    h.reply(undefined, { instance: "b" }); expect(h.ui.available("s")).toBe(false);
    h.reply(); expect(h.ui.available("s")).toBe(false);
    h.ui.dispose();
  }
});

test("replacement after accepted expiry is available in the first settled discovery cycle", async () => {
  for (const refreshTime of [3000, 3250]) {
    const h = renewalHarness(); await h.accept();
    h.time(refreshTime); h.ui.refresh("s"); await Promise.resolve();
    h.reply(undefined, { instance: "b" });
    h.time(refreshTime + 249); expect(h.ui.available("s")).toBe(false);
    h.time(refreshTime + 250); expect(h.ui.available("s")).toBe(true);
    await h.ui.repeat("s");
    expect(h.sent.filter((m) => m.kind === "repeat").at(-1)?.instance).toBe("b");
    expect(h.sent.filter((m) => m.kind === "hello")).toHaveLength(2);
    h.ui.dispose();
  }
});

test("replacement still conflicts with a live accepted instance or another same-challenge responder", async () => {
  for (const refreshTime of [2750, 3250]) {
    const h = renewalHarness(); await h.accept();
    h.time(refreshTime); h.ui.refresh("s"); await Promise.resolve();
    h.reply(undefined, { instance: "b" });
    if (refreshTime === 3250) h.reply(undefined, { instance: "c" });
    h.time(refreshTime + 250); expect(h.ui.available("s")).toBe(false);
    h.reply(undefined, { instance: "b" }); expect(h.ui.available("s")).toBe(false);
    h.ui.dispose();
  }
});

test("confirmed pause and explicit backend unavailability override renewal eligibility", async () => {
  for (const unavailable of [{ paused: true }, { revision: 0 }]) {
    const h = renewalHarness(); await h.accept();
    h.time(2750); h.ui.refresh("s"); await Promise.resolve();
    expect(h.ui.available("s")).toBe(true);
    h.reply(undefined, unavailable); expect(h.ui.available("s")).toBe(false);
    await h.ui.repeat("s"); expect(h.sent.filter((m) => m.kind === "repeat")).toHaveLength(0);
    h.time(3000); expect(h.ui.available("s")).toBe(false);
    h.ui.dispose();
  }
});

test("a paused or audio-less instance still accepts control and shows the confirmed state", async () => {
  for (const [state, paused] of [[{ paused: true }, true], [{ revision: 0 }, false]] as const) {
    const h = renewalHarness(); await h.accept();
    expect(h.ui.view("s")).toEqual({ paused: false, canControl: true, canRepeat: true });
    h.time(2750); h.ui.refresh("s"); await Promise.resolve();
    h.reply(undefined, state);
    expect(h.ui.view("s")).toEqual({ paused, canControl: true, canRepeat: false });
    h.time(3000); expect(h.ui.view("s").canControl).toBe(true);
    h.ui.dispose();
  }
});

test("control needs a validated unexpired status for the displayed session; there is no optimistic state", async () => {
  const none = renewalHarness();
  expect(none.ui.view("s")).toEqual({ paused: undefined, canControl: false, canRepeat: false });
  await none.ui.togglePause("s");
  expect(none.sent).toHaveLength(0);
  none.ui.refresh("s"); await Promise.resolve(); // hello sent, no reply yet
  await none.ui.togglePause("s");
  expect(none.sent.filter((m) => m.kind === "control")).toHaveLength(0);
  none.ui.dispose();

  const h = renewalHarness(); await h.accept();
  await h.ui.togglePause("other"); await h.ui.togglePause("");
  expect(h.sent.filter((m) => m.kind === "control")).toHaveLength(0);
  h.time(3000); expect(h.ui.view("s")).toEqual({ paused: undefined, canControl: false, canRepeat: false });
  await h.ui.togglePause("s");
  expect(h.sent.filter((m) => m.kind === "control")).toHaveLength(0);
  h.ui.dispose();
  await h.ui.togglePause("s");
  expect(h.sent.filter((m) => m.kind === "control")).toHaveLength(0);
});

test("togglePause publishes an explicit action for the confirmed state and asks for a fresh status", async () => {
  const h = renewalHarness(); await h.accept();
  const hellos = () => h.sent.filter((m) => m.kind === "hello");
  expect(hellos()).toHaveLength(1);
  await h.ui.togglePause("s");
  const first = h.sent.find((m) => m.kind === "control")!;
  expect(first).toMatchObject({ kind: "control", instance: "a", sessionID: "s", action: "pause", requestID: expect.any(String) });
  expect(first.expires).toBe(1250 + 2000);
  // Nothing is optimistic: the click did not change the displayed state.
  expect(h.ui.view("s").paused).toBe(false);
  // The existing refresh path issued a new challenge right away; a late reply to the old one is ignored.
  expect(hellos()).toHaveLength(2);
  h.reply(hellos()[0], { paused: true });
  expect(h.ui.view("s").paused).toBe(false);
  // The confirmed reply to the fresh challenge drives the display and the next explicit action.
  h.reply(hellos()[1], { paused: true });
  expect(h.ui.view("s")).toEqual({ paused: true, canControl: true, canRepeat: false });
  await h.ui.togglePause("s");
  expect(h.sent.filter((m) => m.kind === "control").at(-1)).toMatchObject({ action: "resume" });
  expect(new Set(h.sent.filter((m) => m.kind === "control").map((m) => m.requestID)).size).toBe(2);
  h.ui.dispose();
});

test("only one control publication is in flight and repeat is unavailable while it is pending", async () => {
  const h = renewalHarness(); await h.accept();
  let resolve!: () => void;
  h.transport(() => new Promise<void>((done) => { resolve = done; }));
  const first = h.ui.togglePause("s"), second = h.ui.togglePause("s");
  expect(h.sent.filter((m) => m.kind === "control")).toHaveLength(1);
  expect(h.ui.view("s")).toEqual({ paused: false, canControl: false, canRepeat: false });
  await h.ui.repeat("s");
  expect(h.sent.filter((m) => m.kind === "repeat")).toHaveLength(0);
  h.transport(async () => {});
  resolve(); await Promise.all([first, second]);
  expect(h.ui.view("s").canControl).toBe(true);
  h.ui.dispose();
});

test("a control transport failure invalidates the status and leaves no optimistic state", async () => {
  const h = renewalHarness(); await h.accept();
  h.transport(async (m) => { if (m.kind === "control") throw new Error("transport failed"); });
  await h.ui.togglePause("s");
  expect(h.ui.view("s")).toEqual({ paused: undefined, canControl: false, canRepeat: false });
  expect(h.sent.filter((m) => m.kind === "hello")).toHaveLength(1);
  h.ui.dispose();
});

test("session changes and replies from a second instance drop the displayed state", async () => {
  const h = renewalHarness(); await h.accept();
  h.time(2750); h.ui.refresh("s"); await Promise.resolve();
  h.reply(undefined, { instance: "b" });
  expect(h.ui.view("s")).toEqual({ paused: undefined, canControl: false, canRepeat: false });
  await h.ui.togglePause("s");
  expect(h.sent.filter((m) => m.kind === "control")).toHaveLength(0);
  h.ui.dispose();

  const moved = renewalHarness(); await moved.accept();
  moved.ui.refresh("other");
  expect(moved.ui.view("s").canControl).toBe(false);
  moved.ui.dispose();
});

test("session and route changes invalidate accepted status even with hello in flight", async () => {
  for (const session of ["other", ""]) {
    const h = renewalHarness(); await h.accept();
    let resolve!: () => void;
    h.transport(() => new Promise<void>((done) => { resolve = done; }));
    h.time(2750); h.ui.refresh("s"); const renewal = h.sent.at(-1)!;
    h.ui.refresh(session); h.reply(renewal);
    expect(h.ui.available("s")).toBe(false);
    expect(h.ui.available(session)).toBe(false);
    resolve(); await Promise.resolve(); await Promise.resolve();
    h.transport(async () => {}); h.ui.refresh("s"); await Promise.resolve();
    h.time(3000); expect(h.ui.available("s")).toBe(false);
    h.reply(); expect(h.ui.available("s")).toBe(true);
    h.ui.dispose(); h.reply(); expect(h.ui.available("s")).toBe(false);
  }
});

test("renewal transport rejection invalidates status and pending Repeat prevents duplicate actions", async () => {
  const h = renewalHarness(); await h.accept();
  let reject!: (error: Error) => void;
  h.transport(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  h.time(2750); h.ui.refresh("s");
  expect(h.ui.available("s")).toBe(true);
  reject(new Error("transport failed")); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(h.ui.available("s")).toBe(false); h.ui.dispose();

  const action = renewalHarness(); await action.accept(); let resolve!: () => void;
  action.transport(() => new Promise<void>((done) => { resolve = done; }));
  const first = action.ui.repeat("s"); const second = action.ui.repeat("s");
  expect(action.sent.filter((m) => m.kind === "repeat")).toHaveLength(1);
  expect(action.ui.available("s")).toBe(false);
  resolve(); await Promise.all([first, second]); expect(action.ui.available("s")).toBe(true);
  action.ui.dispose();
});

test("attached v2 SDK publish emits the exact event body and directory through fake transport", async () => {
  const requests: Request[] = [];
  const client = createOpencodeClient({ baseUrl: "http://attached.invalid", fetch: (async (request: Request) => {
    requests.push(request);
    return new Response("true", { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch });
  const command = encodeCommand({ kind: "hello", challenge: "c", sessionID: "s", expires: 1000 });
  await publishAttached(client, "C:\\owned", command);
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]!.url).pathname).toBe("/tui/publish");
  expect(new URL(requests[0]!.url).searchParams.get("directory")).toBe("C:\\owned");
  expect(await requests[0]!.json()).toEqual({ type: "tui.command.execute", properties: { command } });
});

test("current TUI TSX transpiles with installed Bun; this is syntax-only, not renderer proof", () => {
  const source = readFileSync(new URL("../tui/open-vox.tsx", import.meta.url), "utf8");
  const output = new Bun.Transpiler({ loader: "tsx" }).transformSync(source);
  expect(output.length).toBeGreaterThan(0);
});

test("sidebar Pause goes through the confirmed control channel, not config.json (source-level guard, not renderer proof)", () => {
  const source = readFileSync(new URL("../tui/open-vox.tsx", import.meta.url), "utf8");
  expect(source).not.toMatch(/writeConfig\(\s*\{\s*paused/);
  expect(source).not.toMatch(/config\(\)\.paused/);
  expect(source).toContain("repeat.togglePause(");
  // Voice keeps its mouse-up behavior and its own config path.
  expect(source).toMatch(/button\(\(\) => "Voice", chooseVoice, undefined, true\)/);
  expect(source).toContain("writeConfig({ voices:");
});

test("sameView compares every rendered field", () => {
  const base = { paused: false, canControl: true, canRepeat: true };
  expect(sameView(base, { ...base })).toBe(true);
  for (const change of [{ paused: true }, { paused: undefined }, { canControl: false }, { canRepeat: false }])
    expect(sameView(base, { ...base, ...change })).toBe(false);
});

test("sidebar renderer binds the session from the second public slot argument", async () => {
  const source = readFileSync(new URL("../tui/open-vox.tsx", import.meta.url), "utf8");
  // Execute the actual registration callback without mounting a renderer or reading settings.
  const registration = source.slice(source.indexOf("const tui: TuiPlugin"))
    .replace("export default plugin", "return plugin");
  const output = new Bun.Transpiler({ loader: "tsx", tsconfig: {
    compilerOptions: { jsx: "react", jsxFactory: "captureBlock" },
  } }).transformSync(registration);
  const plugin = new Function("Block", "captureBlock", "id", output)(
    () => {}, (_component: unknown, props: { sessionID: string }) => props, "open-vox");
  let renderer!: (context: { theme: object }, props: { session_id: string }) => { sessionID: string };
  const api = { slots: { register(input: { slots: { sidebar_content: typeof renderer } }) {
    renderer = input.slots.sidebar_content;
  } } };
  await plugin.tui(api);
  // OpenTUI's public renderer calls entry.renderer(registry.context, slotProps).
  expect(renderer({ theme: {} }, { session_id: "owner-session" }).sessionID).toBe("owner-session");
  expect(renderer({ theme: {} }, { session_id: "other-session" }).sessionID).toBe("other-session");
});

test("subscribe precedes challenge; unknown, timeout, conflicting and other-session replies disable replay", async () => {
  let now = 1000, listener!: (command: string) => void;
  const sent: string[] = [], order: string[] = [];
  const ui = createRepeatUi({ now: () => now, id: () => `id-${sent.length}`,
    subscribe(fn) { order.push("subscribe"); listener = fn; return () => order.push("dispose"); },
    publish: async (s) => { order.push("publish"); sent.push(s); }, onChange() {} });
  ui.refresh("s"); expect(order.slice(0, 2)).toEqual(["subscribe", "publish"]);
  await Promise.resolve();
  expect(ui.available("s")).toBe(false);
  const hello = decodeCommand(sent[0])!;
  const reply = (instance: string, challenge = hello.challenge) => encodeCommand({ kind: "status", challenge, instance, sessionID: "s", revision: 1, paused: false, expires: hello.expires });
  listener(reply("a", "unknown")); now = 1100; expect(ui.available("s")).toBe(false);
  listener(reply("a")); now = 1300;
  expect(ui.available("s")).toBe(true);
  expect(ui.available("other")).toBe(false);
  await ui.repeat("s"); expect(decodeCommand(sent[1])?.instance).toBe("a");
  listener(reply("b")); expect(ui.available("s")).toBe(false);
  now = 4000; expect(ui.available("s")).toBe(false);
  ui.dispose(); expect(order.at(-1)).toBe("dispose");
});

test("button guards are functional and Voice remains mouse-up only", () => {
  let calls = 0, disabled = true;
  const action = () => { calls++; };
  const repeat = buttonHandlers(action, () => disabled);
  repeat.onMouseDown?.(); expect(calls).toBe(0);
  disabled = false; repeat.onMouseDown?.(); expect(calls).toBe(1);
  const voice = buttonHandlers(action, () => false, true);
  expect(voice.onMouseDown).toBeUndefined(); voice.onMouseUp?.(); expect(calls).toBe(2);
});

test("a transport that never settles cannot accumulate challenge publications", () => {
  let now = 1000, calls = 0;
  const ui = createRepeatUi({ now: () => now, id: () => `challenge-${calls}`,
    subscribe: () => () => {}, publish: () => { calls++; return new Promise<void>(() => {}); }, onChange() {} });
  for (let i = 0; i < 100; i++) { ui.refresh("s"); now += 2001; }
  expect(calls).toBe(1);
  expect(ui.available("s")).toBe(false);
  ui.dispose();
});
