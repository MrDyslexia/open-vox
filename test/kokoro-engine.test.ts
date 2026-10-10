import { describe, expect, test } from "bun:test";
import { kokoroEngine, resolveKokoro } from "../src/kokoro-engine";
import type { Runner } from "../src/piper-engine";

function harness() {
  const calls: { cmd: string; args: string[]; stdin?: string }[] = [];
  const run: Runner = (cmd, args, stdin) => {
    calls.push({ cmd, args, stdin });
    return { exited: Promise.resolve(0), kill() {} };
  };
  const engine = kokoroEngine({
    python: "C:\\py\\python.exe",
    script: "C:\\s\\kokoro_say.py",
    modelPath: "C:\\k\\model.onnx",
    voicesPath: "C:\\k\\voices.bin",
    voices: { es: "ef_dora", en: "af_heart" },
    speed: 1,
    run, tmpDir: "C:\\tmp", unlink: () => {},
  });
  return { calls, engine };
}

describe("kokoro engine", () => {
  test("synthesizes Spanish with the Spanish voice and es language", async () => {
    const h = harness();
    await h.engine("Hola", "es").exited;
    const call = h.calls[0]!;
    expect(call.cmd).toBe("C:\\py\\python.exe");
    expect(call.args[0]).toBe("C:\\s\\kokoro_say.py");
    expect(call.args).toContain("ef_dora");
    expect(call.args).toContain("es");
    expect(call.args).toContain("C:\\k\\model.onnx");
    expect(call.args).toContain("C:\\k\\voices.bin");
    expect(call.stdin).toBe("Hola");
  });

  test("synthesizes English with the English voice and en-us language", async () => {
    const h = harness();
    await h.engine("Hello", "en").exited;
    expect(h.calls[0]!.args).toContain("af_heart");
    expect(h.calls[0]!.args).toContain("en-us");
  });

  test("plays the generated wav afterwards", async () => {
    const h = harness();
    await h.engine("Hola", "es").exited;
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.cmd).toBe("powershell.exe");
    const wav = h.calls[0]!.args[h.calls[0]!.args.indexOf("--out") + 1]!;
    expect(h.calls[1]!.args.join(" ")).toContain(wav);
  });

  test("passes the speed", async () => {
    const calls: string[][] = [];
    const engine = kokoroEngine({
      python: "p", script: "s", modelPath: "m", voicesPath: "v", voices: { es: "a", en: "b" }, speed: 1.2,
      run: (_c, args) => { calls.push(args); return { exited: Promise.resolve(0), kill() {} }; },
      tmpDir: "C:\\tmp", unlink: () => {},
    });
    await engine("x", "en").exited;
    expect(calls[0]!.join(" ")).toContain("--speed 1.2");
  });
});

describe("resolveKokoro", () => {
  const present = new Set([
    "R\\kokoro-venv\\Scripts\\python.exe", "R\\kokoro\\kokoro-v1.0.onnx", "R\\kokoro\\voices-v1.0.bin",
  ]);
  test("returns paths and default voices when installed", () => {
    const r = resolveKokoro("R", {}, (p) => present.has(p));
    expect(r?.python).toBe("R\\kokoro-venv\\Scripts\\python.exe");
    expect(r?.voices).toEqual({ es: "ef_dora", en: "af_heart" });
    expect(r?.speed).toBe(1);
  });
  test("undefined when the model is missing", () => {
    expect(resolveKokoro("R", {}, (p) => p !== "R\\kokoro\\kokoro-v1.0.onnx" && present.has(p))).toBeUndefined();
  });
  test("honors voice and speed overrides, ignoring a bad speed", () => {
    const r = resolveKokoro("R", { AGENTVOZ_KOKORO_VOICE_ES: "em_alex", AGENTVOZ_KOKORO_VOICE_EN: "am_adam", AGENTVOZ_SPEED: "1.25" }, () => true);
    expect(r?.voices).toEqual({ es: "em_alex", en: "am_adam" });
    expect(r?.speed).toBe(1.25);
    expect(resolveKokoro("R", { AGENTVOZ_SPEED: "abc" }, () => true)?.speed).toBe(1);
    expect(resolveKokoro("R", { AGENTVOZ_SPEED: "9" }, () => true)?.speed).toBe(1);
  });
});
