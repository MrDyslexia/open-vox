import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AudioCache } from "../src/audio-cache";
import { DEFAULT_CONFIG, type RuntimeProfile } from "../src/config";
import { defaultKokoroEngine } from "../src/kokoro-engine";
import { COUNTER_KEYS, STARTUP_STAGES, REQUEST_STAGES, WORKER_FAILURES, type WorkerSnapshot } from "../src/narration-worker";
import { createSpeechSink, type Engine, type SpeechSink } from "../src/speech-sink";

export type Arguments = { profile: RuntimeProfile; requests: number; out: string; idleMs?: number };
class AcceptanceFailure extends Error {
  constructor(readonly identifier: string) { super("Owned harness check failed"); }
}
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new AcceptanceFailure(code); }

export function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  let silent = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (key === "--no-playback") { check(!silent, "duplicate-argument"); silent = true; continue; }
    check(["--profile", "--requests", "--out", "--idle-ms"].includes(key) && !values.has(key), "invalid-argument");
    const value = argv[++i]; check(value && !value.startsWith("--"), "missing-value"); values.set(key, value);
  }
  const profile = values.get("--profile"), count = values.get("--requests");
  check(silent && (profile === "cpu" || profile === "cuda13"), "explicit-no-playback-profile-required");
  check(count && /^(?:[3-9]|1[0-9]|20)$/.test(count), "invalid-request-count");
  const out = values.get("--out"); check(out, "output-required");
  const idle = values.get("--idle-ms");
  check(idle === undefined || (/^[0-9]+$/.test(idle) && Number(idle) >= 1000 && Number(idle) <= 60_000), "invalid-idle-override");
  return { profile, requests: Number(count), out, ...(idle === undefined ? {} : { idleMs: Number(idle) }) };
}

/** A fresh direct child of approved scratch only; never follow redirected ancestors or overwrite results. */
export function reserveOutput(out: string, approved = join(tmpdir(), "opencode")): string {
  check(isAbsolute(out) && !out.startsWith("\\\\") && !out.split(/[\\/]/).includes(".."), "unsafe-output");
  const root = resolve(approved), target = resolve(out);
  check(dirname(target).toLowerCase() === root.toLowerCase() && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(basename(target)), "unsafe-output");
  for (let at = root;; at = dirname(at)) {
    const stat = lstatSync(at);
    check(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(at).toLowerCase() === at.toLowerCase(), "redirected-output");
    if (dirname(at) === at) break;
  }
  check(!existsSync(target), "output-exists"); mkdirSync(target); return target;
}

/** AudioCache checks container ownership; this independently checks complete, nonempty integer PCM frames. */
export function waveMetrics(file: string) {
  let b: Buffer;
  try { b = readFileSync(file); } catch { throw new AcceptanceFailure("wave-read-failed"); }
  check(b.length >= 44 && b.length <= 64 * 1024 * 1024 && b.toString("ascii", 0, 4) === "RIFF"
    && b.toString("ascii", 8, 12) === "WAVE" && b.readUInt32LE(4) + 8 === b.length, "invalid-wave");
  let align = 0, rate = 0, dataBytes = 0, formats = 0, chunks = 0, at = 12;
  for (; at + 8 <= b.length;) {
    const size = b.readUInt32LE(at + 4), start = at + 8;
    check(start + size <= b.length, "invalid-wave-chunk");
    const kind = b.toString("ascii", at, at + 4);
    if (kind === "fmt ") {
      check(++formats === 1 && size >= 16 && b.readUInt16LE(start) === 1, "unsupported-pcm");
      const channels = b.readUInt16LE(start + 2), bits = b.readUInt16LE(start + 14);
      rate = b.readUInt32LE(start + 4); align = channels * bits / 8;
      check(channels > 0 && rate > 0 && [8, 16, 24, 32].includes(bits)
        && b.readUInt16LE(start + 12) === align && b.readUInt32LE(start + 8) === rate * align, "invalid-pcm");
    }
    if (kind === "data") { check(++chunks === 1, "duplicate-wave-data"); dataBytes = size; }
    at = start + size + size % 2;
  }
  check(at === b.length && formats === 1 && chunks === 1 && dataBytes > 0 && dataBytes % align === 0, "empty-or-partial-pcm");
  // Every 8/16/24/32-bit integer PCM bit pattern is finite; float formats are explicitly rejected.
  const frames = dataBytes / align;
  return { frames, durationSeconds: frames / rate, bytes: b.length, pcmBytes: dataBytes, sampleRate: rate };
}

const synthetic = [
  "## Comprobación\n\nEl café está listo. The server is ready for a careful review.",
  "**Música y precisión.** We verify a different response without playing any audio.",
  "### Última revisión\n\nLa síntesis continúa aquí. Another independent message checks the queue.",
];
type RecordRow = { instance: string; session: string; message: string; chars: number; words: number;
  elapsedMs: number; audio: ReturnType<typeof waveMetrics>; worker: WorkerSnapshot; devices: unknown };
export type Summary = { version: 1; profile: RuntimeProfile; passed: boolean; step: string; idleOverrideMs?: number;
  records: RecordRow[]; checks: string[]; cleanup: boolean; cancelled?: WorkerSnapshot; failure?: string;
  acceptance?: string; failureElapsedMs?: number; beforeCleanup?: FailureEvidence[]; cleanupFailure?: boolean;
  deviceEvidence?: { expected: string; lid: string; kokoro: string } };
type SinkCategory = "sink-timeout" | "wav-invalid" | "engine-capability" | "unknown-error" | typeof WORKER_FAILURES[number];
type SinkFailure = { category: SinkCategory; worker?: WorkerSnapshot };
type FailureEvidence = { instance: "a" | "b"; worker?: WorkerSnapshot; sinkFailure?: SinkFailure };
type Instance = { name: string; engine: Engine; cache: AudioCache; sink: SpeechSink; errors: number; created: number;
  sinkFailure?: SinkFailure };
export type Dependencies = { engine?: (profile: RuntimeProfile, idleMs?: number) => Engine | undefined };

/** Do not serialize exception objects or arbitrary hook properties, even on the failure path. */
function evidence(engine: Engine): WorkerSnapshot | undefined {
  try {
    const s = engine.workerSnapshot?.(), uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!s || !uuid.test(s.owner) || !["stopped", "starting", "busy", "idle", "retiring", "disposed"].includes(s.state)) return;
    return { owner: s.owner, state: s.state,
      generation: s.generation && uuid.test(s.generation) ? s.generation : undefined,
      request: s.request && uuid.test(s.request) ? s.request : undefined,
      pid: Number.isSafeInteger(s.pid) && s.pid! > 0 ? s.pid : undefined,
      milestone: s.milestone && (["spawned", "ready", ...STARTUP_STAGES, ...REQUEST_STAGES] as readonly string[]).includes(s.milestone) ? s.milestone : undefined,
      failure: s.failure && (WORKER_FAILURES as readonly string[]).includes(s.failure) ? s.failure : undefined,
      counters: Object.fromEntries(COUNTER_KEYS.map(k => {
        const n = s.counters[k]; return [k, n !== null && Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000 ? n : null];
      })) as WorkerSnapshot["counters"] };
  } catch { return; }
}

function sinkCategory(error: unknown, worker?: WorkerSnapshot): SinkCategory {
  // Exact locally authored sink messages only; no substring matching or third-party error prose.
  const message = error instanceof Error ? error.message : undefined;
  if (message === "speech process timed out") return "sink-timeout";
  if (message === "Invalid generated audio") return "wav-invalid";
  if (message === "synthesis process exited with code 1" || message === "synthesis process exited with code 2") return worker?.failure ?? "worker-exit";
  if (message === "Engine cannot produce cached audio") return "engine-capability";
  return "unknown-error";
}

function acceptanceCategory(identifier: string): string {
  if (["cache-status", "cache-misassignment"].includes(identifier)) return "cache-status";
  if (identifier === "sink-error") return "sink-error";
  if (identifier === "requested-device-not-used") return "device-evidence";
  if (["load-reuse-unproved", "native-calls-unavailable"].includes(identifier)) return "load-counts";
  if (["wave-read-failed", "invalid-wave", "invalid-wave-chunk", "unsupported-pcm", "invalid-pcm", "duplicate-wave-data", "empty-or-partial-pcm"].includes(identifier)) return "wav-validation";
  if (identifier === "idle-dispose-left-worker") return "cleanup";
  return "acceptance-check";
}

function snapshot(i: Instance): WorkerSnapshot {
  const s = i.engine.workerSnapshot?.(); check(s, "missing-worker-telemetry"); return s;
}
function loaded(s: WorkerSnapshot) {
  check(s.state === "idle" && s.pid && s.generation && s.request, "missing-correlated-worker");
  check(s.counters.kokoroLoads === 1 && s.counters.lidLoads === 1 && s.counters.tokenizerLoads === 1,
    "load-reuse-unproved");
  check((s.counters.kokoroCreates ?? 0) > 0 && (s.counters.kokoroRuns ?? 0) > 0
    && (s.counters.lidRuns ?? 0) > 0, "native-calls-unavailable");
}
async function until(predicate: () => boolean, ms = 5000) {
  const end = performance.now() + ms;
  while (!predicate()) { check(performance.now() < end, "owned-state-deadline"); await Bun.sleep(5); }
}

/** Real default engine + sink + cache. Tests replace only the factory boundary, never CLI production transport. */
export async function runBenchmark(args: Arguments, dependencies: Dependencies = {}): Promise<Summary> {
  const began = performance.now();
  const summary: Summary = { version: 1, profile: args.profile, passed: false, step: "construction",
    idleOverrideMs: args.idleMs, records: [], checks: [], cleanup: false };
  const instances: Instance[] = [];
  let firstSinkFailure: SinkFailure | undefined;
  const ownedEngines: Engine[] = [], ownedCaches: AudioCache[] = [];
  const make = async (name: string): Promise<Instance> => {
    const created = performance.now();
    const engine = dependencies.engine ? dependencies.engine(args.profile, args.idleMs)
      : defaultKokoroEngine(process.env, () => ({ ...DEFAULT_CONFIG, engine: "kokoro", narrationBackend: "onnx",
        runtimeProfile: args.profile }), undefined, { idleMs: args.idleMs });
    check(engine, "kokoro-unavailable");
    ownedEngines.push(engine);
    const cache = new AudioCache(join(args.out, name)); ownedCaches.push(cache);
    const i = { name, engine, cache, errors: 0, created } as Instance;
    i.sink = createSpeechSink({ engine, cache, narrationLanguage: "es", maxPending: 2,
      player: () => ({ exited: Promise.resolve(0), kill() {} }), onError: error => {
        i.errors++;
        if (!i.sinkFailure) { const worker = evidence(engine); i.sinkFailure = { category: sinkCategory(error, worker), worker }; }
        firstSinkFailure ??= i.sinkFailure;
      } });
    instances.push(i); return i;
  };
  const measure = async (i: Instance, serial: number, first = false) => {
    const start = first ? i.created : performance.now(), session = `${i.name}-session-${serial % 2}`;
    const message = `${i.name}-message-${serial}`, text = `${synthetic[serial % synthetic.length]} Verification ${serial}.`;
    const previous = snapshot(i), errors = i.errors;
    await i.sink({ sessionID: session, messageID: message, text });
    const elapsedMs = performance.now() - start;
    const audio = i.cache.current(), worker = snapshot(i);
    check(i.errors === errors, "sink-error");
    check(audio?.sessionID === session && audio.messageID === message, "cache-status");
    loaded(worker);
    if (previous.generation) check(worker.request !== previous.request, "request-id-reused");
    const devices = i.sink.devices?.(session);
    // Safe device-only evidence (no text): kept in the summary so a failed device check is diagnosable.
    summary.deviceEvidence = { expected: args.profile === "cpu" ? "cpu" : "gpu", lid: devices?.lid ?? "absent", kokoro: devices?.kokoro ?? "absent" };
    check(devices?.lid === (args.profile === "cpu" ? "cpu" : "gpu")
      && devices.kokoro === (args.profile === "cpu" ? "cpu" : "gpu"), "requested-device-not-used");
    summary.records.push({ instance: i.name, session, message, chars: [...text].length,
      words: text.trim().split(/\s+/).length, elapsedMs, audio: waveMetrics(audio.file), worker, devices });
    return worker;
  };
  try {
    const a = await make("a"); summary.step = "sequential-reuse";
    let warm: WorkerSnapshot | undefined;
    for (let n = 0; n < args.requests; n++) {
      const current = await measure(a, n, n === 0);
      if (warm) check(current.generation === warm.generation && current.pid === warm.pid, "worker-reloaded");
      warm = current;
    }
    summary.checks.push("sequential-reuse"); summary.step = "repeat";
    const audio = a.cache.current()!, before = snapshot(a);
    await a.sink.repeat!(audio.sessionID, audio.revision);
    check(JSON.stringify(snapshot(a)) === JSON.stringify(before), "repeat-inferred-or-spawned");
    summary.checks.push("repeat-without-inference"); summary.step = "independent-instances";
    const b = await make("b");
    const [wa, wb] = await Promise.all([measure(a, 30), measure(b, 31, true)]);
    check(wa.owner !== wb.owner && wa.pid !== wb.pid && wa.generation !== wb.generation
      && a.cache.directory !== b.cache.directory, "shared-worker-or-cache");
    summary.checks.push("independent-instances"); summary.step = "owned-cancellation-and-deletion";
    const old = a.cache.current()!;
    const cancelled = a.sink({ sessionID: "delete-active", messageID: "cancelled", text: synthetic.join("\n").repeat(5) });
    await until(() => snapshot(a).state === "busy", 120_000);
    summary.cancelled = snapshot(a);
    const queued = measure(a, 40);
    const independent = measure(b, 41);
    a.sink.removeSession!("delete-active");
    await cancelled;
    check(a.cache.current()?.messageID === old.messageID, "cancelled-job-promoted");
    const [restarted, unaffected] = await Promise.all([queued, independent]);
    check(restarted.owner === wa.owner && restarted.generation !== wa.generation && restarted.pid !== wa.pid,
      "cancelled-generation-reused");
    check(unaffected.owner === wb.owner && unaffected.generation === wb.generation && unaffected.pid === wb.pid,
      "foreign-instance-interrupted");
    check(!summary.records.some(r => r.message === "cancelled"), "cancelled-result-recorded");
    summary.checks.push("owned-cancellation", "deletion-preserves-queued-session", "restart-without-replay");
    if (args.idleMs !== undefined) {
      summary.step = "explicit-idle-override";
      await until(() => snapshot(a).state === "stopped" && snapshot(b).state === "stopped", args.idleMs + 5000);
      summary.checks.push("idle-expiry-test-override");
      await Promise.all([measure(a, 50), measure(b, 51)]); // Off/dispose must still exercise live idle workers.
    }
    summary.step = "off-and-dispose";
    a.sink.stop(); await until(() => snapshot(a).state === "stopped");
    await b.sink.dispose!(); check(snapshot(b).state === "disposed", "idle-dispose-left-worker");
    summary.checks.push("off-owned-close", "idle-dispose-owned-close"); summary.passed = true;
  } catch (error) {
    summary.failureElapsedMs = performance.now() - began;
    if (error instanceof AcceptanceFailure) {
      summary.acceptance = error.identifier;
      summary.failure = acceptanceCategory(error.identifier);
      if (error.identifier === "sink-error" && firstSinkFailure) {
        summary.failure = firstSinkFailure.category === "wav-invalid" ? "wav-validation" : firstSinkFailure.category;
      }
    } else { summary.failure = "unexpected-error"; }
  }
  finally {
    // Capture before disposal clears PID/generation/state. An onError snapshot may predate child close.
    summary.beforeCleanup = ownedEngines.map((engine, index) => ({ instance: index === 0 ? "a" : "b",
      worker: evidence(engine), sinkFailure: instances.find(i => i.engine === engine)?.sinkFailure }));
    const results = await Promise.allSettled(instances.map(i => Promise.resolve().then(() => i.sink.dispose!())));
    // Also cover failures between engine construction, cache construction and sink registration.
    const engineResults = await Promise.allSettled(ownedEngines.map(e => Promise.resolve().then(() => e.dispose?.())));
    const cacheResults = await Promise.allSettled(ownedCaches.map(cache => Promise.resolve().then(() => cache.dispose())));
    summary.cleanup = [...results, ...engineResults, ...cacheResults].every(r => r.status === "fulfilled")
      && ownedEngines.every(e => evidence(e)?.state === "disposed");
    if (!summary.cleanup) { summary.passed = false; summary.cleanupFailure = true; summary.failure ??= "cleanup"; }
    writeFileSync(join(args.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  }
  return summary;
}

if (import.meta.main) {
  try {
    const args = parseArguments(process.argv.slice(2)); args.out = reserveOutput(args.out);
    const result = await runBenchmark(args); process.exitCode = result.passed ? 0 : 1;
    console.log(JSON.stringify({ passed: result.passed, step: result.step, cleanup: result.cleanup }));
  } catch { console.error("Persistent harness failed; no inference replay or configuration changes requested."); process.exitCode = 1; }
}
