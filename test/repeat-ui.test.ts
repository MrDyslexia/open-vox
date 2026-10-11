import { expect, test } from "bun:test";
import { createRepeatUi, buttonHandlers, publishAttached } from "../src/repeat-ui";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { readFileSync } from "node:fs";
import { encodeCommand, decodeCommand } from "../src/repeat-control";

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
  expect(ui.available("s", false)).toBe(false);
  const hello = decodeCommand(sent[0])!;
  const reply = (instance: string, challenge = hello.challenge) => encodeCommand({ kind: "status", challenge, instance, sessionID: "s", revision: 1, paused: false, expires: hello.expires });
  listener(reply("a", "unknown")); now = 1100; expect(ui.available("s", false)).toBe(false);
  listener(reply("a")); now = 1300;
  expect(ui.available("s", false)).toBe(true);
  expect(ui.available("other", false)).toBe(false);
  expect(ui.available("s", true)).toBe(false);
  await ui.repeat("s", false); expect(decodeCommand(sent[1])?.instance).toBe("a");
  listener(reply("b")); expect(ui.available("s", false)).toBe(false);
  now = 4000; expect(ui.available("s", false)).toBe(false);
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
  expect(ui.available("s", false)).toBe(false);
  ui.dispose();
});
