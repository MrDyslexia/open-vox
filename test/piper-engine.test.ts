import { describe, expect, test } from "bun:test";
import { piperEngine, resolvePiper, wavEngine, type Runner } from "../src/piper-engine";
import type { SpeechProcess } from "../src/speech-sink";

type Call = { cmd: string; args: string[]; stdin?: string; proc: SpeechProcess & { killed: boolean; finish(code?: number): void } };

function harness() {
  const calls: Call[] = [];
  const unlinked: string[] = [];
  const run: Runner = (cmd, args, stdin) => {
    let done!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { done = resolve; });
    const proc = { killed: false, exited, kill() { proc.killed = true; done(1); }, finish(code = 0) { done(code); } };
    calls.push({ cmd, args, stdin, proc });
    return proc;
  };
  const engine = piperEngine({
    exe: "C:\\p\\piper.exe",
    models: { es: "C:\\v\\es.onnx", en: "C:\\v\\en.onnx" },
    run,
    tmpDir: "C:\\tmp",
    unlink: (file) => { unlinked.push(file); },
  });
  return { calls, unlinked, engine };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("piper engine", () => {
  test("WAV wrapper retains synthesis devices rather than player devices and hides killed results", async () => {
    let finish!: (code: number) => void;
    const engine = wavEngine({ tmpDir: "R", unlink() {}, commandFor: () => ({ cmd: "synth", args: [] }),
      run: (cmd) => cmd === "synth"
        ? { exited: Promise.resolve(0), kill() {}, devices: () => ({ kokoro: "gpu" }) }
        : { exited: new Promise<number>(resolve => { finish = resolve; }), kill() {}, devices: () => ({ lid: "cpu" }) } });
    const success = engine("Fake narration", "es"); await tick(); finish(0); await success.exited;
    expect(success.devices!()).toEqual({ kokoro: "gpu" });
    const killed = engine("Fake narration", "es"); await tick(); killed.kill(); finish(0); await killed.exited;
    expect(killed.devices!()).toBeUndefined();
    const legacy = harness();
    const proc = legacy.engine("Piper", "es"); legacy.calls[0]!.proc.finish(); await tick(); legacy.calls[1]!.proc.finish();
    await proc.exited; expect(proc.devices!()).toBeUndefined();
  });
  test("artifact synthesis uses the caller-owned WAV without playback or unlink", async () => {
    const h = harness();
    const proc = h.engine.synthesize!("Exact text", "en", "C:\\owned\\candidate.wav");
    h.calls[0]!.proc.finish();
    expect(await proc.exited).toBe(0);
    expect(h.calls[0]!.args).toContain("C:\\owned\\candidate.wav");
    expect(h.calls).toHaveLength(1);
    expect(h.unlinked).toEqual([]);
  });
  test("synthesizes with the model for the language, then plays the wav", async () => {
    const h = harness();
    const proc = h.engine("Hola mundo", "es");
    await tick();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.cmd).toBe("C:\\p\\piper.exe");
    expect(h.calls[0]!.args).toContain("C:\\v\\es.onnx");
    expect(h.calls[0]!.stdin).toBe("Hola mundo");
    const wav = h.calls[0]!.args[h.calls[0]!.args.indexOf("-f") + 1]!;
    expect(wav.startsWith("C:\\tmp")).toBe(true);
    h.calls[0]!.proc.finish(0);
    await tick();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.cmd).toBe("powershell.exe");
    expect(h.calls[1]!.args.join(" ")).toContain(wav);
    h.calls[1]!.proc.finish(0);
    expect(await proc.exited).toBe(0);
    expect(h.unlinked).toEqual([wav]);
  });

  test("uses the English model for English", async () => {
    const h = harness();
    h.engine("Hello", "en");
    await tick();
    expect(h.calls[0]!.args).toContain("C:\\v\\en.onnx");
  });

  test("a failed synthesis never plays and still cleans up", async () => {
    const h = harness();
    const proc = h.engine("Hola", "es");
    await tick();
    h.calls[0]!.proc.finish(2);
    expect(await proc.exited).toBe(2);
    expect(h.calls).toHaveLength(1);
    expect(h.unlinked).toHaveLength(1);
  });

  test("kill during synthesis stops piper and never plays", async () => {
    const h = harness();
    const proc = h.engine("Hola", "es");
    await tick();
    proc.kill();
    await proc.exited;
    expect(h.calls[0]!.proc.killed).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.unlinked).toHaveLength(1);
  });

  test("kill during playback stops the player", async () => {
    const h = harness();
    const proc = h.engine("Hola", "es");
    await tick();
    h.calls[0]!.proc.finish(0);
    await tick();
    proc.kill();
    await proc.exited;
    expect(h.calls[1]!.proc.killed).toBe(true);
    expect(h.unlinked).toHaveLength(1);
  });

  test("escapes single quotes in the playback path", async () => {
    const calls: string[][] = [];
    const engine = piperEngine({
      exe: "p", models: { es: "m", en: "m" }, tmpDir: "C:\\o'brien", unlink: () => {},
      run: (_cmd, args) => { calls.push(args); return { exited: Promise.resolve(0), kill() {} }; },
    });
    await engine("x", "en").exited;
    expect(calls[1]!.join(" ")).toContain("o''brien");
  });
});

describe("resolvePiper", () => {
  const present = new Set(["R\\piper\\piper.exe", "R\\voices\\es_MX-claude-high.onnx", "R\\voices\\en_US-lessac-high.onnx"]);
  test("returns paths when everything is installed", () => {
    const r = resolvePiper("R", {}, (p) => present.has(p));
    expect(r?.exe).toBe("R\\piper\\piper.exe");
    expect(r?.models.es).toBe("R\\voices\\es_MX-claude-high.onnx");
  });
  test("returns undefined when a model is missing", () => {
    expect(resolvePiper("R", {}, (p) => p !== "R\\voices\\en_US-lessac-high.onnx" && present.has(p))).toBeUndefined();
  });
  test("honors voice overrides", () => {
    const r = resolvePiper("R", { OPEN_VOX_VOICE_ES: "es_ES-davefx-medium" }, () => true);
    expect(r?.models.es).toBe("R\\voices\\es_ES-davefx-medium.onnx");
  });
});
