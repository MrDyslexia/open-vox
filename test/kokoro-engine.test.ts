import { describe, expect, test } from "bun:test";
import { kokoroEngine, narrationRunner, resolveKokoro, type KokoroSettings } from "../src/kokoro-engine";
import type { Runner } from "../src/piper-engine";
import { createNarrationPlan } from "../src/markdown-narration";
import { LID_MANIFEST_PATH, narrationPaths, PN_READY_RECORD, resolveNarrationPython } from "../src/narration-assets";

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
  test("active tone flags follow out, precede plan flags, and sample the base language per utterance", async () => {
    const calls: string[][] = [];
    let reads = 0;
    let settings: KokoroSettings = { voices: { es: "em_alex", en: "bm_george" }, speed: 1.2,
      toneVoice: { es: "am_onyx", en: "em_santa" }, toneWeight: { es: 0.75, en: 1 } };
    const engine = kokoroEngine({ python: "p", script: "s", modelPath: "m", voicesPath: "v",
      voices: settings.voices, speed: 1, tmpDir: "R", unlink() {},
      settings: () => { reads++; return settings; },
      run: (_c, args) => { calls.push(args); return { exited: Promise.resolve(0), kill() {} }; } });
    for (const language of ["es", "en"] as const) await engine.synthesizePlan!(createNarrationPlan("text", language), "o.wav").exited;
    expect(reads).toBe(2);
    expect(calls[0]).toEqual(["s", "--model", "m", "--voices", "v", "--voice", "em_alex", "--lang", "es",
      "--speed", "1.2", "--out", "o.wav", "--tone-voice", "am_onyx", "--tone-weight", "0.75",
      "--plan-json", "--lid-manifest", LID_MANIFEST_PATH]);
    expect(calls[1]).toEqual(expect.arrayContaining(["--voice", "bm_george", "--lang", "en-gb", "--tone-voice", "em_santa", "--tone-weight", "1"]));
    settings = { ...settings, toneWeight: { es: 0.5, en: 0 } };
    await engine.synthesizePlan!(createNarrationPlan("text", "es"), "o.wav").exited;
    expect(calls[2]!.slice(13, 17)).toEqual(["--tone-voice", "am_onyx", "--tone-weight", "0.5"]);
    await engine.synthesize!("plain", "es", "o.wav").exited;
    expect(calls[3]!.slice(13)).toEqual([]); // The helper only blends planned synthesis.
  });
  test("inactive or invalid tone settings preserve the exact legacy planned arguments", async () => {
    const calls: string[][] = [];
    let settings: KokoroSettings = { voices: { es: "em_alex", en: "af_heart" }, speed: 1 };
    const engine = kokoroEngine({ python: "p", script: "s", modelPath: "m", voicesPath: "v",
      voices: settings.voices, speed: 1, tmpDir: "R", unlink() {}, settings: () => settings,
      run: (_c, args) => { calls.push(args); return { exited: Promise.resolve(0), kill() {} }; } });
    const plan = createNarrationPlan("text", "es");
    await engine.synthesizePlan!(plan, "o.wav").exited;
    for (const [donor, weight] of [["", 0.75], ["am_onyx", 0], ["unknown", 0.75],
      ...[-1, 2, NaN, Infinity, -Infinity].map(w => ["am_onyx", w])] as [string, number][]) {
      settings = { ...settings, toneVoice: { es: donor, en: "" }, toneWeight: { es: weight, en: 0 } };
      await engine.synthesizePlan!(plan, "o.wav").exited;
      expect(calls.at(-1)).toEqual(calls[0]);
    }
  });
  test("plan dispatch uses only the managed app-home interpreter after readiness, otherwise existing Kokoro", async () => {
    const paths = narrationPaths("R");
    let ready = false;
    const calls: { cmd: string; args: string[] }[] = [];
    const engine = kokoroEngine({ python: "legacy-python", script: "s", modelPath: "existing-model", voicesPath: "existing-voices",
      appHome: "R", voices: { es: "em_alex", en: "af_heart" }, speed: 1, tmpDir: "R", unlink() {},
      narrationPython: () => resolveNarrationPython("R", p => ready && [paths.python, paths.marker].includes(p), () => PN_READY_RECORD),
      run: (cmd, args) => { calls.push({ cmd, args }); return { exited: Promise.resolve(0), kill() {} }; } });
    const plan = createNarrationPlan("synthetic text", "es");
    await engine.synthesizePlan!(plan, "out.wav").exited;
    ready = true;
    await engine.synthesizePlan!(plan, "out.wav").exited;
    await engine.synthesize!("legacy", "es", "out.wav").exited;
    expect(calls.map(c => c.cmd)).toEqual(["legacy-python", paths.python, "legacy-python"]);
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["--lid-manifest", LID_MANIFEST_PATH, "--app-home", "R", "existing-model", "existing-voices"]));
  });
  test("plan settings are sampled once and speed remains bounded", async () => {
    let reads = 0;
    const calls: string[][] = [];
    const engine = kokoroEngine({ python: "p", script: "s", modelPath: "m", voicesPath: "v", appHome: "R",
      voices: { es: "x", en: "y" }, speed: 1, tmpDir: "C:\\tmp", unlink() {},
      settings: () => { reads++; return { voices: { es: reads === 1 ? "em_alex" : "ef_dora", en: "bm_george" }, speed: reads === 1 ? 1.2 : 9 }; },
      run: (_c, args) => { calls.push(args); return { exited: Promise.resolve(0), kill() {} }; } });
    const plan = createNarrationPlan("Open editor API", "es");
    await engine.synthesizePlan!(plan, "one.wav").exited;
    await engine.synthesizePlan!(plan, "two.wav").exited;
    expect(reads).toBe(2);
    expect(calls[0]).toEqual(expect.arrayContaining(["em_alex", "1.2", "--app-home", "R"]));
    expect(calls[1]).toEqual(expect.arrayContaining(["ef_dora", "1"]));
  });
  test("helper runner enforces offline UTF8 transport and only accepts bounded diagnostic JSON", async () => {
    const diagnostics: string[] = [];
    const runner = narrationRunner(c => diagnostics.push(c));
    const code = `const e=process.env; if(!['HF_HUB_OFFLINE','TRANSFORMERS_OFFLINE','HF_HUB_DISABLE_TELEMETRY','PYTHONDONTWRITEBYTECODE'].every(k=>e[k]==='1')||e.PYTHONUTF8!=='1') process.exit(3); console.log(JSON.stringify({diagnostics:['missing-local-assets']}));`;
    expect(await runner(process.execPath, ["-e", code, "--", "--plan-json"], "{}").exited).toBe(0);
    expect(diagnostics).toEqual(["missing-local-assets"]);
    expect(await runner(process.execPath, ["-e", `console.log(JSON.stringify({diagnostics:['private prose']}))`, "--", "--plan-json"], "{}").exited).toBe(2);
    expect(diagnostics).toHaveLength(1);
  });
  test("plan JSON uses the base voice once even with English expressions", async () => {
    const h = harness();
    const plan = createNarrationPlan("Hola API. Open editor.", "es");
    await h.engine.synthesizePlan!(plan, "owned.wav").exited;
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.args).toContain("--plan-json");
    expect(h.calls[0]!.args).toContain("ef_dora");
    expect(h.calls[0]!.args).not.toContain("af_heart");
    expect(JSON.parse(h.calls[0]!.stdin!)).toEqual(plan);
  });
  test("artifact synthesis writes the caller-owned WAV without invoking the player", async () => {
    const h = harness();
    await h.engine.synthesize!("Exact audio", "es", "C:\\owned\\candidate.wav").exited;
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.args).toContain("C:\\owned\\candidate.wav");
  });
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

  test("live settings override voices and speed on every call", async () => {
    const calls: string[][] = [];
    let voices = { es: "em_alex", en: "bm_george" };
    let speed = 1.1;
    const engine = kokoroEngine({
      python: "p", script: "s", modelPath: "m", voicesPath: "v", voices: { es: "x", en: "y" }, speed: 1,
      settings: () => ({ voices, speed }),
      run: (_c, args) => { calls.push(args); return { exited: Promise.resolve(0), kill() {} }; },
      tmpDir: "C:\\tmp", unlink: () => {},
    });
    await engine("x", "en").exited;
    expect(calls[0]).toEqual(expect.arrayContaining(["bm_george", "en-gb", "1.1"]));
    voices = { es: "em_santa", en: "af_heart" };
    speed = 0.9;
    await engine("x", "es").exited;
    expect(calls[2]).toEqual(expect.arrayContaining(["em_santa", "es", "0.9"]));
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
    expect(r?.voices).toEqual({ es: "em_alex", en: "af_heart" });
    expect(r?.speed).toBe(1);
  });
  test("undefined when the model is missing", () => {
    expect(resolveKokoro("R", {}, (p) => p !== "R\\kokoro\\kokoro-v1.0.onnx" && present.has(p))).toBeUndefined();
  });
  test("honors voice and speed overrides, ignoring a bad speed", () => {
    const r = resolveKokoro("R", { OPEN_VOX_KOKORO_VOICE_ES: "em_alex", AGENTVOZ_KOKORO_VOICE_EN: "am_adam", OPEN_VOX_SPEED: "1.25" }, () => true);
    expect(r?.voices).toEqual({ es: "em_alex", en: "am_adam" });
    expect(r?.speed).toBe(1.25);
    expect(resolveKokoro("R", { OPEN_VOX_SPEED: "abc" }, () => true)?.speed).toBe(1);
    expect(resolveKokoro("R", { AGENTVOZ_SPEED: "9" }, () => true)?.speed).toBe(1);
  });
});

describe("explicit narration runtime tuple", () => {
  const build = (runtime: () => import("../src/narration-runtime").NarrationRuntime | undefined, extra: Record<string, unknown> = {}) => {
    const calls: { cmd: string; args: string[] }[] = [];
    const engine = kokoroEngine({ python: "kokoro-py", script: "s", modelPath: "m", voicesPath: "v", appHome: "R",
      voices: { es: "em_alex", en: "af_heart" }, speed: 1, tmpDir: "R", unlink() {}, narrationRuntime: runtime, ...extra,
      run: (cmd, args) => { calls.push({ cmd, args }); return { exited: Promise.resolve(0), kill() {} }; } });
    return { engine, calls };
  };
  const plan = createNarrationPlan("synthetic text", "es");
  const torchArgs = ["s", "--model", "m", "--voices", "v", "--voice", "em_alex", "--lang", "es", "--speed", "1", "--out", "o.wav",
    "--plan-json", "--app-home", "R", "--lid-manifest", LID_MANIFEST_PATH];
  test("torch tuple yields the byte-identical legacy argument list", async () => {
    const { engine, calls } = build(() => ({ backend: "torch", python: "torch-py", lidManifest: LID_MANIFEST_PATH }));
    await engine.synthesizePlan!(plan, "o.wav").exited;
    const legacy = build(() => undefined, { narrationRuntime: undefined, narrationPython: () => "torch-py" });
    await legacy.engine.synthesizePlan!(plan, "o.wav").exited;
    expect(calls[0]!.cmd).toBe("torch-py");
    expect(calls[0]!.args).toEqual(torchArgs);
    expect(calls[0]!.args).toEqual(legacy.calls[0]!.args);
    expect(calls[0]!.args.join(" ")).not.toContain("--lid-backend");
    expect(calls[0]!.args.join(" ")).not.toContain("--lid-dir");
  });
  test("onnx tuple adds backend and absolute model dir with the onnx manifest and onnx interpreter only", async () => {
    const { engine, calls } = build(() => ({ backend: "onnx", python: "C:\\H\\pn-onnx-venv\\Scripts\\python.exe",
      lidManifest: "C:\\repo\\resources\\lid-model-onnx-fp32.json", lidDirectory: "C:\\H\\lid-onnx\\m\\rev" }));
    await engine.synthesizePlan!(plan, "o.wav").exited;
    expect(calls[0]!.cmd).toBe("C:\\H\\pn-onnx-venv\\Scripts\\python.exe");
    expect(calls[0]!.args).toEqual([...torchArgs.slice(0, -1), "C:\\repo\\resources\\lid-model-onnx-fp32.json",
      "--lid-backend", "onnx", "--lid-dir", "C:\\H\\lid-onnx\\m\\rev"]);
  });
  test("the runtime is resolved per plan call and never for non-plan synthesis", async () => {
    let n = 0;
    const { engine, calls } = build(() => { n++; return { backend: "torch", python: "torch-py", lidManifest: LID_MANIFEST_PATH }; });
    await engine.synthesize!("plain", "es", "o.wav").exited;
    expect(n).toBe(0);
    expect(calls[0]!.cmd).toBe("kokoro-py");
    expect(calls[0]!.args).not.toContain("--plan-json");
    await engine.synthesizePlan!(plan, "o.wav").exited;
    expect(n).toBe(1);
  });
  test("an onnx plan run passes the same bounded diagnostic validation as torch", async () => {
    const diagnostics: string[] = [];
    const runner = narrationRunner(c => diagnostics.push(c));
    const code = `console.log(JSON.stringify({diagnostics:['local-model-integrity-failed']}));`;
    expect(await runner(process.execPath, ["-e", code, "--", "--plan-json", "--lid-backend", "onnx", "--lid-dir", "C:\\x"], "{}").exited).toBe(0);
    expect(diagnostics).toEqual(["local-model-integrity-failed"]);
  });
});
