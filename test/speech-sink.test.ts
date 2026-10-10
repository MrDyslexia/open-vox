import { describe, expect, test } from "bun:test";
import { createSpeechSink, type SpeechProcess, type Spawn } from "../src/speech-sink";

type Fake = SpeechProcess & { stdin: string; killed: boolean; finish(code?: number): void; fail(error: Error): void };

function harness() {
  const procs: Fake[] = [];
  const spawn: Spawn = (_args, stdin) => {
    let done!: (code: number) => void;
    let failed!: (error: Error) => void;
    const exited = new Promise<number>((resolve, reject) => { done = resolve; failed = reject; });
    const proc: Fake = {
      stdin, killed: false, exited,
      kill() { proc.killed = true; done(1); },
      finish(code = 0) { done(code); },
      fail(error) { failed(error); },
    };
    procs.push(proc);
    return proc;
  };
  return { procs, spawn };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const item = (id: string, text: string) => ({ sessionID: "s", messageID: id, text });

describe("speech sink", () => {
  test("speaks prepared text with the detected language", async () => {
    const h = harness();
    const sink = createSpeechSink({ spawn: h.spawn });
    const pending = sink(item("m1", "**Hola**, esta es la respuesta que necesitas para el proyecto."));
    await tick();
    expect(h.procs).toHaveLength(1);
    expect(h.procs[0]!.stdin).toContain("esta es la respuesta");
    expect(h.procs[0]!.stdin).not.toContain("**");
    h.procs[0]!.finish();
    await pending;
  });

  test("passes the language to the process arguments", async () => {
    const calls: string[][] = [];
    const sink = createSpeechSink({ spawn: (args) => { calls.push(args); return { exited: Promise.resolve(0), kill() {} }; } });
    await sink(item("m1", "Here is the answer that you need for the project."));
    await sink(item("m2", "Aquí está la respuesta que necesitas para el proyecto."));
    expect(calls[0]!.join(" ")).toContain("en");
    expect(calls[1]!.join(" ")).toContain("es");
  });

  test("skips messages that are empty after preparation", async () => {
    const h = harness();
    const sink = createSpeechSink({ spawn: h.spawn });
    await sink(item("m1", "```\ncode only\n```"));
    expect(h.procs).toHaveLength(0);
  });

  test("speaks queued messages serially", async () => {
    const h = harness();
    const sink = createSpeechSink({ spawn: h.spawn });
    const a = sink(item("m1", "First message here for the user."));
    const b = sink(item("m2", "Second message here for the user."));
    await tick();
    expect(h.procs).toHaveLength(1);
    h.procs[0]!.finish();
    await a;
    await tick();
    expect(h.procs).toHaveLength(2);
    h.procs[1]!.finish();
    await b;
  });

  test("drops the oldest pending item beyond the queue limit", async () => {
    const h = harness();
    const sink = createSpeechSink({ spawn: h.spawn, maxPending: 1 });
    const a = sink(item("m1", "Playing now for the user."));
    const b = sink(item("m2", "Pending that gets dropped by the next."));
    const c = sink(item("m3", "Latest pending message for the user."));
    await tick();
    h.procs[0]!.finish();
    await Promise.all([a, b]);
    await tick();
    expect(h.procs).toHaveLength(2);
    expect(h.procs[1]!.stdin).toContain("Latest pending");
    h.procs[1]!.finish();
    await c;
  });

  test("stop kills the current process and clears the queue", async () => {
    const h = harness();
    const sink = createSpeechSink({ spawn: h.spawn });
    const a = sink(item("m1", "Currently playing message here."));
    const b = sink(item("m2", "Queued message never played here."));
    await tick();
    sink.stop();
    await Promise.all([a, b]);
    await tick();
    expect(h.procs[0]!.killed).toBe(true);
    expect(h.procs).toHaveLength(1);
  });

  test("contains spawn failures", async () => {
    const errors: unknown[] = [];
    const sink = createSpeechSink({ spawn: () => { throw new Error("no powershell"); }, onError: (e) => errors.push(e) });
    await sink(item("m1", "This message will fail to spawn."));
    expect(errors).toHaveLength(1);
  });

  test("contains process errors and nonzero exits, then continues", async () => {
    const h = harness();
    const errors: unknown[] = [];
    const sink = createSpeechSink({ spawn: h.spawn, onError: (e) => errors.push(e) });
    const a = sink(item("m1", "Fails with a process error here."));
    const b = sink(item("m2", "Exits with a nonzero status here."));
    const c = sink(item("m3", "Succeeds after the failures here."));
    await tick();
    h.procs[0]!.fail(new Error("boom"));
    await a;
    await tick();
    h.procs[1]!.finish(3);
    await b;
    await tick();
    h.procs[2]!.finish(0);
    await c;
    expect(errors).toHaveLength(2);
  });

  test("a hung process is killed after the timeout", async () => {
    const h = harness();
    const sink = createSpeechSink({ spawn: h.spawn, timeoutMs: 20 });
    const a = sink(item("m1", "This will hang forever for the user."));
    await a;
    expect(h.procs[0]!.killed).toBe(true);
  });

  test("disabled sink never spawns", async () => {
    const h = harness();
    const sink = createSpeechSink({ spawn: h.spawn, enabled: false });
    await sink(item("m1", "Muted message that should not play."));
    expect(h.procs).toHaveLength(0);
  });
});
