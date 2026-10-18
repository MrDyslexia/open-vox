import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenVoxPlugin, chooseEngine, createLiveSink, createOpenVox, createPauseState, disableService, liveEngine, withPause } from "../src/plugin";
import * as plugin from "../src/plugin";
import { createNarrationPlan } from "../src/markdown-narration";
import { createConfigReader, DEFAULT_CONFIG, readConfig, writeConfig } from "../src/config";
import { createSpeechSink, type Engine, type SpeechProcess, type SpeechSink } from "../src/speech-sink";
import { encodeCommand, decodeCommand } from "../src/repeat-control";
import { fixture } from "./final-response.test";
import { AudioCache } from "../src/audio-cache";
import { wavBytes } from "./audio-cache.test";
import { flattenNarrationPlan } from "../src/narration-plan";
import { createPlayer, type Player, type HostProcess } from "../src/player";
import * as playerModule from "../src/player";
import { defaultKokoroEngine, kokoroEngine } from "../src/kokoro-engine";
import type { Client } from "../src/plugin";

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

test("planned Kokoro devices survive live engine and pause wrappers into scoped control status", async () => {
  const kokoro = kokoroEngine({ python: "fake", script: "fake", modelPath: "fake", voicesPath: "fake",
    voices: { es: "em_alex", en: "af_heart" }, speed: 1, tmpDir: "R", unlink() {},
    run: cmd => ({ exited: Promise.resolve(0), kill() {}, devices: () => cmd === "fake" ? { lid: "cpu", kokoro: "gpu" } : undefined }) });
  let wanted = "kokoro";
  const engine = liveEngine(() => wanted, { kokoro: () => kokoro, piper: () => undefined },
    () => ({ exited: Promise.resolve(0), kill() {} }));
  const raw = createSpeechSink({ engine, deviceIdentity: () => wanted });
  const sink = withPause(raw, () => false);
  await sink({ sessionID: "ses_a", messageID: "a", text: "Fake narration" });
  const replies: any[] = [];
  const hooks = createOpenVox(client, "local", sink, undefined,
    { instance: "devices", publish: async command => { replies.push(decodeCommand(command)); } });
  const hello = (sessionID: string) => hooks.event!({ event: { type: "tui.command.execute", properties: {
    command: encodeCommand({ kind: "hello", sessionID, challenge: "c", expires: Date.now() + 1500 }),
  } } } as any);
  await hello("ses_a"); expect(replies.at(-1)).toMatchObject({ lidDevice: "cpu", kokoroDevice: "gpu" });
  await hello("ses_b"); expect(replies.at(-1).kokoroDevice).toBeUndefined();
  wanted = "sapi"; await hello("ses_a"); expect(replies.at(-1).kokoroDevice).toBeUndefined();
  await sink({ sessionID: "ses_a", messageID: "b", text: "Fallback narration" });
  await hello("ses_a"); expect(replies.at(-1).kokoroDevice).toBeUndefined();
  await hooks.dispose?.();
});

/** Valid SDK responses and fake audio only; no process, synthesis or host transport. */
function latestResponseHarness(injected = false, nonce = "latest", capable = true) {
  const f = fakeSink();
  const fixtures = [fixture("ses_a", "u", "a"), fixture("ses_a", "u", "b"), fixture("ses_b", "v", "c")];
  fixtures.forEach((value, index) => {
    if (value.response.info.role === "assistant") value.response.info.time.completed = 3 + index;
    Object.assign(value.response.parts[0]!, { text: value.response.info.id });
  });
  const sdk: Client = { session: {
    get: async ({ path }) => ({ data: fixtures.find(value => value.session.id === path.id)?.session }),
    message: async ({ path }) => ({ data: fixtures.find(value => value.response.info.id === path.messageID)?.response ??
      fixtures.find(value => value.parent.info.id === path.messageID)?.parent }),
  } };
  const order: string[] = [], cancelled: string[] = [];
  const stop = f.sink.stop;
  f.sink.stop = () => { order.push("stop"); stop(); };
  f.sink.stopSession = (id) => { cancelled.push(id); };
  f.sink.removeSession = (id) => { cancelled.push(`delete:${id}`); };
  let failNarration = false;
  const record = (async (selection) => {
    order.push(`speak:${selection.messageID}`);
    if (failNarration) throw new Error("fake synthesis failed");
    await f.sink(selection);
  }) as SpeechSink;
  Object.assign(record, { stop: f.sink.stop, pause: f.sink.pause, resume: f.sink.resume,
    stopSession: f.sink.stopSession, removeSession: f.sink.removeSession });
  const state = createPauseState(() => sink.pause?.(), () => sink.resume?.(),
    { onDisable: () => disableService(sink), capable });
  const sink = withPause(record, state.isPaused, state.isEnabled);
  const hooks = createOpenVox(sdk, "local", injected ? sink : record, injected ? state : undefined,
    { instance: nonce, publish: async () => {} });
  let request = 0;
  const control = (action: string, target = nonce) => hooks.event!({ event: { type: "tui.command.execute", properties: {
    command: encodeCommand({ kind: "control", instance: target, sessionID: "ses_a", requestID: `r-${++request}`,
      action, expires: Date.now() + 1500 } as any),
  } } } as any);
  const updated = (info: typeof fixtures[number]["response"]["info"]) => hooks.event!({ event: { type: "message.updated", properties: { info } } });
  const observe = () => Promise.all([updated(fixtures[0]!.parent.info), updated(fixtures[2]!.parent.info)]);
  return { ...f, fixtures, sdk, hooks, control, updated, observe, order, cancelled,
    failNarration: () => { failNarration = true; } };
}

describe("persisted manual recovery", () => {
  function recovery() {
    const a = fixture("ses_a", "u", "a"), b = fixture("ses_a", "v", "b");
    b.parent.info.time.created = 4;
    b.response.info.time = { created: 5, completed: 6 };
    let history = [a.parent, a.response], reads = 0, gets = 0;
    let beforeRead = async () => {}, beforeSpeak = async () => {};
    const sdk: Client = { session: {
      get: async () => { gets++; return { data: a.session }; },
      message: async ({ path }) => ({ data: history.find(m => m.info.id === path.messageID) }),
      messages: async (input: any) => {
        reads++; expect(input.query.limit).toBe(100);
        await beforeRead(); return { data: history };
      },
    } };
    const f = fakeSink(), replies: any[] = [];
    const sink = (async selection => { await beforeSpeak(); await f.sink(selection); }) as SpeechSink;
    Object.assign(sink, { stop: f.sink.stop, pause: f.sink.pause, resume: f.sink.resume,
      status: () => f.sink.status?.(), repeat: async (...args: Parameters<NonNullable<SpeechSink["repeat"]>>) => f.sink.repeat?.(...args) });
    const hooks = createOpenVox(sdk, "local", sink, undefined,
      { instance: "recovery", publish: async command => { replies.push(decodeCommand(command)); } });
    let sequence = 0;
    const send = (kind = "hello", extra: any = {}) => hooks.event!({ event: { type: "tui.command.execute", properties: {
      command: encodeCommand({ kind, instance: "recovery", sessionID: "ses_a", challenge: `c-${++sequence}`,
        requestID: `r-${sequence}`, expires: Date.now() + 1500, ...extra }),
    } } } as any);
    const update = (info: any) => hooks.event!({ event: { type: "message.updated", properties: { info } } } as any);
    return { ...f, a, b, sdk, hooks, send, update, replies, reads: () => reads, gets: () => gets,
      history: (value: typeof history) => { history = value; }, delay: (fn: typeof beforeRead) => { beforeRead = fn; },
      delivery: (fn: typeof beforeSpeak) => { beforeSpeak = fn; } };
  }

  test("restart discovery advertises Speak without audio and explicit clicks coalesce", async () => {
    const h = recovery();
    try {
      await h.send();
      expect(h.replies.at(-1)).toMatchObject({ messageID: "a", revision: 0 });
      expect(h.spoken).toEqual([]);
      for (let i = 0; i < 20; i++) await h.send();
      expect(h.reads()).toBe(1);
      let release!: () => void;
      h.delay(() => new Promise<void>(resolve => { release = resolve; }));
      const click = h.send("speak", { messageID: "a", revision: 0 });
      await Promise.resolve(); await Promise.resolve();
      await h.send("speak", { messageID: "a", revision: 0 });
      release(); await click;
      expect(h.reads()).toBe(2);
      expect(h.spoken).toEqual(["Answer"]);
    } finally { await h.hooks.dispose!(); }
  });

  test("Off-era completion is recovered only after On and explicit Speak", async () => {
    const h = recovery();
    try {
      await h.send("control", { action: "disable" });
      await h.update(h.a.parent.info); await h.update(h.a.response.info);
      await h.send(); expect(h.reads()).toBe(0);
      await h.send("control", { action: "enable" }); await h.send();
      expect(h.replies.at(-1)?.messageID).toBe("a"); expect(h.spoken).toEqual([]);
      await h.send("speak", { messageID: "a", revision: 0 });
      expect(h.spoken).toEqual(["Answer"]);
    } finally { await h.hooks.dispose!(); }
  });

  test.each(["user", "streaming", "error", "summary", "child", "revert", "mismatch", "empty", "session-mismatch"])(
    "latest %s cannot fall back to older A", async kind => {
      const h = recovery();
      try {
        if (kind === "streaming") h.b.response.info.time = { created: 5 };
        if (kind === "error") Object.assign(h.b.response.info, { error: {} });
        if (kind === "summary") Object.assign(h.b.response.info, { summary: true });
        if (kind === "child") h.a.session.parentID = "root";
        if (kind === "revert") h.a.session.revert = { messageID: "v" };
        if (kind === "mismatch") h.b.response.info.sessionID = "other";
        if (kind === "session-mismatch") h.a.session.id = "other";
        if (kind === "empty") h.b.response.parts = [];
        h.history([h.a.parent, h.a.response, h.b.parent, ...(kind === "user" ? [] : [h.b.response])]);
        await h.send(); expect(h.replies.at(-1)?.messageID).toBeUndefined();
        await h.send("speak", { messageID: "a", revision: 0 }); expect(h.spoken).toEqual([]);
      } finally { await h.hooks.dispose!(); }
    });

  test.each(["disable", "pause", "turn", "removed", "error", "switch", "dispose", "off-on", "pause-resume",
    "deleted", "assistant-error", "part-removed", "compacted", "reverted"])(
    "%s invalidates delayed click recovery", async kind => {
      const h = recovery();
      try {
        await h.send();
        expect(h.replies.at(-1)?.messageID).toBe("a");
        let release!: () => void, started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        h.delay(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); });
        const click = h.send("speak", { messageID: "a", revision: 0 }); await ready;
        let switched: Promise<void> | undefined;
        if (kind === "disable" || kind === "pause") await h.send("control", { action: kind });
        if (kind === "off-on" || kind === "pause-resume") {
          await h.send("control", { action: kind === "off-on" ? "disable" : "pause" });
          await h.send("control", { action: kind === "off-on" ? "enable" : "resume" });
        }
        if (kind === "turn") await h.update(h.b.parent.info);
        if (kind === "switch") switched = h.send("hello", { sessionID: "ses_b" }) as Promise<void>;
        if (kind === "dispose") await h.hooks.dispose!();
        if (kind === "assistant-error") await h.update({ ...h.a.response.info, error: {} });
        if (kind === "deleted" || kind === "reverted") await h.hooks.event!({ event: {
          type: kind === "deleted" ? "session.deleted" : "session.updated",
          properties: { info: { ...h.a.session, ...(kind === "reverted" ? { revert: { messageID: "u" } } : {}) } },
        } } as any);
        if (kind === "part-removed" || kind === "compacted") await h.hooks.event!({ event: {
          type: kind === "part-removed" ? "message.part.removed" : "session.compacted",
          properties: { sessionID: "ses_a", messageID: "a", partID: "ap" },
        } } as any);
        if (kind === "removed" || kind === "error") await h.hooks.event!({ event: kind === "removed"
          ? { type: "message.removed", properties: { sessionID: "ses_a", messageID: "a" } }
          : { type: "session.error", properties: { sessionID: "ses_a" } } } as any);
        release(); await click; await switched; expect(h.spoken).toEqual([]);
        if (["deleted", "assistant-error", "removed", "error", "reverted", "part-removed", "compacted"].includes(kind)) {
          const reads = h.reads(); await h.send();
          expect(h.replies.at(-1)?.messageID).toBeUndefined(); expect(h.reads()).toBe(reads);
        }
      } finally { await h.hooks.dispose!(); }
    });

  test("click rechecks latest turn and never repeats A audio for B", async () => {
    const h = recovery(); let repeats = 0;
    h.sink.status = () => ({ sessionID: "ses_a", messageID: "a", revision: 1 });
    h.sink.repeat = async () => { repeats++; };
    try {
      await h.send();
      await h.send("repeat", { messageID: "a", revision: 1 }); expect(repeats).toBe(1);
      h.history([h.a.parent, h.a.response, h.b.parent]);
      await h.send("speak", { messageID: "a", revision: 0 });
      await h.send("repeat", { messageID: "a", revision: 1 });
      expect(h.spoken).toEqual([]); expect(repeats).toBe(1);
      h.history([h.a.parent, h.a.response, h.b.parent, h.b.response]);
      await h.update(h.b.parent.info); // Explicitly invalidate the negative discovery cache.
      await h.send(); expect(h.replies.at(-1)).toMatchObject({ messageID: "b", revision: 0 });
      expect(h.spoken).toEqual([]);
    } finally { await h.hooks.dispose!(); }
  });

  test("failed reads cool down, explicit retries recover and generation failures stay retryable", async () => {
    let time = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => time);
    const h = recovery();
    try {
      h.delay(async () => { throw Error("unavailable"); });
      await h.send(); for (let i = 0; i < 20; i++) await h.send();
      expect(h.reads()).toBe(1); expect(h.replies.at(-1)?.messageID).toBeUndefined();
      h.delay(async () => {}); time += 5001; await h.send();
      expect(h.reads()).toBe(2); expect(h.spoken).toEqual([]);
      h.delivery(async () => { throw Error("fake generation failed"); });
      await h.send("speak", { messageID: "a", revision: 0 }); await h.send();
      expect(h.replies.at(-1)).toMatchObject({ messageID: "a", revision: 0, busy: false });
      h.delivery(async () => {}); await h.send("speak", { messageID: "a", revision: 0 });
      expect(h.spoken).toEqual(["Answer"]);
    } finally { clock.mockRestore(); await h.hooks.dispose!(); }
  });

  test("polling during generation preserves busy ownership and Pause never consumes recovery", async () => {
    const h = recovery();
    try {
      await h.send(); await h.send("control", { action: "pause" });
      await h.send("control", { action: "resume" }); expect(h.spoken).toEqual([]);
      await h.send();
      let release!: () => void, started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      h.delivery(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); });
      const click = h.send("speak", { messageID: "a", revision: 0 }); await ready;
      await h.send(); expect(h.replies.at(-1)?.busy).toBe(true);
      const reads = h.reads(); await h.send("speak", { messageID: "a", revision: 0 });
      expect(h.reads()).toBe(reads); release(); await click;
      expect(h.spoken).toEqual(["Answer"]);
    } finally { await h.hooks.dispose!(); }
  });

  test("SDK history is never read at startup, idle or completion-only autoplay", async () => {
    const h = recovery();
    try {
      await h.hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_a" } } });
      await h.update(h.a.response.info);
      expect(h.reads()).toBe(0); expect(h.spoken).toEqual([]);
      await h.send(); expect(h.spoken).toEqual([]);
    } finally { await h.hooks.dispose!(); }
  });

  test("ordinary observed-turn autoplay does not enumerate SDK history", async () => {
    const h = recovery();
    try {
      await h.update(h.a.parent.info); await h.update(h.a.response.info);
      expect(h.spoken).toEqual(["Answer"]); expect(h.reads()).toBe(0);
    } finally { await h.hooks.dispose!(); }
  });

  test("overlapping status polls coalesce and late timed-out history cannot restore a target", async () => {
    const h = recovery(); let release!: () => void, signal: AbortSignal | undefined;
    const messages = h.sdk.session.messages!;
    h.sdk.session.messages = async input => { signal = input.signal; return messages(input); };
    h.delay(() => new Promise<void>(resolve => { release = resolve; }));
    try {
      const first = h.send("hello", { expires: Date.now() + 1900 });
      await Promise.all(Array.from({ length: 20 }, () => h.send()));
      expect(h.reads()).toBe(1); expect(h.spoken).toEqual([]);
      await first; expect(signal?.aborted).toBe(true);
      expect(h.replies.at(-1)?.messageID).toBeUndefined();
      release(); await Promise.resolve(); await h.send();
      expect(h.reads()).toBe(1); expect(h.replies.at(-1)?.messageID).toBeUndefined();
      expect(h.spoken).toEqual([]);
    } finally { release?.(); await h.hooks.dispose!(); }
  });
});

describe("latest completed response during Pause", () => {
  test("Speak targets B rather than cached A, retries failures and Repeat never synthesizes", async () => {
    const h = latestResponseHarness();
    const replies: any[] = [];
    let audio: any = { sessionID: "ses_a", messageID: "a", revision: 1 };
    let attempts = 0, repeats = 0, release!: () => void;
    const sink = (async () => { attempts++; if (attempts === 1) throw Error("failed autoplay");
      await new Promise<void>(resolve => { release = resolve; });
      audio = { sessionID: "ses_a", messageID: "b", revision: 2 };
    }) as unknown as SpeechSink;
    sink.stop = () => {}; sink.status = () => audio;
    sink.repeat = async () => { repeats++; };
    const hooks = createOpenVox(h.sdk, "local", sink, undefined,
      { instance: "bound", publish: async command => { replies.push(decodeCommand(command)); } });
    const send = (kind: string, extra = {}) => hooks.event!({ event: { type: "tui.command.execute", properties: {
      command: encodeCommand({ kind, instance: "bound", sessionID: "ses_a", expires: Date.now() + 1500,
        requestID: `request-${++sequence}`, ...extra } as any),
    } } } as any);
    let sequence = 0;
    try {
      await hooks.event!({ event: { type: "message.updated", properties: { info: h.fixtures[0]!.parent.info } } });
      await hooks.event!({ event: { type: "message.updated", properties: { info: h.fixtures[1]!.response.info } } });
      await send("hello", { challenge: "first" });
      expect(replies.at(-1)).toMatchObject({ messageID: "b", revision: 0, busy: false });
      await send("repeat", { messageID: "a", revision: 1 });
      await send("speak", { messageID: "a", revision: 0 });
      expect([attempts, repeats]).toEqual([1, 0]);
      const speaking = send("speak", { messageID: "b", revision: 0 });
      await send("speak", { messageID: "b", revision: 0 });
      await send("hello", { challenge: "busy" });
      expect(replies.at(-1)?.busy).toBe(true);
      expect(attempts).toBe(2);
      release(); await speaking;
      await send("hello", { challenge: "ready" });
      expect(replies.at(-1)).toMatchObject({ messageID: "b", revision: 2, busy: false });
      await send("repeat", { messageID: "b", revision: 2 });
      expect([attempts, repeats]).toEqual([2, 1]);
      await send("control", { action: "disable" }); await send("control", { action: "enable" });
      await send("repeat", { messageID: "b", revision: 2 });
      await send("speak", { messageID: "b", revision: 0 });
      expect([attempts, repeats]).toEqual([2, 1]);
    } finally { release?.(); await hooks.dispose!(); await h.hooks.dispose!(); }
  });
  test.each([false, true])("Resume consumes only B once without thawing A (injected state=%s)", async injected => {
    const h = latestResponseHarness(injected);
    await h.observe(); await h.control("pause");
    await h.updated(h.fixtures[0]!.response.info); await h.updated(h.fixtures[1]!.response.info);
    expect(h.spoken).toEqual([]);
    h.order.length = 0;
    await h.control("resume"); await h.control("resume");
    await h.updated(h.fixtures[1]!.response.info);
    expect(h.spoken).toEqual(["b"]);
    expect(h.order).toEqual(["stop", "speak:b"]);
    await h.hooks.dispose!();
  });

  test.each([ ["session", true], ["response", true], ["parent", true],
    ["session", false], ["response", false], ["parent", false] ] as const)(
    "reversed %s fetch cannot resurrect older A after Resume (paused at claim=%s)", async (phase, pausedAtClaim) => {
    const h = latestResponseHarness();
    let release!: () => void, reached!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { reached = resolve; });
    if (phase === "session") {
      const get = h.sdk.session.get; let first = true;
      h.sdk.session.get = async input => { if (first) { first = false; reached(); await wait; } return get(input); };
    } else {
      const message = h.sdk.session.message; let first = true;
      h.sdk.session.message = async input => {
        if (first && input.path.messageID === (phase === "response" ? "a" : "u")) { first = false; reached(); await wait; }
        return message(input);
      };
    }
    await h.observe(); if (pausedAtClaim) await h.control("pause");
    const older = h.updated(h.fixtures[0]!.response.info); await started;
    if (!pausedAtClaim) await h.control("pause");
    await h.updated(h.fixtures[1]!.response.info); await h.control("resume");
    release(); await older;
    await h.control("pause"); await h.control("resume");
    expect(h.spoken).toEqual(["b"]);
    await h.hooks.dispose!();
  });

  test("completion time orders reversed events; equal times use synchronous claim order", async () => {
    const h = latestResponseHarness();
    await h.observe(); await h.control("pause");
    await h.updated(h.fixtures[1]!.response.info); await h.updated(h.fixtures[0]!.response.info);
    await h.control("resume");
    expect(h.spoken).toEqual(["b"]);
    const tie = latestResponseHarness();
    const tied = tie.fixtures[1]!.response.info;
    if (tied.role === "assistant") tied.time.completed = 3;
    await tie.observe(); await tie.control("pause");
    await tie.updated(tie.fixtures[0]!.response.info); await tie.updated(tie.fixtures[1]!.response.info);
    await tie.control("resume");
    expect(tie.spoken).toEqual(["b"]);
    await h.hooks.dispose!(); await tie.hooks.dispose!();
  });

  const invalidation = (kind: string, h: ReturnType<typeof latestResponseHarness>) => {
    if (kind === "turn") return h.updated({ ...h.fixtures[0]!.parent.info, id: "new", time: { created: 8 } });
    if (kind === "off") return h.control("disable");
    if (kind === "dispose") return h.hooks.dispose!();
    const event = kind === "deleted" ? { type: "session.deleted", properties: { info: h.fixtures[0]!.session } } :
      kind === "removed" ? { type: "message.removed", properties: { sessionID: "ses_a", messageID: "a" } } :
      kind === "assistant-error" ? { type: "message.updated", properties: { info: { ...h.fixtures[0]!.response.info,
        error: { name: "MessageAbortedError", data: { message: "Aborted" } } } } } :
      { type: "session.error", properties: kind === "unscoped-error" ? {} : { sessionID: "ses_a" } };
    return h.hooks.event!({ event } as any);
  };
  test.each(["turn", "error", "unscoped-error", "deleted", "removed", "assistant-error", "off", "dispose"])(
    "%s clears retained text and invalidates an older delayed fetch", async kind => {
      const h = latestResponseHarness(true);
      let release!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      const get = h.sdk.session.get; let first = true;
      h.sdk.session.get = async input => { if (first) { first = false; await wait; } return get(input); };
      await h.observe(); await h.control("pause");
      const late = h.updated(h.fixtures[0]!.response.info);
      await h.updated(h.fixtures[1]!.response.info);
      await invalidation(kind, h); await h.control("enable");
      release(); await late; await h.control("resume");
      await h.control("pause"); await h.control("resume");
      expect(h.spoken).toEqual([]);
      await h.hooks.dispose!();
    });

  test("stale or duplicate user updates do not clear a valid retained response or stop audio", async () => {
    const h = latestResponseHarness();
    await h.observe(); await h.control("pause"); await h.updated(h.fixtures[1]!.response.info);
    h.order.length = 0; h.cancelled.length = 0;
    await h.updated(h.fixtures[0]!.parent.info);
    await h.updated({ ...h.fixtures[0]!.parent.info, id: "stale", time: { created: 0 } });
    expect(h.order).toEqual([]); expect(h.cancelled).toEqual([]);
    await h.control("resume"); expect(h.spoken).toEqual(["b"]);
    await h.hooks.dispose!();
  });

  test.each(["turn", "error", "deleted", "removed", "assistant-error"])("%s in session A preserves retained session B", async kind => {
    const h = latestResponseHarness();
    await h.observe(); await h.control("pause"); await h.updated(h.fixtures[2]!.response.info);
    await invalidation(kind, h); await h.control("resume");
    expect(h.spoken).toEqual(["c"]);
    expect(h.cancelled).toContain(kind === "deleted" ? "delete:ses_a" : "ses_a");
    await h.hooks.dispose!();
  });

  test("two instances do not consume each other's latest slot", async () => {
    const a = latestResponseHarness(false, "instance-a"), b = latestResponseHarness(false, "instance-b");
    await a.observe(); await b.observe(); await a.control("pause"); await b.control("pause");
    await a.updated(a.fixtures[0]!.response.info); await b.updated(b.fixtures[1]!.response.info);
    await a.control("resume", "instance-a"); await b.control("resume", "instance-a");
    expect([a.spoken, b.spoken]).toEqual([["a"], []]);
    await b.control("resume"); expect(b.spoken).toEqual(["b"]);
    await a.hooks.dispose!(); await b.hooks.dispose!();
  });

  test.each(["partial", "tool", "rejected", "fetch-error"])("%s does not replace a validated retained response", async kind => {
    const h = latestResponseHarness();
    await h.observe(); await h.control("pause"); await h.updated(h.fixtures[0]!.response.info);
    const next = h.fixtures[1]!;
    if (kind === "partial" && next.response.info.role === "assistant") next.response.info.time.completed = undefined;
    if (kind === "tool") next.response.parts = [{ ...next.response.parts[0]!, type: "tool" } as any];
    if (kind === "rejected") Object.assign(next.response.info, { summary: true });
    if (kind === "fetch-error") h.sdk.session.get = async () => ({ error: "unavailable" });
    await h.updated(next.response.info); await h.control("resume");
    expect(h.spoken).toEqual(["a"]);
    await h.hooks.dispose!();
  });

  test("disabled and incapable instances retain nothing, and sink failures are contained without retry", async () => {
    for (const capable of [true, false]) {
      const h = latestResponseHarness(true, "latest", capable);
      await h.observe(); await h.control("disable"); await h.updated(h.fixtures[0]!.response.info);
      await h.control("enable"); await h.control("pause"); await h.control("resume");
      expect(h.spoken).toEqual([]); await h.hooks.dispose!();
    }
    const h = latestResponseHarness();
    await h.observe(); await h.control("pause"); await h.updated(h.fixtures[0]!.response.info);
    h.failNarration();
    await expect(h.control("resume")).resolves.toBeUndefined();
    await h.control("resume"); expect(h.spoken).toEqual([]);
    expect(h.order.filter(value => value === "speak:a")).toHaveLength(1);
    await h.hooks.dispose!();
  });
});

describe("SDK user summary metadata through the plugin factory", () => {
  function narration() {
    const f = fixture("ses_a", "msg_user", "msg_answer");
    const plans: string[] = [], reads: string[] = [];
    const errors: unknown[] = [];
    let stops = 0;
    const done = () => ({ exited: Promise.resolve(0), kill() {} });
    const engine: Engine = Object.assign(done, {
      speakPlan: (plan: ReturnType<typeof createNarrationPlan>) => { plans.push(plan.blocks.map(b => b.segments.map(s => s.text).join("")).join("\n")); return done(); },
    });
    const sink = createSpeechSink({ enabled: true, engine, narrationLanguage: "es", onError: e => errors.push(e) });
    const stop = sink.stop, stopSession = sink.stopSession!;
    sink.stop = () => { stops++; stop(); };
    sink.stopSession = (id) => { stops++; stopSession(id); };
    const sdk = { session: {
      get: async () => ({ data: f.session }),
      message: async (input: { path: { messageID: string } }) => {
        reads.push(input.path.messageID);
        return { data: input.path.messageID === f.parent.info.id ? f.parent : f.response };
      },
    } };
    const hooks = createOpenVox(sdk, "/d", sink);
    const update = (info: typeof f.parent.info) => hooks.event!({ event: { type: "message.updated", properties: { info } } });
    const metadata = () => { if (f.parent.info.role === "user") f.parent.info.summary = { title: "Changes", body: "Diff metadata", diffs: [] }; };
    return { f, plans, reads, errors, sdk, hooks, update, metadata, stops: () => stops };
  }

  test.each(["ordinary", "initial metadata", "metadata before assistant"])("narrates %s once with correct SDK responses", async (kind) => {
    const n = narration();
    try {
      if (kind === "initial metadata") n.metadata();
      await n.update(n.f.parent.info);
      if (kind === "metadata before assistant") { n.metadata(); await n.update(n.f.parent.info); }
      await n.update(n.f.response.info);
      await n.update(n.f.response.info);
      n.metadata(); await n.update(n.f.parent.info);
      await n.hooks.event!(idle);
      await n.update(n.f.response.info);
      expect(n.plans).toEqual(["Answer"]);
      expect(n.reads).toEqual(["msg_answer", "msg_user"]);
      expect(n.stops()).toBe(1);
      expect(n.errors).toEqual([]);
    } finally { await n.hooks.dispose!(); }
  });

  test("metadata after terminal assistant and before idle preserves the in-flight accepted turn", async () => {
    const n = narration();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    n.sdk.session.get = async () => { await pending; return { data: n.f.session }; };
    try {
      await n.update(n.f.parent.info);
      const completion = n.update(n.f.response.info);
      n.metadata(); await n.update(n.f.parent.info);
      await n.hooks.event!(idle);
      release(); await completion;
      await n.update(n.f.parent.info);
      await n.update(n.f.response.info);
      expect(n.plans).toEqual(["Answer"]);
      expect(n.reads).toEqual(["msg_answer", "msg_user"]);
      expect(n.stops()).toBe(1);
      expect(n.errors).toEqual([]);
    } finally { release(); await n.hooks.dispose!(); }
  });

  test.each(["boolean summary", "null summary", "scalar summary", "parent compaction", "parent synthetic", "assistant summary", "child", "compacting"])("does not narrate %s", async (kind) => {
    const n = narration();
    try {
      if (kind === "boolean summary") Object.assign(n.f.parent.info, { summary: true });
      if (kind === "null summary") Object.assign(n.f.parent.info, { summary: null });
      if (kind === "scalar summary") Object.assign(n.f.parent.info, { summary: "invalid" });
      if (kind === "parent compaction") n.f.parent.parts = [{ ...n.f.parent.parts[0], type: "compaction", auto: true }];
      if (kind === "parent synthetic") Object.assign(n.f.parent.parts[0], { synthetic: true });
      if (kind === "assistant summary") Object.assign(n.f.response.info, { summary: true });
      if (kind === "child") n.f.session.parentID = "ses_root";
      if (kind === "compacting") n.f.session.time.compacting = 1;
      await n.update(n.f.parent.info);
      await n.update(n.f.response.info);
      await n.hooks.event!(idle);
      await n.update(n.f.response.info);
      expect(n.plans).toEqual([]);
      expect(n.errors).toEqual([]);
    } finally { await n.hooks.dispose!(); }
  });
});

describe("narration is cancelled only by events of its own session", () => {
  const userIn = (sessionID: string, id: string, created: number) =>
    ({ type: "message.updated", properties: { info: { id, sessionID, role: "user", time: { created } } } }) as any;
  const errorIn = (sessionID?: string) => ({ type: "session.error", properties: { sessionID } }) as any;

  /** Real hook + real sink + plan-aware engine whose synthesis stays pending until the test finishes it. */
  function live() {
    const synths: { killed: boolean; finish(code?: number): void }[] = [];
    const promoted: string[] = [];
    let last: { file: string; sessionID: string; revision: number } | undefined;
    let count = 0;
    const cache = {
      candidate: () => `wav-${++count}`, current: () => last,
      promote(file: string, sessionID: string) { promoted.push(`${sessionID}:${file}`); last = { file, sessionID, revision: count }; return true; },
      discard() {}, hold: () => () => {}, forget() {}, dispose() {},
    };
    const synthesizePlan = () => {
      let done!: (code: number) => void;
      const proc = { killed: false, exited: new Promise<number>(resolve => { done = resolve; }),
        kill() { proc.killed = true; done(1); }, finish(code = 0) { done(code); } };
      synths.push(proc);
      return proc;
    };
    const engine: Engine = Object.assign(() => { throw new Error("plan only"); }, { synthesizePlan });
    const sink = createSpeechSink({ enabled: true, engine, cache,
      player: () => ({ exited: Promise.resolve(0), kill() {} }) } as any);
    const hooks = createOpenVox(client, "/d", sink);
    const send = (event: any) => hooks.event!({ event });
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    return { sink, hooks, send, synths, promoted, tick };
  }

  test.each([
    ["a user message of another session", () => userIn("ses_child", "msg_child", 5)],
    ["a session.error of another session", () => errorIn("ses_child")],
  ])("%s does not cancel pending narration", async (_name, make) => {
    const l = live();
    try {
      await l.send(userIn("ses_a", "msg_a", 1));
      const narration = l.sink({ sessionID: "ses_a", messageID: "ans", text: "Answer for A" });
      await l.tick();
      await l.send(make());
      await l.tick();
      expect(l.synths[0]!.killed).toBe(false);
      l.synths[0]!.finish();
      await narration;
      expect(l.promoted).toEqual(["ses_a:wav-1"]);
    } finally { await l.hooks.dispose!(); }
  });

  test.each([
    ["a new user message of the same session", () => userIn("ses_a", "msg_a2", 5)],
    ["a session.error of the same session", () => errorIn("ses_a")],
    ["a session.error without a session id", () => errorIn(undefined)],
  ])("%s cancels the narration without a stale promotion", async (_name, make) => {
    const l = live();
    try {
      await l.send(userIn("ses_a", "msg_a", 1));
      const narration = l.sink({ sessionID: "ses_a", messageID: "ans", text: "Answer for A" });
      await l.tick();
      await l.send(make());
      await narration;
      expect(l.synths[0]!.killed).toBe(true);
      expect(l.promoted).toEqual([]);
    } finally { await l.hooks.dispose!(); }
  });

  test("a sink without stopSession falls back to stop() for session events", async () => {
    const f = fakeSink();
    const hooks = createOpenVox(client, "/d", f.sink);
    await hooks.event!({ event: userIn("ses_a", "msg_a", 1) });
    await hooks.event!({ event: errorIn("ses_b") });
    expect(f.stops()).toBe(2);
    await hooks.dispose!();
  });

  test("a sink with stopSession gets the event's session id and withPause forwards it", async () => {
    const f = fakeSink();
    const stopped: string[] = [];
    f.sink.stopSession = (id) => { stopped.push(id); };
    const hooks = createOpenVox(client, "/d", withPause(f.sink, () => false));
    await hooks.event!({ event: userIn("ses_a", "msg_a", 1) });
    await hooks.event!({ event: userIn("ses_a", "msg_a", 1) });   // repeated update of the same message
    await hooks.event!({ event: errorIn("ses_b") });
    await hooks.event!({ event: errorIn(undefined) });
    expect(stopped).toEqual(["ses_a", "ses_b"]);
    expect(f.stops()).toBe(1);                                    // only the global error
    await hooks.dispose!();
  });
});
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
    expect(repeats).toBe(0); // Cache alone is not an observed latest response.
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
  test("live PN sink uses the same dynamic enabled reader for status and cached Repeat", async () => {
    let enabled = false;
    const played: string[] = [];
    const sink = createLiveSink({}, createConfigReader(() => DEFAULT_CONFIG, 0), () => {}, true,
      { cache, isPaused: () => false, isEnabled: () => enabled, player: file => {
        played.push(file); return { exited: Promise.resolve(0), kill() {} };
      } });
    expect(sink.status!()).toBeUndefined(); await sink.repeat!("ses_a", 1);
    expect(played).toEqual([]);
    enabled = true; await sink.repeat!("ses_a", 1);
    expect(played).toEqual(["kept.wav"]);
    await sink.dispose!();
  });

  const cache = {
    candidate: () => "unused.wav", current: () => ({ file: "kept.wav", sessionID: "ses_a", revision: 1 }),
    promote: () => true, discard: () => {}, hold: () => () => {}, forget: () => {}, clear: () => {}, dispose: () => {},
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
  test("live engine forwards release/disposal only to instantiated owners and never restarts after disposal", async () => {
    const calls: string[] = [];
    const make = (name: string) => Object.assign(() => ({ exited: Promise.resolve(0), kill() {} }), {
      release: () => { calls.push(`release:${name}`); }, dispose: async () => { calls.push(`dispose:${name}`); },
    });
    let wanted = "kokoro";
    const a = make("a"), b = make("b");
    const engine = liveEngine(() => wanted, { kokoro: () => a, piper: () => b });
    await engine("first", "es").exited; wanted = "piper"; await engine("second", "es").exited;
    expect(calls).toEqual(["release:a"]);
    engine.release!(); await engine.dispose!();
    expect(calls).toEqual(["release:a", "release:a", "release:b", "dispose:a", "dispose:b"]);
    expect(() => engine("late", "es")).toThrow("disposed");
  });
  test("default Kokoro wiring reads persisted tone changes on each new plan without changing the live profile", async () => {
    let stored = "{}";
    const fs = { read: () => stored, writeAtomic: (_path: string, data: string) => { stored = data; } };
    const calls: string[][] = [];
    const requests: any[] = [];
    let engine: Engine | undefined;
    const exists = spyOn(nodeFs, "existsSync").mockReturnValue(true);
    const spawn = spyOn(childProcess, "spawn").mockImplementation(((_cmd: string, args: string[]) => {
      calls.push(args);
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stdin = new EventEmitter();
      const identity = { v: 1, owner: args[args.indexOf("--owner") + 1], generation: args[args.indexOf("--generation") + 1] };
      child.stdin.write = (raw: string) => {
        const r = JSON.parse(raw); requests.push(r);
        queueMicrotask(() => child.stdout.emit("data", Buffer.from(JSON.stringify({ ...identity,
          type: "result", request: r.request, code: 0, diagnostics: [] }) + "\n")));
        return true;
      };
      child.kill = () => { queueMicrotask(() => child.emit("close", 0)); return true; };
      queueMicrotask(() => child.stdout.emit("data", Buffer.from(JSON.stringify({ ...identity, type: "ready" }) + "\n")));
      return child;
    }) as any);
    try {
      engine = defaultKokoroEngine({ OPEN_VOX_HOME: "C:\\synthetic-tone-home" }, () => readConfig("memory", fs))!;
      const plan = createNarrationPlan("Synthetic narration", "es");
      await engine.synthesizePlan!(plan, "fake.wav").exited;
      expect(requests[0].toneVoice).toBe("");
      writeConfig({ toneVoice: { es: "am_onyx" }, toneWeight: { es: 0.75 } }, "memory", fs);
      await engine.synthesizePlan!(plan, "fake.wav").exited;
      expect(requests[1]).toMatchObject({ toneVoice: "am_onyx", toneWeight: 0.75, lang: "es" });
      writeConfig({ toneVoice: { es: "" }, toneWeight: { es: 0 } }, "memory", fs);
      await engine.synthesizePlan!(plan, "fake.wav").exited;
      expect(requests[2].toneVoice).toBe("");
      expect(calls).toHaveLength(1);
      expect(new Set(requests.map(r => r.generation)).size).toBe(1);
    } finally { await engine?.dispose?.(); spawn.mockRestore(); exists.mockRestore(); }
  });
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
  test("Off updates both flags before its callback and never resumes; On only permits future work", () => {
    const edges: string[] = [], observed: boolean[][] = [];
    const state: ReturnType<typeof createPauseState> = createPauseState(
      () => { edges.push("pause"); }, () => { edges.push("resume"); },
      { onDisable: () => { edges.push("disable"); observed.push([state.isEnabled(), state.isPaused()]); } });
    expect([state.isEnabled(), state.isPaused()]).toEqual([true, false]);
    state.setPaused(true); state.setEnabled(false); state.setEnabled(false);
    expect(observed).toEqual([[false, false]]);
    expect(edges).toEqual(["pause", "disable"]);
    state.setPaused(true); state.setPaused(false);
    expect(edges).toEqual(["pause", "disable"]);
    state.setEnabled(true); state.setEnabled(true);
    expect([state.isEnabled(), state.isPaused()]).toEqual([true, false]);
    expect(edges).toEqual(["pause", "disable"]);
    state.setPaused(true); state.setEnabled(false);
    expect(edges).toEqual(["pause", "disable", "pause", "disable"]);
  });

  test("unsupported static capability cannot be enabled, but retains legacy pause behavior", () => {
    const edges: string[] = [];
    const state = createPauseState(() => { edges.push("pause"); }, undefined,
      { capable: false, onDisable: () => { edges.push("disable"); } });
    expect(state.isEnabled()).toBe(false);
    state.setEnabled(true); state.setEnabled(false);
    expect(state.isEnabled()).toBe(false); expect(edges).toEqual([]);
    state.setPaused(true); expect(state.isPaused()).toBe(true);
    expect(edges).toEqual(["pause"]);
  });

  test("a throwing disable callback cannot restore enabled or paused state", () => {
    const state = createPauseState(() => {}, undefined, { onDisable: () => { throw new Error("disable failed"); } });
    state.setPaused(true);
    expect(() => state.setEnabled(false)).not.toThrow();
    expect([state.isEnabled(), state.isPaused()]).toEqual([false, false]);
  });

  test("disableService stops before invalidation and attempts both steps despite errors", () => {
    const f = fakeSink(), order: string[] = [];
    f.sink.stop = () => { order.push("stop"); throw new Error("stop failed"); };
    const cache = { clear: () => { order.push("clear"); throw new Error("clear failed"); } };
    expect(() => plugin.disableService(f.sink, cache)).not.toThrow();
    expect(order).toEqual(["stop", "clear"]);
    expect(() => plugin.disableService(f.sink)).not.toThrow();
    expect(order).toEqual(["stop", "clear", "stop"]);
  });

  test("Off helper chain observes flags before stop then clear, with no resume on re-enable", () => {
    const f = fakeSink(), order: string[] = [];
    const state = createPauseState(() => f.sink.pause!(), () => f.sink.resume!(),
      { onDisable: () => plugin.disableService(f.sink, { clear: () => { order.push("clear"); } }) });
    f.sink.stop = () => { order.push(`stop:${state.isEnabled()}:${state.isPaused()}`); };
    state.setPaused(true); state.setEnabled(false); state.setEnabled(true);
    expect(order).toEqual(["stop:false:false", "clear"]);
    expect(f.resumes()).toBe(0);
  });

  test("withPause hides disabled work/audio while preserving legacy defaults and cleanup methods", async () => {
    const f = fakeSink();
    let enabled = false, repeats = 0, removed = "", disposed = 0;
    f.sink.status = () => ({ sessionID: "s", revision: 4 });
    f.sink.repeat = async () => { repeats++; };
    f.sink.removeSession = id => { removed = id; };
    f.sink.dispose = async () => { disposed++; };
    const gated = withPause(f.sink, () => false, () => enabled);
    const selection = { sessionID: "s", messageID: "m", text: "New work" };
    await gated(selection); await gated.repeat!("s", 4);
    expect([f.spoken, repeats, gated.status!()]).toEqual([[], 0, undefined]);
    gated.stop(); gated.pause!(); gated.resume!(); gated.removeSession!("s"); await gated.dispose!();
    expect([f.stops(), f.pauses(), f.resumes(), removed, disposed]).toEqual([1, 1, 1, "s", 1]);
    enabled = true; expect(f.spoken).toEqual([]);
    await gated(selection); await gated.repeat!("s", 4);
    expect([f.spoken, repeats]).toEqual([["New work"], 1]);
    const plain = withPause(f.sink, () => false);
    expect(plain.status!()).toEqual({ sessionID: "s", revision: 4 });
  });

  test("withPause forwards stopSession through stopFor while Off; unscoped errors remain global", async () => {
    const f = fakeSink(), sessions: string[] = [];
    f.sink.stopSession = id => { sessions.push(id); };
    const gated = withPause(f.sink, () => false, () => false);
    const hooks = createOpenVox(client, "/d", gated);
    await hooks.event!({ event: { type: "session.error", properties: { sessionID: "other" } } } as any);
    await hooks.event!({ event: user("new-user", 1) });
    await hooks.event!({ event: user("new-user", 1) });
    expect(sessions).toEqual(["other", "ses_a"]); expect(f.stops()).toBe(0);
    await hooks.event!({ event: { type: "session.error", properties: {} } } as any);
    expect(f.stops()).toBe(1);
    await hooks.dispose!();
    expect(withPause(fakeSink().sink, () => false).stopSession).toBeUndefined();
  });

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
  test("rate requests never disable or resume an instance, and stored status follows explicit targets", async () => {
    const a = instance("instance-a");
    try {
      await a.control("pause", "pause");
      for (const action of ["speed:1", "speed:1.5", "speed:2"]) {
        await a.control(action, `rate-${action.slice(6).replace(".", "-")}`);
        expect(await a.status()).toMatchObject({ enabled: true, paused: true, playbackSpeed: Number(action.slice(6)) });
        expect([a.f.pauses(), a.f.resumes(), a.f.stops()]).toEqual([1, 0, 0]);
      }
      await a.control("disable", "disable");
      await a.control("speed:2", "off-rate");
      expect(await a.status()).toMatchObject({ enabled: false, paused: false, playbackSpeed: 2 });
      await a.control("enable", "off-rate"); // A refused rate request was still consumed.
      expect((await a.status())?.enabled).toBe(false);
      await a.control("enable", "enable");
      await a.control("pause", "pause-again");
      await a.control("resume", "resume");
      expect(await a.status()).toMatchObject({ enabled: true, paused: false, playbackSpeed: 2 });
      expect([a.f.pauses(), a.f.resumes(), a.f.stops()]).toEqual([2, 1, 0]);
    } finally { await a.hooks.dispose!(); }
  });

  test("bound service actions clear pause without resuming and On allows future work only", async () => {
    const a = instance("instance-a");
    await a.control("pause", "pause");
    for (const action of ["disable", "enable"]) {
      await a.control(action, action);
      expect(a.pause.isPaused()).toBe(false);
      expect([a.f.pauses(), a.f.resumes(), a.f.stops()]).toEqual([1, 0, 0]);
      expect((await a.status())?.enabled).toBe(action === "enable");
    }
    await a.control("resume", "resume");
    expect(a.pause.isPaused()).toBe(false);
    expect(a.f.resumes()).toBe(0);
    await a.hooks.dispose!();
  });

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

  test("Pause gates narration; unobserved cached audio never authorizes host Repeat", async () => {
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
    expect(a.repeats()).toBe(0);
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
  async function withPluginEnv<T>(configJson: string | undefined, run: (home: string) => Promise<T>, disabled = "1"): Promise<T> {
    const home = mkdtempSync(join(tmpdir(), "open-vox-p2-"));
    const saved = { disabled: process.env.OPEN_VOX_DISABLED, home: process.env.OPEN_VOX_HOME,
      temp: process.env.TEMP, tmp: process.env.TMP };
    if (configJson !== undefined) writeFileSync(join(home, "config.json"), configJson);
    process.env.OPEN_VOX_DISABLED = disabled; process.env.OPEN_VOX_HOME = home;
    process.env.TEMP = home; process.env.TMP = home; // all cache housekeeping stays in this owned fixture
    try { return await run(home); }
    finally {
      for (const [key, value] of [["OPEN_VOX_DISABLED", saved.disabled], ["OPEN_VOX_HOME", saved.home],
        ["TEMP", saved.temp], ["TMP", saved.tmp]] as const) {
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

  test("static-disabled plugin stays Off but its attached transport still accepts On requests", async () => {
    await withPluginEnv(undefined, async () => {
      const p = await boot(), before = await p.status();
      try {
        expect(before.enabled).toBe(false);
        await p.send({ kind: "control", instance: before.instance, sessionID: "ses_a",
          requestID: "enable", action: "enable", expires: Date.now() + 1500 });
        expect((await p.status()).enabled).toBe(false);
        await p.send({ kind: "control", instance: before.instance, sessionID: "ses_a",
          requestID: "rate", action: "speed:2", expires: Date.now() + 1500 });
        expect((await p.status()).playbackSpeed).toBe(1);
      } finally { await p.hooks.dispose(); }
    });
  });

  test.skipIf(process.platform !== "win32")("factory rate callback targets its player without rewriting synthesis settings or starting a host", async () => {
    const json = JSON.stringify({ speed: 1.2, voices: { es: "em_alex", en: "af_heart" }, engine: "sapi" });
    await withPluginEnv(json, async home => {
      const p = ratePlayer(), q = ratePlayer(), players = [p.player, q.player];
      const factory = spyOn(playerModule, "createPlayer").mockImplementation(() => players.shift()!);
      const rate = spyOn(p.player, "setRate");
      const a = await boot(), b = await boot();
      try {
        const first = await a.status(); expect(first.playbackSpeed).toBe(1);
        await a.send({ kind: "control", instance: first.instance, sessionID: "ses_a",
          requestID: "rate", action: "speed:2", expires: Date.now() + 1500 });
        expect(rate).toHaveBeenCalledWith(2); expect(rate).toHaveBeenCalledTimes(1);
        expect((await a.status()).playbackSpeed).toBe(2); expect((await b.status()).playbackSpeed).toBe(1);
        rate.mockImplementationOnce(() => Promise.reject(new Error("fake rate rejection")));
        await a.send({ kind: "control", instance: first.instance, sessionID: "ses_a",
          requestID: "rejected", action: "speed:1.5", expires: Date.now() + 1500 });
        expect((await a.status()).playbackSpeed).toBe(1.5); expect(rate).toHaveBeenCalledTimes(2);
        expect(p.hosts).toHaveLength(0); expect(q.hosts).toHaveLength(0);
        expect(readFileSync(join(home, "config.json"), "utf8")).toBe(json);
      } finally { await a.hooks.dispose(); await b.hooks.dispose(); rate.mockRestore(); factory.mockRestore(); }
    }, "0");
  });

  test.skipIf(process.platform !== "win32")("capable factory binds one memory state without persistence or another-instance cancellation", async () => {
    await withPluginEnv(undefined, async home => {
      expect(tmpdir()).toBe(home);
      const a = await boot(), b = await boot(), sa = await a.status(), sb = await b.status();
      try {
        expect([sa.enabled, sb.enabled]).toEqual([true, true]);
        const command = (action: string) => ({ kind: "control", instance: sa.instance, sessionID: "ses_a",
          requestID: action, action, expires: Date.now() + 1500 });
        await a.send(command("pause")); await a.send(command("disable")); await b.send(command("disable"));
        expect(await a.status()).toMatchObject({ enabled: false, paused: false, revision: 0 });
        expect((await b.status()).enabled).toBe(true);
        await a.send(command("enable"));
        expect(await a.status()).toMatchObject({ enabled: true, paused: false, revision: 0 });
        expect(existsSync(join(home, "config.json"))).toBe(false);
      } finally { await a.hooks.dispose(); await b.hooks.dispose(); }
    }, "0");
  });
});

/** Actual PN sink/cache and wire; only synthesis and player processes are fake. */
function pnService(root: string, playback?: Player, planEngine?: Engine) {
  const cache = new AudioCache(root), plans: ReturnType<typeof createNarrationPlan>[] = [];
  const played: Array<{ file: string; bytes: Buffer }> = [], replies: string[] = [];
  const counts = { parses: 0, dispatches: 0, syntheses: 0 };
  const mode = { prepare: false, synthesis: false, playback: false };
  let prepared!: () => void;
  const processes: Array<SpeechProcess & { finish(): void; killed: boolean; resumes: number }> = [];
  const process = () => {
    let finish!: (code: number) => void;
    const p = { exited: new Promise<number>(r => { finish = r; }), killed: false, resumes: 0,
      kill() { p.killed = true; finish(1); }, finish() { finish(0); },
      pause: async () => true, resume: async () => { p.resumes++; return true; } };
    processes.push(p); return p;
  };
  const state = createPauseState(() => sink.pause!(), () => sink.resume!(),
    { onDisable: () => plugin.disableService(sink, cache), onPlaybackSpeed: speed => { void playback?.setRate(speed).catch(() => {}); } });
  const engine: Engine = Object.assign(() => { throw new Error("legacy speech forbidden"); }, {
    synthesizePlan(plan: ReturnType<typeof createNarrationPlan>, file: string) {
      counts.dispatches++; counts.syntheses++; plans.push(plan); writeFileSync(file, wavBytes());
      if (planEngine) return planEngine.synthesizePlan!(plan, file);
      const p = process(); if (!mode.synthesis) p.finish(); return p;
    },
  });
  const sink = createSpeechSink({ cache, engine, isPaused: state.isPaused, isEnabled: state.isEnabled,
    preparePlan: (text, language, policy) => {
      counts.parses++; const plan = createNarrationPlan(text, language, policy);
      return mode.prepare ? new Promise<typeof plan>(r => { prepared = () => r(plan); }) : plan;
    }, player: file => {
      played.push({ file, bytes: readFileSync(file) });
      if (playback) return playback.play(file);
      const p = process(); if (!mode.playback) p.finish(); return p;
    } });
  const wrapped = withPause(sink, state.isPaused, state.isEnabled);
  const hooks = createOpenVox(client, "/d", wrapped, state,
    { instance: cache.instance, publish: async s => { replies.push(s); } });
  let request = 0;
  const send = (message: object) => hooks.event!({ event: { type: "tui.command.execute",
    properties: { command: encodeCommand({ sessionID: "s", expires: Date.now() + 1500, ...message } as any) } } } as any);
  const control = (action: string, target = cache.instance) => send({ kind: "control", instance: target, action, requestID: `r-${++request}` });
  const status = async () => { await send({ kind: "hello", challenge: `c-${++request}` }); return decodeCommand(replies.at(-1))!; };
  // These PN fixtures call the sink directly, without an observed host response.
  // Exercise its cached playback path; response-bound host authorization is covered above.
  const repeat = (revision: number) => wrapped.repeat!("s", revision);
  const say = (text = "**API** Open editor.") => wrapped({ sessionID: "s", messageID: `m-${++request}`, text });
  return { cache, state, sink, wrapped, hooks, counts, mode, processes, plans, played, say, control, status, repeat, send,
    prepared: () => prepared(), close: () => hooks.dispose!() };
}

describe("PN service lifecycle", () => {
  test("default createOpenVox state binds Off to owned stop and leaves transport live for On", async () => {
    const f = fakeSink(), replies: string[] = [];
    const hooks = createOpenVox(client, "/d", f.sink, undefined,
      { instance: "default", publish: async s => { replies.push(s); } });
    const send = (action: string) => hooks.event!({ event: { type: "tui.command.execute", properties: {
      command: encodeCommand({ kind: "control", instance: "default", sessionID: "s", requestID: action.replace(/[^\w-]/g, "-"),
        action, expires: Date.now() + 1500 } as any) } } } as any);
    try {
      await send("speed:2");
      await send("disable"); expect(f.stops()).toBe(1);
      await hooks.event!({ event: { type: "tui.command.execute", properties: { command: encodeCommand({
        kind: "hello", challenge: "off", sessionID: "s", expires: Date.now() + 1500 }) } } } as any);
      expect(decodeCommand(replies.at(-1))).toMatchObject({ enabled: false, playbackSpeed: 2 });
      await send("enable"); expect(f.resumes()).toBe(0); expect(f.stops()).toBe(1);
    } finally { await hooks.dispose!(); }
  });

  test("Off cancels pending PN preparation and late synthesis, clears eligibility, and On cannot resurrect them", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-vox-u05-")), h = pnService(root);
    try {
      h.mode.prepare = true; const pending = h.say();
      await h.control("disable"); await h.say("Off admission must not parse.");
      expect(h.counts.parses).toBe(1);
      await h.control("enable"); h.prepared(); await pending;
      expect(h.counts.syntheses).toBe(0);
      h.mode.prepare = false; h.mode.synthesis = true;
      const active = h.say(), queued = h.say("Queued PN work.");
      const p = h.processes[0]!; p.kill = () => { p.killed = true; };
      await h.control("disable"); const off = await h.status();
      await h.control("enable"); p.finish();
      await Bun.sleep(0); h.sink.stop(); await Promise.all([active, queued]);
      expect(off).toMatchObject({ enabled: false, paused: false, revision: 0 });
      expect(p.killed).toBe(true); expect(h.cache.current()).toBeUndefined();
      expect(h.counts.syntheses).toBe(1); expect(h.played).toEqual([]);
      h.mode.synthesis = false; await h.say();
      expect(h.counts.syntheses).toBe(2);
    } finally { await h.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("frozen playback Off releases its file, preserves another instance and permits new bounded PN plans only", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-vox-u05-")), a = pnService(root), b = pnService(root);
    try {
      await b.say(); const other = b.cache.current()!;
      a.mode.playback = true; const active = a.say(); await Bun.sleep(0);
      const old = a.cache.current()!, playback = a.processes.at(-1)!;
      await a.control("pause"); await Bun.sleep(0);
      await a.control("disable"); await b.control("disable", a.cache.instance);
      const cancelled = playback.killed; a.sink.stop(); await active;
      expect(existsSync(old.file)).toBe(false); expect(cancelled).toBe(true);
      expect(await a.status()).toMatchObject({ enabled: false, paused: false, revision: 0 });
      expect(b.cache.current()).toEqual(other); expect((await b.status()).enabled).toBe(true);
      await a.control("enable"); await a.repeat(old.revision);
      expect(a.played).toHaveLength(1); expect(playback.resumes).toBe(0);
      a.mode.playback = false;
      for (const text of ["**API** Open editor.", "Open editor API. ".repeat(400)]) {
        await a.say(text); const plan = a.plans.at(-1)!;
        expect(plan.original).toBe(text); expect(plan.defaultLanguage).toBe("es");
        expect(flattenNarrationPlan(plan).length).toBeLessThanOrEqual(4000);
      }
      expect(a.cache.current()!.revision).toBeGreaterThan(old.revision);
    } finally { await a.close(); await b.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("Repeat reuses exact owned file/revision/bytes with zero additional parser or fake plan-engine calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-vox-u05-")), h = pnService(root);
    try {
      await h.say(); const audio = h.cache.current()!, before = { ...h.counts };
      await h.repeat(audio.revision);
      expect(h.counts).toEqual(before); expect(h.cache.current()).toEqual(audio);
      expect(h.played).toEqual([{ file: audio.file, bytes: wavBytes() }, { file: audio.file, bytes: wavBytes() }]);
      await h.control("disable"); await h.control("enable"); await h.repeat(audio.revision);
      expect(h.played).toHaveLength(2); expect(h.cache.current()).toBeUndefined();
      expect(h.counts).toEqual(before);
    } finally { await h.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("bound PN instance retains scoped session cancellation and ignores another session's error/update", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-vox-u05-")), h = pnService(root);
    try {
      h.mode.synthesis = true; const active = h.say();
      const p = h.processes[0]!;
      const event = (value: any) => h.hooks.event!({ event: value });
      await event({ type: "session.error", properties: { sessionID: "other" } });
      await event({ ...user("other-user", 1), properties: { info: { ...user("other-user", 1).properties.info, sessionID: "other" } } });
      expect(p.killed).toBe(false);
      await event({ type: "session.error", properties: { sessionID: "s" } }); await active;
      expect(p.killed).toBe(true); expect(h.cache.current()).toBeUndefined();
      const next = h.say(), nextProc = h.processes.at(-1)!;
      const ownUser = { ...user("own-user", 2), properties: { info: { ...user("own-user", 2).properties.info, sessionID: "s" } } };
      await event(ownUser); await next; expect(nextProc.killed).toBe(true);
      const after = h.say(), afterProc = h.processes.at(-1)!;
      await event(ownUser); expect(afterProc.killed).toBe(false);
      afterProc.finish(); await after;
    } finally { await h.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

describe("closed instance playback rate state", () => {
  test("starts at 1x and stores before one callback per actual change", () => {
    const seen: number[] = [];
    const state: ReturnType<typeof createPauseState> = createPauseState(() => {}, undefined,
      { onPlaybackSpeed: speed => { seen.push(speed, state.getPlaybackSpeed()); } });
    expect(state.getPlaybackSpeed()).toBe(1);
    state.setPlaybackSpeed(1); expect(seen).toEqual([]);
    state.setPlaybackSpeed(1.5); state.setPlaybackSpeed(1.5);
    expect(state.getPlaybackSpeed()).toBe(1.5); expect(seen).toEqual([1.5, 1.5]);
    state.setPlaybackSpeed(2); state.setPlaybackSpeed(1);
    expect(seen).toEqual([1.5, 1.5, 2, 2, 1, 1]);
  });

  test("callback failures are contained without rolling back the stored preference", () => {
    const state = createPauseState(() => {}, undefined, { onPlaybackSpeed: () => { throw new Error("rate failure"); } });
    expect(() => state.setPlaybackSpeed(2)).not.toThrow(); expect(state.getPlaybackSpeed()).toBe(2);
  });

  test("invalid values never reach the callback", () => {
    const seen: number[] = [];
    const state = createPauseState(() => {}, undefined, { onPlaybackSpeed: speed => { seen.push(speed); } });
    for (const bad of [0, -1, 0.5, 2.5, 3, 8, NaN, Infinity, "2", null, undefined]) state.setPlaybackSpeed(bad as never);
    expect(state.getPlaybackSpeed()).toBe(1); expect(seen).toEqual([]);
  });

  test("Off and static incapability refuse changes; paused changes work and Off/On keeps the rate", () => {
    const seen: number[] = [];
    const state = createPauseState(() => {}, () => {}, { onPlaybackSpeed: speed => { seen.push(speed); } });
    state.setEnabled(false); state.setPlaybackSpeed(2);
    expect([state.getPlaybackSpeed(), seen]).toEqual([1, []]);
    state.setEnabled(true); state.setPlaybackSpeed(2);
    state.setPaused(true); state.setPlaybackSpeed(1.5);
    expect([state.isPaused(), state.getPlaybackSpeed()]).toEqual([true, 1.5]);
    state.setPaused(false); state.setEnabled(false); state.setEnabled(true);
    expect([state.getPlaybackSpeed(), seen]).toEqual([1.5, [2, 1.5]]);
    const incapable = createPauseState(() => {}, undefined, { capable: false, onPlaybackSpeed: speed => { seen.push(speed); } });
    incapable.setEnabled(true); incapable.setPlaybackSpeed(2);
    expect([incapable.getPlaybackSpeed(), seen]).toEqual([1, [2, 1.5]]);
  });
});

/** The persistent player is real; only its child process and acknowledgments are fake. */
function ratePlayer() {
  const hosts: Array<HostProcess & { sent: string[]; emit(event: object): void; die(): void }> = [];
  const player = createPlayer({ idleMs: 0, readyTimeoutMs: 1000, openTimeoutMs: 1000, requestTimeoutMs: 40,
    fallback: () => { throw new Error("unexpected fallback"); }, spawnHost: () => {
      let listener!: (line: string) => void, finish!: (code: number) => void;
      const host = { sent: [] as string[], exited: new Promise<number>(r => { finish = r; }),
        send(line: string) { host.sent.push(line); }, kill() { finish(1); }, die() { finish(1); },
        onLine(fn: (line: string) => void) { listener = fn; }, emit(event: object) { listener(JSON.stringify(event)); } };
      hosts.push(host); return host;
    } });
  return { player, hosts };
}

describe("PN playback rate binding", () => {
  test("closed wire targets preserve PN audio and instance isolation without extra preparation or synthesis", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-vox-u09-")), a = pnService(root), b = pnService(root);
    try {
      await a.say(); const audio = a.cache.current()!, before = { ...a.counts }, plan = a.plans[0]!;
      expect((await a.status()).playbackSpeed).toBe(1); expect((await b.status()).playbackSpeed).toBe(1);
      for (const [action, speed] of [["speed:1.5", 1.5], ["speed:2", 2], ["speed:1", 1]] as const) {
        await a.control(action); await b.control(action, a.cache.instance);
        expect((await a.status()).playbackSpeed).toBe(speed);
        expect((await b.status()).playbackSpeed).toBe(1);
        await a.repeat(audio.revision);
        expect(a.cache.current()).toEqual(audio); expect(readFileSync(audio.file)).toEqual(wavBytes());
        expect(a.counts).toEqual(before); expect(a.plans).toEqual([plan]);
      }
      expect(a.played).toHaveLength(4);
      const targeted = { kind: "control", instance: a.cache.instance, requestID: "rate-replay", action: "speed:2" };
      await a.send(targeted); await a.send({ ...targeted, action: "speed:1.5" });
      expect((await a.status()).playbackSpeed).toBe(2); // A replay cannot change its explicit target.
      await a.control("speed:2"); expect((await a.status()).playbackSpeed).toBe(2);
      await a.control("speed:1");
      for (const action of ["speed:2.5", "speed:0"]) await a.control(action);
      await a.hooks.event!({ event: { type: "tui.command.execute", properties: { command: encodeCommand({
        kind: "control", instance: a.cache.instance, sessionID: "s", requestID: "expired", action: "speed:2", expires: Date.now() - 1 }) } } } as any);
      expect((await a.status()).playbackSpeed).toBe(1);
      await a.control("speed:2"); await a.control("disable"); await a.control("speed:1.5"); await a.control("enable");
      expect((await a.status()).playbackSpeed).toBe(2); expect(a.cache.current()).toBeUndefined();
      expect(a.counts).toEqual(before);
      await a.close(); await a.control("speed:1"); expect(a.state.getPlaybackSpeed()).toBe(2);
    } finally { await a.close(); await b.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("rate changes during async PN preparation neither invalidate the generation nor duplicate the plan", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-vox-u09-")), h = pnService(root);
    try {
      h.mode.prepare = true; const pending = h.say();
      await h.control("speed:2"); expect(h.counts).toEqual({ parses: 1, dispatches: 0, syntheses: 0 });
      h.prepared(); await pending;
      expect(h.counts).toEqual({ parses: 1, dispatches: 1, syntheses: 1 });
      expect(h.plans).toHaveLength(1); expect((await h.status()).playbackSpeed).toBe(2);
      expect(h.cache.current()).toBeDefined();
      h.mode.prepare = false; h.mode.synthesis = true;
      const synthesizing = h.say("Second bounded source plan."), process = h.processes.at(-1)!;
      const before = { ...h.counts };
      await h.control("speed:1.5"); expect(process.killed).toBe(false); expect(h.counts).toEqual(before);
      process.finish(); await synthesizing;
      expect(h.counts).toEqual(before); expect(h.cache.current()).toBeDefined(); expect(h.plans).toHaveLength(2);
    } finally { await h.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("live, paused and replacement-player rates retain exact PN plan, voice, synthesis speed and WAV", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-vox-u09-")), p = ratePlayer(), calls: string[][] = [];
    const engine = kokoroEngine({ python: "fake-python", script: "fake-script", modelPath: "fake-model", voicesPath: "fake-voices",
      voices: { es: "em_alex", en: "af_heart" }, speed: 1.2, tmpDir: root, unlink() {},
      run: (_command, args) => { calls.push(args); return { exited: Promise.resolve(0), kill() {} }; } });
    const h = pnService(root, p.player, engine);
    try {
      await h.control("speed:2"); expect(p.hosts).toHaveLength(0);
      const active = h.say(); await Bun.sleep(0);
      const host = p.hosts[0]!; host.emit({ event: "ready" }); await Bun.sleep(0);
      const audio = h.cache.current()!, before = { ...h.counts }, plan = h.plans[0]!;
      expect(host.sent).toEqual(["rate 2", `play ${audio.file}`]);
      host.emit({ event: "opened", durationMs: 5000 }); host.emit({ event: "playing" });
      await h.control("speed:1.5"); expect(host.sent.at(-1)).toBe("rate 1.5"); host.emit({ event: "rate", value: 1.5 });
      const paused = h.control("pause"); host.emit({ event: "paused", positionMs: 17 }); await paused;
      await h.control("speed:2"); host.emit({ event: "rate", value: 2 });
      expect(await h.status()).toMatchObject({ paused: true, enabled: true, playbackSpeed: 2 });
      expect(host.sent).not.toContain("resume");
      await h.hooks.event!({ event: { type: "session.error", properties: { sessionID: "other" } } as any });
      await h.hooks.event!({ event: { ...user("other-user", 1), properties: { info: { ...user("other-user", 1).properties.info, sessionID: "other" } } } });
      expect(host.sent).not.toContain("stop");
      const resumed = h.control("resume"); host.emit({ event: "playing" }); await resumed;
      host.emit({ event: "ended" }); await active;
      host.die(); await Bun.sleep(0);
      const replay = h.repeat(audio.revision); await Bun.sleep(0);
      const replacement = p.hosts[1]!; replacement.emit({ event: "ready" }); await Bun.sleep(0);
      expect(replacement.sent).toEqual(["rate 2", `play ${audio.file}`]);
      replacement.emit({ event: "opened", durationMs: 100 }); replacement.emit({ event: "ended" }); await replay;
      expect(h.cache.current()).toEqual(audio); expect(readFileSync(audio.file)).toEqual(wavBytes());
      expect(h.counts).toEqual(before); expect(h.plans).toEqual([plan]); expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(expect.arrayContaining(["--plan-json", "em_alex", "1.2"]));
      expect(h.played).toEqual([{ file: audio.file, bytes: wavBytes() }, { file: audio.file, bytes: wavBytes() }]);
    } finally { await h.close(); await p.player.dispose(); rmSync(root, { recursive: true, force: true }); }
  });
});
