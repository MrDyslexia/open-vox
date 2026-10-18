import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { SpeechProcess } from "./speech-sink";
import type { ModelDevices } from "./repeat-control";

export const REQUEST_BYTES = 1024 * 1024;
export const RESPONSE_BYTES = 8192;
export const COUNTER_KEYS = ["detectorBuilds", "kokoroCreates", "kokoroLoads", "kokoroRuns", "lidLoads", "lidRuns", "tokenizerLoads"] as const;
export type WorkerCounters = { readonly [K in typeof COUNTER_KEYS[number]]: number | null };
export const STARTUP_STAGES = ["imports", "runtime-probe", "detector-build", "kokoro-load"] as const;
export const REQUEST_STAGES = ["request-read", "lid-resolve", "synthesis", "result"] as const;
export type WorkerMilestone = "spawned" | "ready" | typeof STARTUP_STAGES[number] | typeof REQUEST_STAGES[number];
export const WORKER_FAILURES = ["startup-timeout", "request-timeout", "protocol-rejection", "worker-exit",
  "transport-error", "admission-error", "worker-result", "shutdown-timeout"] as const;
export type WorkerFailure = typeof WORKER_FAILURES[number];
export type WorkerSnapshot = Readonly<{ owner: string; generation?: string; pid?: number;
  state: "stopped" | "starting" | "busy" | "idle" | "retiring" | "disposed";
  request?: string; counters: WorkerCounters; milestone?: WorkerMilestone; failure?: WorkerFailure }>;
const unavailableCounters = (): WorkerCounters => Object.fromEntries(COUNTER_KEYS.map(k => [k, null])) as WorkerCounters;
export type WorkerChild = EventEmitter & { stdin: Writable; stdout: Readable; pid?: number; kill(signal?: NodeJS.Signals): boolean };
export type WorkerLaunch = { command: string; args: string[]; identity: string };
export type WorkerPayload = { mode: string; input: unknown; output: string; voice: string; lang: string;
  speed: number; toneVoice: string; toneWeight: number };
export type WorkerOptions = {
  spawn?: (command: string, args: string[]) => WorkerChild;
  startupMs?: number;
  requestMs?: number;
  idleMs?: number;
  shutdownMs?: number;
  onDiagnostic?: (code: string) => void;
};

/** Private pipes only. The GPU bootstrap is supplied by the trusted engine, never a request. */
export function spawnNarrationWorker(command: string, args: string[]): WorkerChild {
  return spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: {
    ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1",
    HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1",
    HF_HUB_DISABLE_PROGRESS_BARS: "1", DO_NOT_TRACK: "1", HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
    HF_TOKEN: "", HUGGING_FACE_HUB_TOKEN: "", PYTHONNOUSERSITE: "1",
  } }) as WorkerChild;
}

type Pending = { id: string; frame: string; sent: boolean; stats?: boolean; progress?: number; finish(code: number): void;
  slot?: Slot; diagnostics?: string[]; reply: boolean; timer?: ReturnType<typeof setTimeout> };
type Slot = { child: WorkerChild; launch: WorkerLaunch; generation: string; ready: boolean; retiring: boolean;
  counters: WorkerCounters; request?: string; milestone: WorkerMilestone; progress: number; failure?: WorkerFailure;
  closed: Promise<void>; close(): void; startup?: ReturnType<typeof setTimeout>; shutdown?: ReturnType<typeof setTimeout> };

function diagnosticsDevices(codes: string[]): ModelDevices {
  const devices: ModelDevices = {};
  for (const model of ["lid", "kokoro"] as const) {
    const values = codes.filter(c => (model === "lid" ? /^lid-(onnx-provider|torch-device)-(cpu|cuda)$/
      : /^kokoro-onnx-provider-(cpu|cuda)$/).test(c));
    if (values.length === 1) devices[model] = values[0]!.endsWith("-cuda") ? "gpu" : "cpu";
  }
  return devices;
}

/** One active request; admission belongs to the sink's bounded queue, not this transport. */
export class NarrationWorker {
  private readonly owner = randomUUID();
  private slot?: Slot;
  private pending?: Pending;
  private disposed = false;
  private idle?: ReturnType<typeof setTimeout>;
  private last?: WorkerSnapshot;
  constructor(private readonly options: WorkerOptions = {}) {}

  /** Detached values only: no process handle, mutable controller, text or launch paths. */
  snapshot(): WorkerSnapshot {
    const s = this.slot;
    if (!s && this.last) return { ...this.last, state: this.disposed ? "disposed" : "stopped", counters: { ...this.last.counters } };
    return { owner: this.owner, generation: s?.generation, pid: s?.child.pid,
      state: s?.retiring ? "retiring" : this.disposed ? "disposed" : !s ? "stopped"
        : !s.ready ? "starting" : this.pending ? "busy" : "idle",
      request: this.pending?.id ?? s?.request, counters: { ...(s?.counters ?? unavailableCounters()) },
      milestone: s?.milestone, failure: s?.failure };
  }

  request(launch: WorkerLaunch, payload: WorkerPayload): SpeechProcess {
    if (this.disposed || this.pending) return { exited: Promise.resolve(2), kill() {} };
    let devices: ModelDevices | undefined;
    let killed = false;
    let resolve!: (code: number) => void;
    const exited = new Promise<number>(done => { resolve = done; });
    const id = randomUUID();
    const p: Pending = { id, frame: "", sent: false, reply: false, finish: code => {
      if (this.pending !== p) return;
      clearTimeout(p.timer); this.pending = undefined;
      if (code === 0 && !killed && p.diagnostics) {
        devices = diagnosticsDevices(p.diagnostics);
        for (const c of p.diagnostics) { try { this.options.onDiagnostic?.(c); } catch {} }
      }
      resolve(code); this.armIdle();
    } };
    this.pending = p;
    clearTimeout(this.idle);
    // Serialization is bounded before anything is written. Invalid caller data never starts a child.
    let body: string;
    try {
      body = JSON.stringify(payload);
      if (Buffer.byteLength(body, "utf8") + 256 > REQUEST_BYTES) throw Error("oversized-request");
    } catch { p.finish(2); return { exited, kill() {} }; }
    void this.admit(launch, p, body).catch(() => {
      if (this.slot) this.retire(this.slot, "admission-error"); else p.finish(2);
    });
    return { exited, devices: () => !killed && devices ? { ...devices } : undefined,
      kill: () => {
        killed = true; devices = undefined;
        if (this.pending !== p) return; // A completed handle never cancels a later request.
        if (p.slot) this.retire(p.slot); else p.finish(1);
      } };
  }

  private async admit(launch: WorkerLaunch, p: Pending, body: string): Promise<void> {
    const old = this.slot;
    if (old && (old.retiring || old.launch.identity !== launch.identity)) {
      this.retire(old); await old.closed;
    }
    if (this.disposed || this.pending !== p) { p.finish(1); return; }
    const slot = this.slot ?? this.start(launch);
    if (slot.ready) { slot.failure = undefined; slot.milestone = "ready"; }
    p.slot = slot;
    p.frame = JSON.stringify({ v: 1, owner: this.owner, generation: slot.generation, request: p.id,
      ...JSON.parse(body) }) + "\n";
    if (Buffer.byteLength(p.frame) > REQUEST_BYTES) { this.retire(slot); return; }
    if (slot.ready) this.send(slot);
  }

  private start(launch: WorkerLaunch): Slot {
    const generation = randomUUID();
    const child = (this.options.spawn ?? spawnNarrationWorker)(launch.command,
      [...launch.args, "--owner", this.owner, "--generation", generation]);
    let close!: () => void;
    const closed = new Promise<void>(done => { close = done; });
    const slot: Slot = { child, launch, generation, ready: false, retiring: false, closed, close,
      counters: unavailableCounters(), milestone: "spawned", progress: -1 };
    this.last = undefined;
    this.slot = slot;
    let bytes = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      if (slot.retiring) return;
      // Bound each frame before decoding or JSON parsing, including a line with no newline.
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset);
        const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
        if (bytes.length + part.length > RESPONSE_BYTES) { this.retire(slot, "protocol-rejection"); return; }
        bytes = Buffer.concat([bytes, part]);
        if (end < 0) break;
        try { this.receive(slot, new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { this.retire(slot, "protocol-rejection"); return; }
        bytes = Buffer.alloc(0); offset = end + 1;
        if (slot.retiring) return;
      }
    });
    child.stdout.on("error", () => this.retire(slot, "transport-error"));
    child.stdout.on("end", () => this.retire(slot, "worker-exit"));
    child.stdin.on("error", () => this.retire(slot, "transport-error"));
    child.once("error", () => this.retire(slot, "worker-exit"));
    child.once("close", () => {
      clearTimeout(slot.startup); clearTimeout(slot.shutdown); clearTimeout(this.idle);
      if (this.slot === slot) {
        if (!slot.retiring) slot.failure ??= "worker-exit";
        this.last = this.snapshot(); // Metadata only; retain failure evidence across actual child close.
        this.slot = undefined;
        // Never release an output hold merely on kill/error: the writer must actually close.
        if (this.pending?.slot === slot) this.pending.finish(1);
      }
      slot.close();
    });
    slot.startup = setTimeout(() => this.retire(slot, "startup-timeout"), this.options.startupMs ?? 120_000);
    return slot;
  }

  private send(slot: Slot): void {
    const p = this.pending;
    if (!p || p.sent || !p.frame || slot.retiring) return;
    p.sent = true;
    p.timer = setTimeout(() => this.retire(slot, "request-timeout"), this.options.requestMs ?? 120_000);
    slot.child.stdin.write(p.frame, "utf8", error => { if (error) this.retire(slot, "transport-error"); });
    p.frame = ""; // No transport-side cross-request text retention.
  }

  private receive(slot: Slot, text: string): void {
    const v = JSON.parse(text);
    if (!v || Array.isArray(v) || v.v !== 1 || v.owner !== this.owner || v.generation !== slot.generation) throw Error();
    const expected = v.type === "ready" ? ["generation", "owner", "type", "v"]
      : v.type === "progress" ? ["generation", "owner", "request", "stage", "type", "v"]
      : v.type === "stats" ? [...COUNTER_KEYS, "generation", "owner", "request", "type", "v"].sort()
      : ["code", "diagnostics", "generation", "owner", "request", "type", "v"];
    // All accepted values are flat, allowlisted strings/numbers/arrays of codes. Comparing lexical keys
    // also rejects duplicate/escaped keys, which JSON.parse alone would silently overwrite.
    const keys = [...text.matchAll(/"([^"\\]*)"\s*:/g)].map(m => m[1]!).sort();
    if (Object.keys(v).sort().join() !== expected.join() || keys.join() !== expected.join()) throw Error();
    if (v.type === "ready") {
      if (slot.ready) throw Error();
      slot.ready = true; slot.milestone = "ready"; clearTimeout(slot.startup); this.send(slot); return;
    }
    const p = this.pending;
    if (v.type === "progress") {
      if (typeof v.stage !== "string") throw Error();
      const stages: readonly string[] = slot.ready ? REQUEST_STAGES : STARTUP_STAGES;
      const index = stages.indexOf(v.stage);
      if (index < 0) throw Error();
      if (!slot.ready) {
        if (v.request !== null || index <= slot.progress) throw Error();
        slot.progress = index;
      } else {
        if (!p?.sent || p.reply || p.stats || v.request !== p.id || index <= (p.progress ?? -1)) throw Error();
        p.progress = index;
      }
      // At most four startup + four per-request events, strictly increasing; no timer reset or settlement.
      slot.milestone = v.stage as WorkerMilestone; return;
    }
    if (v.type === "stats") {
      if (!slot.ready || !p?.sent || p.reply || p.stats || v.request !== p.id) throw Error();
      for (const key of COUNTER_KEYS) {
        const n = v[key], before = slot.counters[key];
        if (n !== null && (!Number.isSafeInteger(n) || n < 0 || n > 1_000_000_000)) throw Error();
        if (before !== null && (n === null || n < before)) throw Error();
      }
      slot.counters = Object.fromEntries(COUNTER_KEYS.map(k => [k, v[k]])) as WorkerCounters;
      slot.request = p.id; p.stats = true; return;
    }
    if (v.type !== "result" || !slot.ready || !p?.sent || p.reply || v.request !== p.id
      || ![0, 2].includes(v.code) || typeof v.code !== "number" || !Array.isArray(v.diagnostics)
      || v.diagnostics.length > 32 || new Set(v.diagnostics).size !== v.diagnostics.length
      || !v.diagnostics.every((c: unknown) => typeof c === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(c))
      || (v.code !== 0 && v.diagnostics.length)) throw Error();
    p.reply = true; p.diagnostics = v.diagnostics;
    if (v.code !== 0) slot.failure ??= "worker-result";
    // Reject a duplicate/malformed frame in the same event turn before allowing cache promotion.
    queueMicrotask(() => { if (!slot.retiring) p.finish(v.code); });
  }

  private retire(slot: Slot, failure?: WorkerFailure): void {
    if (slot.retiring) return;
    slot.failure ??= failure;
    slot.retiring = true; clearTimeout(slot.startup); clearTimeout(this.idle);
    try { slot.child.kill(); } catch {}
    slot.shutdown = setTimeout(() => { try { slot.child.kill("SIGKILL"); } catch {} }, this.options.shutdownMs ?? 3_000);
    slot.shutdown.unref?.();
  }

  private armIdle(): void {
    clearTimeout(this.idle);
    const slot = this.slot;
    if (!slot || slot.retiring || this.disposed) return;
    this.idle = setTimeout(() => this.retire(slot), this.options.idleMs ?? 5 * 60_000);
    this.idle.unref?.();
  }

  /** Retire this instance's child, including an idle child; future admission can start a new one. */
  release(): void { if (this.slot) this.retire(this.slot); }

  async dispose(): Promise<void> {
    this.disposed = true;
    const slot = this.slot;
    if (!slot) { this.pending?.finish(1); return; }
    this.retire(slot);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([slot.closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { slot.failure ??= "shutdown-timeout";
          reject(Error("Narration worker did not close")); }, this.options.shutdownMs ?? 3_000);
      })]);
    } finally { clearTimeout(timer); }
  }
}
