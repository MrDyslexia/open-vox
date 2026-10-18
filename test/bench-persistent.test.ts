import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArguments, reserveOutput, runBenchmark, waveMetrics } from "../tools/bench_persistent";
import type { WorkerSnapshot } from "../src/narration-worker";
import type { Engine, SpeechProcess } from "../src/speech-sink";

const scratch = join(tmpdir(), "opencode");
function pcm() {
  const b = Buffer.alloc(48); b.write("RIFF"); b.writeUInt32LE(40, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36);
  b.writeUInt32LE(4, 40); b.writeInt16LE(123, 44); return b;
}
function factories(fault = false) {
  const engines: Engine[] = [], profiles: string[] = [], outputs: string[] = [];
  let creates = 0, closes = 0;
  const engine = (profile: string) => {
    profiles.push(profile); const owner = randomUUID(); let generation: string | undefined, pid: number | undefined;
    let state: WorkerSnapshot["state"] = "stopped", request: string | undefined, calls = 0;
    let active: SpeechProcess | undefined;
    const snapshot = (): WorkerSnapshot => ({ owner, generation, pid, state, request, counters: {
      detectorBuilds: generation ? 1 : null, kokoroLoads: generation ? 1 : null, lidLoads: generation ? 1 : null,
      tokenizerLoads: generation ? 1 : null, kokoroCreates: calls, kokoroRuns: calls, lidRuns: calls } });
    const e: Engine = Object.assign(() => { throw Error("playback forbidden"); }, {
      workerSnapshot: snapshot,
      synthesizePlan: (_plan: unknown, wav: string) => {
        if (!generation) { generation = randomUUID(); pid = ++creates; calls = 0; }
        state = "busy"; request = randomUUID(); let done!: (code: number) => void;
        const exited = new Promise<number>(resolve => { done = resolve; });
        let killed = false;
        const timer = setTimeout(() => {
          if (killed) return;
          calls++; state = "idle"; active = undefined; outputs.push(wav);
          writeFileSync(wav, fault ? Buffer.from("broken") : pcm()); done(0);
        }, 20);
        const p: SpeechProcess = { exited, devices: () => ({ lid: profile === "cpu" ? "cpu" : "gpu",
          kokoro: profile === "cpu" ? "cpu" : "gpu" }), kill() {
          if (killed || active !== p) return;
          killed = true; clearTimeout(timer); closes++; state = "stopped";
          generation = undefined; pid = undefined; active = undefined; done(1);
        } }; active = p; return p;
      },
      release() { if (active) active.kill(); else if (generation) { closes++; state = "stopped"; generation = undefined; pid = undefined; } },
      async dispose() { e.release!(); state = "disposed"; },
    }); engines.push(e); return e;
  };
  return { engine, engines, profiles, outputs, counts: () => ({ creates, closes }) };
}

test.each(["cpu", "cuda13"])("production-shaped harness with real cache: %s injection, Repeat, isolation, deletion and cleanup", async profile => {
  const out = mkdtempSync(join(scratch, "persistent-test-")), h = factories();
  try {
    const args = parseArguments(["--profile", profile, "--requests", "3", "--no-playback", "--out", out]);
    const summary = await runBenchmark(args, { engine: h.engine });
    expect(summary.passed).toBe(true); expect(summary.cleanup).toBe(true);
    expect(summary.records).toHaveLength(7); expect(h.profiles).toEqual([profile, profile]);
    expect(h.counts()).toEqual({ creates: 3, closes: 3 });
    expect(summary.checks).toContain("repeat-without-inference");
    expect(summary.checks).toContain("deletion-preserves-queued-session");
    expect(h.outputs.every(p => p.startsWith(out) && /^[a-f0-9-]{36}\.wav$/.test(p.split(/[\\/]/).at(-1)!))).toBe(true);
    const saved = readFileSync(join(out, "summary.json"), "utf8");
    expect(saved).not.toContain("El café"); expect(saved).not.toContain("modelPath");
    expect(saved).not.toContain("input"); expect(saved).not.toContain("plan");
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("invalid audio fails acceptance, writes a partial safe summary and disposes owned workers", async () => {
  const out = mkdtempSync(join(scratch, "persistent-fault-")), h = factories(true);
  try {
    const summary = await runBenchmark({ profile: "cpu", requests: 3, out }, { engine: h.engine });
    expect(summary.passed).toBe(false); expect(summary.cleanup).toBe(true);
    expect(h.counts()).toEqual({ creates: 1, closes: 1 });
    const saved = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    expect(saved.failure).toBe("wav-validation");
    expect(saved.beforeCleanup[0].sinkFailure.category).toBe("wav-invalid");
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("unavailable native load telemetry is failure, never request-count proof", async () => {
  const out = mkdtempSync(join(scratch, "persistent-unavailable-")), h = factories();
  try {
    const summary = await runBenchmark({ profile: "cpu", requests: 3, out }, { engine: profile => {
      const e = h.engine(profile), read = e.workerSnapshot!;
      e.workerSnapshot = () => { const s = read(); return { ...s, counters: { ...s.counters, lidLoads: null } }; };
      return e;
    } });
    expect(summary.passed).toBe(false); expect(summary.cleanup).toBe(true);
    expect(summary.records).toHaveLength(0); expect(h.counts()).toEqual({ creates: 1, closes: 1 });
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("failed acceptance preserves its identifier and live snapshot before cleanup erases the worker", async () => {
  const out = mkdtempSync(join(scratch, "persistent-diagnostic-")), h = factories();
  try {
    const summary = await runBenchmark({ profile: "cpu", requests: 3, out }, { engine: profile => {
      const e = h.engine(profile), read = e.workerSnapshot!;
      e.workerSnapshot = () => { const s = read(); return { ...s, milestone: "synthesis",
        counters: { ...s.counters, lidLoads: null } }; };
      return e;
    } });
    const saved = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    expect(saved.beforeCleanup).toBeArray();
    expect(saved.failure).toBe("load-counts");
    expect(saved.acceptance).toBe("load-reuse-unproved");
    expect(saved.beforeCleanup[0].worker).toMatchObject({ state: "idle", pid: 1, milestone: "synthesis" });
    expect(saved.beforeCleanup[0].worker.generation).toBeString();
    expect(summary.cleanup).toBe(true);
    expect(h.engines[0]!.workerSnapshot!().state).toBe("disposed");
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test.each(["startup-timeout", "request-timeout", "protocol-rejection", "worker-exit"] as const)("owned %s is preserved independently of cleanup", async failure => {
  const out = mkdtempSync(join(scratch, "persistent-owned-error-")), h = factories();
  try {
    const summary = await runBenchmark({ profile: "cpu", requests: 3, out }, { engine: profile => {
      const e = h.engine(profile), read = e.workerSnapshot!, generation = randomUUID();
      e.workerSnapshot = () => ({ ...read(), generation, pid: 123, milestone: "imports", failure });
      e.synthesizePlan = () => ({ exited: Promise.resolve(2), kill() {} });
      return e;
    } });
    expect(summary.failure).toBe(failure); expect(summary.acceptance).toBe("sink-error");
    expect(summary.cleanup).toBe(true); expect(summary.records).toHaveLength(0);
    expect(summary.beforeCleanup![0]!.sinkFailure).toMatchObject({ category: failure,
      worker: { pid: 123, milestone: "imports", failure } });
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("unknown exception prose and unallowlisted snapshot properties are never serialized", async () => {
  const out = mkdtempSync(join(scratch, "persistent-private-error-")), h = factories();
  try {
    const summary = await runBenchmark({ profile: "cpu", requests: 3, out }, { engine: profile => {
      const e = h.engine(profile), read = e.workerSnapshot!;
      e.workerSnapshot = () => ({ ...read(), milestone: "SECRET_STAGE", failure: "SECRET_FAILURE",
        input: "SECRET_TEXT", environment: "SECRET_ENV", path: "SECRET_PATH" }) as any;
      e.synthesizePlan = () => { throw Error("SECRET_EXCEPTION\nSECRET_TEXT"); };
      return e;
    } });
    expect(summary.failure).toBe("unknown-error"); expect(summary.cleanup).toBe(true);
    expect(readFileSync(join(out, "summary.json"), "utf8")).not.toContain("SECRET");
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("cleanup failure does not overwrite the first acceptance identifier or its snapshot", async () => {
  const out = mkdtempSync(join(scratch, "persistent-cleanup-error-")), h = factories();
  try {
    const summary = await runBenchmark({ profile: "cpu", requests: 3, out }, { engine: profile => {
      const e = h.engine(profile), read = e.workerSnapshot!, dispose = e.dispose!;
      e.workerSnapshot = () => { const s = read(); return { ...s, counters: { ...s.counters, lidLoads: null } }; };
      e.dispose = async () => { await dispose(); throw Error("SECRET_CLEANUP_EXCEPTION"); };
      return e;
    } });
    expect(summary.failure).toBe("load-counts"); expect(summary.acceptance).toBe("load-reuse-unproved");
    expect(summary.cleanup).toBe(false); expect(summary.cleanupFailure).toBe(true);
    expect(summary.beforeCleanup![0]!.worker!.state).toBe("idle");
    expect(readFileSync(join(out, "summary.json"), "utf8")).not.toContain("SECRET");
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test.each(["speech process timed out", "unrecognized native error"])("sink exception taxonomy is fixed, not arbitrary prose: %s", async message => {
  const out = mkdtempSync(join(scratch, "persistent-sink-error-")), h = factories();
  try {
    const summary = await runBenchmark({ profile: "cpu", requests: 3, out }, { engine: profile => {
      const e = h.engine(profile); e.synthesizePlan = () => { throw Error(message); }; return e;
    } });
    expect(summary.failure).toBe(message === "speech process timed out" ? "sink-timeout" : "unknown-error");
    expect(summary.cleanup).toBe(true);
    expect(readFileSync(join(out, "summary.json"), "utf8")).not.toContain(message);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("failure after engine creation but before sink registration still disposes that engine", async () => {
  const out = mkdtempSync(join(scratch, "persistent-construction-")), h = factories();
  try {
    writeFileSync(join(out, "a"), "synthetic obstruction");
    const summary = await runBenchmark({ profile: "cpu", requests: 3, out }, { engine: h.engine });
    expect(summary.passed).toBe(false); expect(summary.cleanup).toBe(true);
    expect(h.engines[0]!.workerSnapshot!().state).toBe("disposed");
    expect(h.counts()).toEqual({ creates: 0, closes: 0 });
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("arguments require explicit profile, bounded count, no playback and reject unknown/duplicate flags", () => {
  const base = ["--profile", "cpu", "--requests", "3", "--no-playback", "--out", "unused"];
  for (const argv of [[], base.filter(v => v !== "--no-playback"), [...base, "--profile", "cuda13"],
    [...base, "--install"], [...base, "--idle-ms", "0"], base.map(v => v === "cpu" ? "auto" : v),
    base.map(v => v === "3" ? "3000" : v)]) expect(() => parseArguments(argv)).toThrow();
});

test("output is fresh, scratch-owned, no traversal or overwrite; PCM is complete and finite", () => {
  const parent = mkdtempSync(join(scratch, "persistent-path-"));
  try {
    const out = reserveOutput(join(parent, "fresh"), parent);
    expect(() => reserveOutput(out, parent)).toThrow();
    expect(() => reserveOutput(join(parent, "..", "escape"), parent)).toThrow();
    expect(() => reserveOutput(join(parent, "nested", "escape"), parent)).toThrow();
    expect(existsSync(join(parent, "nested"))).toBe(false);
    const wav = join(out, "sample.wav"); writeFileSync(wav, pcm()); expect(waveMetrics(wav).frames).toBe(2);
    const malformed = pcm(); malformed.writeUInt32LE(3, 40); writeFileSync(wav, malformed);
    expect(() => waveMetrics(wav)).toThrow();
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("production wiring has no worker/readiness bypass or configuration writer", () => {
  const source = readFileSync(new URL("../tools/bench_persistent.ts", import.meta.url), "utf8");
  expect(source).toContain("defaultKokoroEngine(process.env");
  expect(source).toContain("new AudioCache("); expect(source).toContain("createSpeechSink(");
  expect(source).not.toMatch(/writeConfig|spawnNarrationWorker|preparePlan:|synthesizePlan:/);
});
