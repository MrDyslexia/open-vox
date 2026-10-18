import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { COUNTER_KEYS, STARTUP_STAGES, REQUEST_STAGES, NarrationWorker, type WorkerChild, type WorkerLaunch, type WorkerOptions, type WorkerCounters } from "../src/narration-worker";
import { createSpeechSink } from "../src/speech-sink";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const launch: WorkerLaunch = { command: "python", args: [], identity: "assets-1" };
const payload = { mode: "text", input: "¡Sí! 😀", voice: "em_alex", lang: "es", speed: 1,
  toneVoice: "", toneWeight: 0, output: "candidate.wav" };

function harness(options: WorkerOptions = {}) {
  const children: ReturnType<typeof child>[] = [];
  function child(args: string[]) {
    const c = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), pid: 100,
      kills: 0, kill(): boolean { c.kills++; return true; } });
    const arg = (name: string) => args[args.indexOf(name) + 1];
    const identity = { v: 1, owner: arg("--owner"), generation: arg("--generation") };
    const requests: any[] = [];
    c.stdin.on("data", data => requests.push(JSON.parse(data.toString())));
    const send = (value: unknown) => c.stdout.write(JSON.stringify(value) + "\n");
    return Object.assign(c, { requests, identity, send,
      ready: () => send({ ...identity, type: "ready" }),
      result: (extra = {}) => send({ ...identity, type: "result", request: requests.at(-1)?.request,
        code: 0, diagnostics: ["kokoro-onnx-provider-cpu"], ...extra }),
      close: () => c.emit("close", 1),
    });
  }
  const worker = new NarrationWorker({ ...options, spawn: (_cmd, args) => {
    const c = child(args); children.push(c); return c as unknown as WorkerChild;
  } });
  return { worker, children };
}

test("sequential request handles reuse a child and preserve their own snapshots", async () => {
  const h = harness();
  const a = h.worker.request(launch, payload); await tick();
  const c = h.children[0]!; c.ready(); await tick();
  expect(c.requests[0].input).toBe("¡Sí! 😀"); c.result();
  expect(await a.exited).toBe(0);
  const b = h.worker.request(launch, { ...payload, input: "Different text", speed: 1.2 }); await tick();
  expect(h.children).toHaveLength(1); expect(c.requests).toHaveLength(2);
  c.result({ diagnostics: ["kokoro-onnx-provider-cuda"] }); expect(await b.exited).toBe(0);
  expect(a.devices?.()).toEqual({ kokoro: "cpu" }); expect(b.devices?.()).toEqual({ kokoro: "gpu" });
  const done = h.worker.dispose(); c.close(); await done;
});

test("correlated counters are detached, reset on generation replacement and contain no payload", async () => {
  const h = harness(); const p = h.worker.request(launch, payload); await tick();
  const c = h.children[0]!; c.ready(); await tick();
  const counters = Object.fromEntries(COUNTER_KEYS.map(k => [k, k === "lidRuns" ? null : 1])) as WorkerCounters;
  c.send({ ...c.identity, type: "stats", request: c.requests[0].request, ...counters }); c.result(); await p.exited;
  const s = h.worker.snapshot(); expect(s.counters).toEqual(counters); expect(s.pid).toBe(100);
  (s.counters as any).kokoroLoads = 900; expect(h.worker.snapshot().counters.kokoroLoads).toBe(1);
  expect(JSON.stringify(s)).not.toContain(payload.input);
  h.worker.release(); c.close();
  const next = h.worker.request(launch, payload); await tick();
  expect(h.worker.snapshot().generation).not.toBe(s.generation);
  expect(Object.values(h.worker.snapshot().counters).every(v => v === null)).toBe(true);
  h.children[1]!.close(); await next.exited; await h.worker.dispose();
});

test("bounded progress updates milestones only, never readiness, completion, devices or counters", async () => {
  const h = harness(), p = h.worker.request(launch, payload); await tick(); const c = h.children[0]!;
  let settled = false; void p.exited.then(() => { settled = true; });
  for (const stage of STARTUP_STAGES) c.send({ ...c.identity, type: "progress", request: null, stage });
  await tick(); expect(h.worker.snapshot().milestone).toBe("kokoro-load");
  expect(h.worker.snapshot().state).toBe("starting"); expect(c.requests).toHaveLength(0); expect(settled).toBe(false);
  c.ready(); await tick();
  for (const stage of REQUEST_STAGES) c.send({ ...c.identity, type: "progress", request: c.requests[0].request, stage });
  await tick(); expect(h.worker.snapshot().milestone).toBe("result"); expect(settled).toBe(false);
  expect(Object.values(h.worker.snapshot().counters).every(n => n === null)).toBe(true);
  expect(p.devices?.()).toBeUndefined();
  c.result(); expect(await p.exited).toBe(0);
  const done = h.worker.dispose(); c.close(); await done;
});

test.each(["unknown", "owner", "generation", "request", "startup-id", "extra", "duplicate", "escaped-key", "oversized", "startup-after-ready"])("progress %s rejects without success or replay", async kind => {
  const h = harness(), p = h.worker.request(launch, payload); await tick(); const c = h.children[0]!;
  const frame: any = { ...c.identity, type: "progress", request: null, stage: "imports" };
  if (["request", "startup-after-ready"].includes(kind)) { c.ready(); await tick(); frame.request = c.requests[0].request; frame.stage = "request-read"; }
  if (kind === "unknown") frame.stage = "private-prose";
  if (kind === "owner") frame.owner = "foreign";
  if (kind === "generation") frame.generation = "foreign";
  if (kind === "request" || kind === "startup-id") frame.request = "foreign";
  if (kind === "extra") frame.input = "forbidden";
  if (kind === "startup-after-ready") { frame.stage = "imports"; frame.request = null; }
  if (kind === "escaped-key") c.stdout.write(JSON.stringify(frame).replace('"stage"', '"sta\\u0067e"') + "\n");
  else if (kind === "oversized") c.stdout.write(JSON.stringify({ ...frame, stage: "x".repeat(8193) }) + "\n");
  else c.send(frame);
  if (kind === "duplicate") c.send(frame);
  expect(c.kills).toBe(1); expect(h.worker.snapshot().failure).toBe("protocol-rejection");
  c.close(); expect(await p.exited).not.toBe(0); expect(p.devices?.()).toBeUndefined();
  expect(h.children).toHaveLength(1); await h.worker.dispose();
});

test.each(["startup", "request"])("%s timeout survives close in metadata; progress cannot extend the deadline", async kind => {
  const h = harness({ startupMs: 15, requestMs: 15 }), p = h.worker.request(launch, payload);
  await tick(); const c = h.children[0]!;
  if (kind === "startup") c.send({ ...c.identity, type: "progress", request: null, stage: "imports" });
  else { c.ready(); await tick(); c.send({ ...c.identity, type: "progress", request: c.requests[0].request, stage: "synthesis" }); }
  await new Promise(resolve => setTimeout(resolve, 35));
  const before = h.worker.snapshot(); expect(before.failure).toBe(`${kind}-timeout`);
  expect(c.kills).toBe(1); c.close(); expect(await p.exited).not.toBe(0);
  expect(h.worker.snapshot()).toMatchObject({ generation: before.generation, pid: 100,
    milestone: before.milestone, failure: before.failure, state: "stopped" });
  const copy = h.worker.snapshot(); (copy.counters as any).kokoroLoads = 500;
  expect(h.worker.snapshot().counters.kokoroLoads).toBeNull();
  await h.worker.dispose();
});

test.each([{ value: -1 }, { value: 1e12 }, { value: 0.5 }, { value: "1" }, { value: true },
  { value: {} }, { value: [] }])("invalid counter retires only its owned child", async ({ value }) => {
  const h = harness(); const p = h.worker.request(launch, payload); await tick();
  const c = h.children[0]!; c.ready(); await tick();
  c.send({ ...c.identity, type: "stats", request: c.requests[0].request,
    ...Object.fromEntries(COUNTER_KEYS.map(k => [k, 1])), kokoroLoads: value });
  expect(c.kills).toBe(1); c.close(); expect(await p.exited).not.toBe(0); await h.worker.dispose();
});

test.each(["foreign", "missing", "extra", "duplicate", "duplicate-key", "decrease"])("stats %s fails closed", async kind => {
  const h = harness(); const p = h.worker.request(launch, payload); await tick();
  const c = h.children[0]!; c.ready(); await tick();
  const stats: any = { ...c.identity, type: "stats", request: c.requests[0].request,
    ...Object.fromEntries(COUNTER_KEYS.map(k => [k, 1])) };
  if (kind === "foreign") stats.request = "not-owned";
  if (kind === "missing") delete stats.lidLoads;
  if (kind === "extra") stats.text = "forbidden";
  if (kind === "duplicate-key") c.stdout.write(JSON.stringify(stats).replace('"kokoroLoads":1', '"kokoroLoads":1,"kokoroLoads":1') + "\n");
  else c.send(stats);
  if (kind === "duplicate") c.send(stats);
  if (kind === "decrease") {
    c.result(); expect(await p.exited).toBe(0);
    const next = h.worker.request(launch, payload); await tick();
    c.send({ ...stats, request: c.requests.at(-1).request, kokoroLoads: 0 });
    c.close(); expect(await next.exited).not.toBe(0);
  } else { expect(c.kills).toBe(1); c.close(); expect(await p.exited).not.toBe(0); }
  await h.worker.dispose();
});

test("instances have independent owners; cancellation waits for owned close, not another child", async () => {
  const a = harness(), b = harness();
  const pa = a.worker.request(launch, payload), pb = b.worker.request(launch, payload); await tick();
  const ca = a.children[0]!, cb = b.children[0]!;
  expect(ca.identity.owner).not.toBe(cb.identity.owner);
  ca.ready(); cb.ready(); await tick();
  let ended = false; void pa.exited.then(() => { ended = true; }); pa.kill(); await tick();
  expect(ca.kills).toBe(1); expect(cb.kills).toBe(0); expect(ended).toBe(false);
  cb.result(); expect(await pb.exited).toBe(0); ca.close(); expect(await pa.exited).not.toBe(0);
  const again = a.worker.request(launch, payload); await tick(); const fresh = a.children[1]!;
  expect(fresh.identity.generation).not.toBe(ca.identity.generation);
  fresh.ready(); await tick(); fresh.result(); expect(await again.exited).toBe(0);
  const da = a.worker.dispose(), db = b.worker.dispose(); fresh.close(); cb.close(); await Promise.all([da, db]);
});

test.each(["foreign", "generation", "unknown", "duplicate-key", "oversized", "malformed", "duplicate-result",
  "extra-key", "escaped-key", "diagnostic-type", "diagnostic-count", "duplicate-ready"])("%s response faults without replay or devices", async kind => {
  const h = harness(); const p = h.worker.request(launch, payload); await tick();
  const c = h.children[0]!; c.ready(); await tick();
  if (kind === "foreign") c.result({ request: "foreign" });
  if (kind === "generation") c.result({ generation: "foreign" });
  if (kind === "unknown") c.stdout.write("native warning\n");
  if (kind === "duplicate-key") c.stdout.write('{"v":1,"v":1}\n');
  if (kind === "oversized") c.stdout.write("x".repeat(8193));
  if (kind === "malformed") c.stdout.write(Buffer.from([0xff, 10]));
  if (kind === "duplicate-result") { c.result(); c.result(); }
  if (kind === "extra-key") c.result({ secret: "unexpected" });
  if (kind === "escaped-key") c.stdout.write('{"v":1,"\\u0076":1}\n');
  if (kind === "diagnostic-type") c.result({ diagnostics: [4] });
  if (kind === "diagnostic-count") c.result({ diagnostics: Array.from({ length: 33 }, (_, i) => `code-${i}`) });
  if (kind === "duplicate-ready") c.ready();
  await tick(); expect(c.kills).toBe(1); expect(h.children).toHaveLength(1);
  c.close(); await p.exited;
  if (kind !== "duplicate-result") expect(p.devices?.()).toBeUndefined();
  await h.worker.dispose();
});

test("split UTF-8/frame boundaries are assembled; bounded request rejection starts no child", async () => {
  const h = harness();
  expect(await h.worker.request(launch, { ...payload, input: "é".repeat(600_000) }).exited).toBe(2);
  expect(h.children).toHaveLength(0);
  const p = h.worker.request(launch, payload); await tick(); const c = h.children[0]!;
  const ready = Buffer.from(JSON.stringify({ ...c.identity, type: "ready" }) + "\n");
  for (const b of ready) c.stdout.write(Buffer.from([b])); await tick();
  // Invalid non-ASCII diagnostics are rejected even when a multibyte sequence straddles chunks.
  const frame = Buffer.from(JSON.stringify({ ...c.identity, type: "result", request: c.requests[0].request,
    code: 0, diagnostics: ["accent-é-😀"] }) + "\n");
  for (const b of frame) c.stdout.write(Buffer.from([b]));
  expect(c.kills).toBe(1); c.close(); expect(await p.exited).toBe(1); await h.worker.dispose();
});

test("concurrent admission rejects only the extra request; a failed request can reuse the healthy child", async () => {
  const h = harness(); const p = h.worker.request(launch, payload);
  expect(await h.worker.request(launch, payload).exited).toBe(2);
  await tick(); const c = h.children[0]!; c.ready(); await tick(); c.result({ code: 2, diagnostics: [] });
  expect(await p.exited).toBe(2); expect(p.devices?.()).toBeUndefined();
  const next = h.worker.request(launch, payload); await tick(); p.kill(); expect(c.kills).toBe(0);
  c.result(); expect(await next.exited).toBe(0); expect(h.children).toHaveLength(1);
  const done = h.worker.dispose(); c.close(); await done;
  expect(await h.worker.request(launch, payload).exited).toBe(2);
});

test.each(["startup", "request", "crash"])("%s failure waits for close and never replays", async kind => {
  const h = harness({ startupMs: 10, requestMs: 10 }); const p = h.worker.request(launch, payload);
  await tick(); const c = h.children[0]!;
  if (kind !== "startup") { c.ready(); await tick(); }
  if (kind === "crash") c.emit("error", Error("fake spawn failure"));
  else await new Promise(resolve => setTimeout(resolve, 25));
  expect(c.kills).toBe(1); expect(h.children).toHaveLength(1);
  let finished = false; void p.exited.then(() => { finished = true; }); await tick(); expect(finished).toBe(false);
  c.close(); expect(await p.exited).toBe(1); expect(p.devices?.()).toBeUndefined(); await h.worker.dispose();
});

test.each(["identity", "release", "idle"])("%s retirement waits for close then replaces the generation", async kind => {
  const h = harness({ idleMs: 10 }); const a = h.worker.request(launch, payload); await tick();
  const old = h.children[0]!; old.ready(); await tick(); old.result(); await a.exited;
  if (kind === "release") h.worker.release();
  if (kind === "idle") await new Promise(resolve => setTimeout(resolve, 25));
  const next = h.worker.request({ ...launch, identity: kind === "identity" ? "assets-2" : launch.identity }, payload);
  await tick(); expect(h.children).toHaveLength(1); expect(old.kills).toBe(1);
  old.close(); await tick(); const fresh = h.children[1]!;
  fresh.ready(); await tick(); fresh.result(); expect(await next.exited).toBe(0);
  const done = h.worker.dispose(); fresh.close(); await done;
});

test("dispose reports a missing close but never releases the pending writer hold early", async () => {
  const h = harness({ shutdownMs: 10 }); const p = h.worker.request(launch, payload); await tick();
  let ended = false; void p.exited.then(() => { ended = true; });
  await expect(h.worker.dispose()).rejects.toThrow("did not close"); expect(ended).toBe(false);
  h.children[0]!.close(); expect(await p.exited).toBe(1);
});

test("sink retains a cancelled candidate until child close, preserves B, and Repeat has zero requests", async () => {
  const h = harness(); let held = 0, promoted = 0, discarded = 0, serial = 0;
  let audio: { file: string; sessionID: string; revision: number } | undefined;
  const cache = { candidate: () => `candidate-${++serial}.wav`, current: () => audio,
    promote: (file: string, sessionID: string) => { promoted++; audio = { file, sessionID, revision: promoted }; return true; },
    hold: () => { held++; return () => { held--; }; }, discard() { discarded++; }, forget() {}, clear() {}, dispose() {} };
  const engine = Object.assign(() => { throw Error("cached only"); }, {
    synthesizePlan: (_plan: unknown, output: string) => h.worker.request(launch, { ...payload, output }),
    release: () => h.worker.release(), dispose: () => h.worker.dispose(),
  });
  const sink = createSpeechSink({ cache, engine, player: () => ({ exited: Promise.resolve(0), kill() {} }) });
  const a = sink({ sessionID: "A", messageID: "a", text: "First" }); await tick();
  const ca = h.children[0]!; ca.ready(); await tick();
  const b = sink({ sessionID: "B", messageID: "b", text: "Second" });
  sink.removeSession!("A"); await tick();
  expect(held).toBe(1); expect(discarded).toBe(0); expect(promoted).toBe(0);
  expect(h.children).toHaveLength(1); ca.close(); await tick();
  const cb = h.children[1]!; cb.ready(); await tick(); cb.result(); await Promise.all([a, b]);
  expect(held).toBe(0); expect(discarded).toBe(1); expect(promoted).toBe(1);
  expect(audio?.sessionID).toBe("B");
  await sink.repeat!("B", 1); expect(cb.requests).toHaveLength(1); expect(h.children).toHaveLength(2);
  const done = sink.dispose!(); cb.close(); await done;
});
