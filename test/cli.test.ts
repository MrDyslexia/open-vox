import { describe, expect, test } from "bun:test";
import { runCli, type CliDeps } from "../src/cli";
import { DEFAULT_CONFIG, parseConfig, type Config } from "../src/config";
import type { InstallFs } from "../src/installer";
import { setupKokoro, KOKORO_FILES } from "../src/setup";
import { inspectNarration, LID_MANIFEST, narrationPaths, PN_READY_RECORD } from "../src/narration-assets";

function harness(overrides: Partial<CliDeps> = {}) {
  let config: Config = DEFAULT_CONFIG;
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const fs: InstallFs = {
    read: (p) => files.get(p), write: (p, d) => { files.set(p, d); }, remove: (p) => { files.delete(p); }, exists: (p) => files.has(p),
  };
  const spoken: string[] = [];
  const deps: CliDeps = {
    out: (l) => out.push(l), err: (l) => err.push(l),
    readConfig: () => config,
    writeConfig: (patch) => { config = parseConfig({ ...config, ...patch,
      voices: { ...config.voices, ...(patch.voices ?? {}) },
      toneVoice: { ...config.toneVoice, ...(patch.toneVoice ?? {}) },
      toneWeight: { ...config.toneWeight, ...(patch.toneWeight ?? {}) },
    }); return config; },
    configPath: "C:\\h\\config.json",
    installFs: fs, configDir: "C:\\cfg", repoRoot: "C:\\repo", tuiTemplate: 'import "../src/config";',
    exists: () => false,
    env: {},
    say: async (text) => { spoken.push(text); },
    migrateHome: () => undefined,
    setup: async (what) => { out.push(`setup ${what}`); },
    ...overrides,
  };
  return { deps, out, err, files, spoken, config: () => config };
}
const run = (argv: string[], h = harness()) => runCli(argv, h.deps).then((code) => ({ code, h }));

describe("explicit GPU setup and activation", () => {
  test("setup gpu does not migrate, install the plugin, synthesize or write config", async () => {
    const h = harness({ migrateHome: () => { throw Error("no migration"); }, writeConfig: () => { throw Error("no activation"); } });
    expect(await runCli(["setup", "gpu"], h.deps)).toBe(0);
    expect(h.out).toEqual(["setup gpu"]); expect(h.spoken).toEqual([]); expect(h.files.size).toBe(0);
  });
  test("unqualified, partially ready, unsupported and Torch-profile activation preserve config", async () => {
    for (const gpu of [{ ready: false, qualified: false }, { ready: true, qualified: false }, { ready: true, qualified: true }]) {
      const h = harness({ gpuStatus: () => ({ ...gpu, code: "mock" }) });
      if (!gpu.qualified) h.deps.writeConfig({ narrationBackend: "onnx", speed: 1.2 });
      const before = structuredClone(h.config());
      expect(await runCli(["runtime-profile", "cuda13"], h.deps)).toBe(1);
      expect(h.config()).toEqual(before);
      expect(await runCli(["runtime-profile", "C:\\foreign\\python.exe"], h.deps)).toBe(2);
    }
  });
  test("qualification permits only an explicit profile patch, and CPU rollback stays explicit", async () => {
    const h = harness({ gpuStatus: () => ({ ready: true, qualified: true, code: "qualified-cuda13" }) });
    h.deps.writeConfig({ narrationBackend: "onnx", speed: 1.2, voices: { en: "bm_george" } });
    expect(await runCli(["runtime-profile", "cuda13"], h.deps)).toBe(0);
    expect(h.config()).toMatchObject({ runtimeProfile: "cuda13", speed: 1.2, voices: { en: "bm_george" } });
    expect(await runCli(["runtime-profile", "cpu"], h.deps)).toBe(0);
    expect(h.config().runtimeProfile).toBe("cpu");
  });
});

describe("removed pause / resume / toggle", () => {
  test("they are unknown commands that change nothing and never write the config", async () => {
    for (const command of ["pause", "resume", "toggle"]) {
      let writes = 0;
      const h = harness();
      const base = h.deps.writeConfig;
      h.deps.writeConfig = (patch) => { writes++; return base(patch); };
      const code = await runCli([command], h.deps);
      expect(code).toBe(2);
      expect(h.err.join(" ")).toContain(`Unknown command "${command}"`);
      expect(writes).toBe(0);
      expect(h.config()).toEqual(DEFAULT_CONFIG);
    }
  });
  test("help no longer advertises them", async () => {
    const help = (await run(["help"])).h.out.join("\n");
    expect(help).not.toMatch(/pause|resume|toggle/i);
  });
});

describe("voice", () => {
  test("a Spanish voice id sets the Spanish slot", async () => {
    const { code, h } = await run(["voice", "em_santa"]);
    expect(code).toBe(0);
    expect(h.config().voices).toEqual({ es: "em_santa", en: "af_heart" });
  });
  test("an English voice id sets the English slot", async () => {
    const { h } = await run(["voice", "bm_george"]);
    expect(h.config().voices.en).toBe("bm_george");
  });
  test("an unknown voice is rejected with exit 2 and does not change anything", async () => {
    const { code, h } = await run(["voice", "nope"]);
    expect(code).toBe(2);
    expect(h.err.join(" ")).toMatch(/Unknown voice/);
    expect(h.config()).toEqual(DEFAULT_CONFIG);
  });
  test("with no argument it prints the current voices", async () => {
    const { h } = await run(["voice"]);
    expect(h.out.join("\n")).toMatch(/es: em_alex/);
    expect(h.out.join("\n")).toMatch(/en: af_heart/);
  });
  test("voices lists the catalog grouped by language", async () => {
    const { h } = await run(["voices"]);
    const text = h.out.join("\n");
    expect(text).toMatch(/em_alex/);
    expect(text).toMatch(/bm_george/);
  });
});

describe("tone", () => {
  test("reads both languages or one selected language without writing", async () => {
    const h = harness({ writeConfig: () => { throw Error("read must not write"); } });
    expect(await runCli(["tone"], h.deps)).toBe(0);
    expect(h.out).toEqual(["es: off (weight 0)", "en: off (weight 0)"]);
    h.out.length = 0;
    expect(await runCli(["tone", "en"], h.deps)).toBe(0);
    expect(h.out).toEqual(["en: off (weight 0)"]);
  });
  test("sets a cross-language donor, preserves the sibling and clears donor and weight on off", async () => {
    const h = harness();
    expect(await runCli(["tone", "en", "em_alex", "1"], h.deps)).toBe(0);
    expect(await runCli(["tone", "es", "am_onyx", "0.75"], h.deps)).toBe(0);
    expect(h.config()).toMatchObject({ toneVoice: { es: "am_onyx", en: "em_alex" }, toneWeight: { es: 0.75, en: 1 } });
    await runCli(["tone", "es"], h.deps);
    expect(h.out.at(-1)).toBe("es: am_onyx (weight 0.75)");
    expect(await runCli(["tone", "es", "off"], h.deps)).toBe(0);
    expect(h.config()).toMatchObject({ toneVoice: { es: "", en: "em_alex" }, toneWeight: { es: 0, en: 1 } });
    expect(h.config().voices).toEqual(DEFAULT_CONFIG.voices);
    expect(h.config().speed).toBe(1);
  });
  test("invalid donor, weight, language or arity writes nothing", async () => {
    const h = harness({ writeConfig: () => { throw Error("invalid input must not write"); } });
    for (const args of [["fr"], ["es", "am_onyx"], ["es", "unknown", "0.75"], ["es", "off", "0"],
      ["es", "off", "extra"], ["es", "am_onyx", "0.75", "extra"],
      ...["", " ", "NaN", "Infinity", "-0.1", "1.1", "abc"].map(w => ["es", "am_onyx", w])]) {
      expect(await runCli(["tone", ...args], h.deps)).toBe(2);
    }
    expect(h.config()).toEqual(DEFAULT_CONFIG);
  });
  test("zero weight is accepted; help, status and reset describe tone without promising orthogonality", async () => {
    const h = harness();
    expect(await runCli(["tone", "es", "am_onyx", "0"], h.deps)).toBe(0);
    await runCli(["tone", "es", "am_onyx", "0.75"], h.deps);
    await runCli(["status"], h.deps);
    expect(h.out.join("\n")).toContain("tone es: am_onyx (weight 0.75)");
    expect(h.out.join("\n")).toContain("tone en: off (weight 0)");
    const help = (await run(["help"])).h.out.join("\n");
    expect(help).toContain("tone");
    expect(help).toContain("experimental style interpolation");
    expect(help).toContain("duration");
    expect(help).toContain("separate rate control");
    await runCli(["config", "reset"], h.deps);
    expect(h.config()).toEqual(DEFAULT_CONFIG);
  });
});

describe("speed and engine", () => {
  test("language controls the base without changing either voice slot", async () => {
    const h = harness();
    expect(await runCli(["language", "en"], h.deps)).toBe(0);
    expect(h.config().narrationLanguage).toBe("en");
    expect(h.config().voices).toEqual(DEFAULT_CONFIG.voices);
    expect(await runCli(["language", "fr"], h.deps)).toBe(2);
    expect(await runCli(["language", "es", "extra"], h.deps)).toBe(2);
    await runCli(["config", "reset"], h.deps);
    expect(h.config().narrationLanguage).toBe("es");
  });
  test("speed accepts the valid range only", async () => {
    expect((await run(["speed", "1.2"])).h.config().speed).toBe(1.2);
    const bad = await run(["speed", "5"]);
    expect(bad.code).toBe(2);
    expect((await run(["speed", "abc"])).code).toBe(2);
  });
  test("engine accepts known names only", async () => {
    expect((await run(["engine", "piper"])).h.config().engine).toBe("piper");
    expect((await run(["engine", "xtts"])).code).toBe(2);
  });
});

describe("say", () => {
  test("speaks the joined text", async () => {
    const { h } = await run(["say", "hola", "mundo"]);
    expect(h.spoken).toEqual(["hola mundo"]);
  });
  test("requires text", async () => {
    expect((await run(["say"])).code).toBe(2);
  });
});

describe("install / uninstall", () => {
  test("install writes the loaders and prints what to do next", async () => {
    const { code, h } = await run(["install"]);
    expect(code).toBe(0);
    expect(h.files.has("C:\\cfg\\plugins\\open-vox.js")).toBe(true);
    expect(h.files.has("C:\\cfg\\tui-plugins\\open-vox\\tui.tsx")).toBe(true);
    expect(h.out.join("\n")).toMatch(/Restart OpenCode/i);
  });
  test("--no-tui skips the sidebar plugin", async () => {
    const { h } = await run(["install", "--no-tui"]);
    expect(h.files.has("C:\\cfg\\tui-plugins\\open-vox\\tui.tsx")).toBe(false);
  });
  test("uninstall removes them", async () => {
    const h = harness();
    await runCli(["install"], h.deps);
    const code = await runCli(["uninstall"], h.deps);
    expect(code).toBe(0);
    expect(h.files.has("C:\\cfg\\plugins\\open-vox.js")).toBe(false);
  });
});

describe("status, config and misc", () => {
  test("narration setup is explicit and help distinguishes contextual provisioning", async () => {
    const h = harness();
    expect(await runCli(["setup", "narration"], h.deps)).toBe(0);
    expect(h.out).toContain("setup narration");
    expect((await run(["help"])).h.out.join("\n")).toContain("setup narration");
  });
  test("doctor separates missing contextual narration from Kokoro availability", async () => {
    const h = harness({ exists: () => true });
    await runCli(["doctor"], h.deps);
    expect(h.out.join("\n")).toContain("Kokoro engine: ready");
    expect(h.out.join("\n")).toMatch(/WARN.*Contextual narration:.*degraded.*setup narration/);
  });
  test("doctor reports contextual verification separately and does not mutate configuration", async () => {
    const h = harness({ exists: () => true, narrationStatus: async () => ({ ready: true, code: "verified-local-assets-and-dependencies" }) });
    h.deps.writeConfig = () => { throw Error("doctor must not write"); };
    await runCli(["doctor"], h.deps);
    expect(h.out.join("\n")).toMatch(/OK.*Contextual narration: verified local assets\/dependencies/);
    h.deps.narrationStatus = async () => ({ ready: false, code: "local-model-integrity-failed" });
    h.out.length = 0;
    await runCli(["doctor"], h.deps);
    expect(h.out.join("\n")).toMatch(/WARN.*Contextual narration: degraded: local-model-integrity-failed/);
    expect(await runCli(["setup", "narration", "extra"], h.deps)).toBe(2);
  });
  test("doctor binds provenance probing to configured app home and degrades foreign dependencies", async () => {
    const home = "C:\\managed-home";
    let probes = 0;
    const h = harness({ exists: () => true, env: { OPEN_VOX_HOME: home },
      narrationStatus: root => inspectNarration(root, {
        exists: () => true, read: () => PN_READY_RECORD, validateDirectory() {},
        fingerprint: p => LID_MANIFEST.files.find(f => p.endsWith(`\\${f.filename}`))!,
        probe: async (python, expectedVenv) => {
          probes++;
          expect(root).toBe(home);
          expect(python).toBe(narrationPaths(home).python);
          expect(expectedVenv).toBe(narrationPaths(home).venv);
          return 1;
        },
      }) });
    h.deps.writeConfig = () => { throw Error("doctor must not write"); };
    await runCli(["doctor"], h.deps);
    expect(probes).toBe(1);
    expect(h.out.join("\n")).toContain("Kokoro engine: ready");
    expect(h.out.join("\n")).toMatch(/WARN.*Contextual narration: degraded: missing-or-incompatible-dependencies/);
  });
  test("status shows voices and install state but no pause state", async () => {
    const { h } = await run(["status"]);
    const text = h.out.join("\n");
    expect(text).not.toMatch(/paused/);
    expect(text).toMatch(/voices: es: em_alex, en: af_heart/);
    expect(text).toMatch(/plugin: not installed/);
  });
  test("config path prints the path; reset restores defaults", async () => {
    const h = harness();
    await runCli(["speed", "1.5"], h.deps);
    await runCli(["config", "path"], h.deps);
    expect(h.out.join("\n")).toContain("C:\\h\\config.json");
    await runCli(["config", "reset"], h.deps);
    expect(h.config()).toEqual(DEFAULT_CONFIG);
  });
  test("config reset writes only the persisted settings, never a paused flag", async () => {
    const patches: object[] = [];
    const h = harness();
    const base = h.deps.writeConfig;
    h.deps.writeConfig = (patch) => { patches.push(patch); return base(patch); };
    await runCli(["config", "reset"], h.deps);
    expect(patches).toEqual([DEFAULT_CONFIG]);
  });
  test("setup delegates", async () => {
    const { code, h } = await run(["setup", "kokoro"]);
    expect(code).toBe(0);
    expect(h.out).toContain("setup kokoro");
    expect((await run(["setup", "other"])).code).toBe(2);
  });
  test("unknown commands and help", async () => {
    expect((await run(["wat"])).code).toBe(2);
    const help = await run(["help"]);
    expect(help.code).toBe(0);
    expect(help.h.out.join("\n")).toMatch(/Usage: open-vox/);
    expect((await run([])).code).toBe(0);
  });
  test("doctor reports failures with a nonzero exit", async () => {
    const { code, h } = await run(["doctor"]);
    expect(code).toBe(1);
    expect(h.out.join("\n")).toMatch(/FAIL|WARN/);
  });
});

describe("setupKokoro", () => {
  const home = "R";
  function env(existing: string[] = []) {
    const present = new Set(existing);
    const calls: string[] = [];
    return {
      calls,
      deps: {
        home, systemPython: "python",
        exists: (p: string) => present.has(p),
        run: async (cmd: string, args: string[]) => { calls.push(`run ${cmd} ${args.join(" ")}`); present.add("R\\kokoro-venv\\Scripts\\python.exe"); return 0; },
        download: async (url: string, dest: string) => { calls.push(`download ${url} -> ${dest}`); present.add(dest); },
        log: () => {},
      },
    };
  }
  test("creates the venv, installs packages, downloads both files", async () => {
    const e = env();
    await setupKokoro(e.deps);
    expect(e.calls[0]).toContain("-m venv R\\kokoro-venv");
    expect(e.calls[1]).toContain("pip install");
    expect(e.calls[1]).toContain("kokoro-onnx");
    expect(e.calls.filter((c) => c.startsWith("download"))).toHaveLength(KOKORO_FILES.length);
  });
  test("skips everything already present", async () => {
    const e = env(["R\\kokoro-venv\\Scripts\\python.exe", "R\\kokoro\\kokoro-v1.0.onnx", "R\\kokoro\\voices-v1.0.bin"]);
    await setupKokoro(e.deps);
    expect(e.calls.filter((c) => c.startsWith("download"))).toHaveLength(0);
    expect(e.calls.filter((c) => c.includes("-m venv"))).toHaveLength(0);
  });
  test("fails when a command exits nonzero", async () => {
    const e = env();
    e.deps.run = async () => 1;
    await expect(setupKokoro(e.deps)).rejects.toThrow();
  });
});

describe("data folder migration", () => {
  test("install migrates the legacy folder and reports it", async () => {
    const moves: string[] = [];
    const h = harness({ migrateHome: () => { moves.push("moved"); return { from: "C:\\L\\agentVoz", to: "C:\\L\\open-vox" }; } });
    await runCli(["install"], h.deps);
    expect(moves).toHaveLength(1);
    expect(h.out.join("\n")).toMatch(/Moved your data/);
  });
  test("a migration failure is a warning, not a failed install", async () => {
    const h = harness({ migrateHome: () => { throw new Error("EBUSY"); } });
    const code = await runCli(["install"], h.deps);
    expect(code).toBe(0);
    expect(h.err.join("\n")).toMatch(/EBUSY/);
    expect(h.files.has("C:\\cfg\\plugins\\open-vox.js")).toBe(true);
  });
  test("install tells the user when old plugin files were removed", async () => {
    const h = harness();
    h.files.set("C:\\cfg\\plugins\\agentvoz.js", "old");
    await runCli(["install"], h.deps);
    expect(h.out.join("\n")).toMatch(/Removed old plugin files/);
  });
  test("install reports the migrated OpenCode 1.x sidebar file", async () => {
    const h = harness();
    h.files.set("C:\\cfg\\tui-plugins\\open-vox.tsx", "old");
    await runCli(["install"], h.deps);
    expect(h.files.has("C:\\cfg\\tui-plugins\\open-vox.tsx")).toBe(false);
    expect(h.out.join("\n")).toMatch(/OpenCode 1\.x sidebar layout/);
  });
});

describe("ONNX narration provisioning and doctor", () => {
  test("help documents the explicit local-source command and that it does not activate the backend", async () => {
    const help = (await run(["help"])).h.out.join("\n");
    expect(help).toContain("setup narration-onnx --lid-source <dir>");
    expect(help).toMatch(/does not activate|not activate/i);
  });
  test("setup narration-onnx forwards the source and keeps the existing targets unchanged", async () => {
    const seen: unknown[][] = [];
    const h = harness({ setup: async (...a: unknown[]) => { seen.push(a); } });
    expect(await runCli(["setup", "narration-onnx", "--lid-source", "D:\\models\\lid"], h.deps)).toBe(0);
    expect(seen).toEqual([["narration-onnx", { lidSource: "D:\\models\\lid" }]]);
    seen.length = 0;
    expect(await runCli(["setup", "narration"], h.deps)).toBe(0);
    expect(seen).toEqual([["narration"]]);
  });
  test.each([
    [["setup", "narration-onnx"]],
    [["setup", "narration-onnx", "--lid-source"]],
    [["setup", "narration-onnx", "--lid-source", "--other"]],
    [["setup", "narration-onnx", "D:\\x"]],
    [["setup", "narration-onnx", "--lid-source", "D:\\x", "extra"]],
    [["setup", "narration", "--lid-source", "D:\\x"]],
  ])("%j is a usage error that provisions nothing", async argv => {
    let called = 0;
    const h = harness({ setup: async () => { called++; } });
    expect(await runCli(argv, h.deps)).toBe(2);
    expect(called).toBe(0);
    expect(h.err.join("\n")).toContain("Usage: open-vox setup");
  });
  test("doctor reports an absent ONNX environment as informational and keeps exit 0", async () => {
    const h = harness({ exists: () => true, narrationStatus: async () => ({ ready: true, code: "verified-local-assets-and-dependencies" }),
      narrationOnnxStatus: async () => ({ ready: false, code: "missing-managed-environment" }) });
    h.deps.installFs.write("C:\\cfg\\plugins\\open-vox.js", "x");
    const code = await runCli(["doctor"], h.deps);
    expect(h.out.join("\n")).toMatch(/INFO Contextual narration \(ONNX\): not provisioned/);
    expect(h.out.join("\n")).not.toMatch(/WARN.*ONNX|FAIL.*ONNX/);
    expect(code).toBe(h.out.some(l => l.startsWith("FAIL")) ? 1 : 0);
    const without = harness({ exists: () => true });
    await runCli(["doctor"], without.deps);
    expect(without.out.join("\n")).not.toContain("ONNX");
  });
  test("doctor ONNX failures are WARN and never FAIL; ready is OK and says inactive", async () => {
    const make = (status: { ready: boolean; code: string }) => harness({ exists: () => true, narrationOnnxStatus: async () => status });
    const bad = make({ ready: false, code: "local-model-integrity-failed" });
    const withBad = await runCli(["doctor"], bad.deps);
    expect(bad.out.join("\n")).toMatch(/WARN Contextual narration \(ONNX\): degraded: local-model-integrity-failed/);
    const ok = make({ ready: true, code: "verified-local-assets-and-dependencies" });
    const withOk = await runCli(["doctor"], ok.deps);
    expect(ok.out.join("\n")).toMatch(/OK\s+Contextual narration \(ONNX\): verified local assets\/dependencies.*not selected/);
    expect(withBad).toBe(withOk);
  });
});

describe("narration-backend", () => {
  const ready = { ready: true, code: "verified-local-assets-and-dependencies" };
  const notReady = { ready: false, code: "missing-managed-environment" };
  const counted = (overrides: Partial<CliDeps> = {}) => {
    const h = harness(overrides);
    const writes: unknown[] = [];
    const base = h.deps.writeConfig;
    h.deps.writeConfig = patch => { writes.push(patch); return base(patch); };
    return { h, writes };
  };
  test("no argument prints the current backend and defaults to torch; nothing is written", async () => {
    const { h, writes } = counted();
    expect(await runCli(["narration-backend"], h.deps)).toBe(0);
    expect(h.out).toEqual(["Narration backend: torch."]);
    expect(writes).toEqual([]);
  });
  test("torch always succeeds without consulting ONNX readiness", async () => {
    let probed = 0;
    const { h } = counted({ narrationOnnxStatus: async () => { probed++; return notReady; } });
    h.deps.writeConfig({ narrationBackend: "onnx" });
    expect(await runCli(["narration-backend", "torch"], h.deps)).toBe(0);
    expect(h.config().narrationBackend).toBe("torch");
    expect(h.out).toEqual(["Narration backend set to torch."]);
    expect(probed).toBe(0);
  });
  test("onnx is persisted only when ONNX readiness holds", async () => {
    const homes: string[] = [];
    const { h } = counted({ env: { LOCALAPPDATA: "C:\\L" }, narrationOnnxStatus: async home => { homes.push(home); return ready; } });
    expect(await runCli(["narration-backend", "onnx"], h.deps)).toBe(0);
    expect(h.config().narrationBackend).toBe("onnx");
    expect(h.out).toEqual(["Narration backend set to onnx."]);
    expect(homes).toHaveLength(1);
    expect(await runCli(["narration-backend"], h.deps)).toBe(0);
    expect(h.out.at(-1)).toBe("Narration backend: onnx.");
  });
  test.each([
    ["not ready", { narrationOnnxStatus: async () => notReady }],
    ["integrity failure", { narrationOnnxStatus: async () => ({ ready: false, code: "local-model-integrity-failed" }) }],
    ["inspector throws", { narrationOnnxStatus: async () => { throw new Error("boom"); } }],
    ["inspector not wired", {}],
  ] as const)("onnx refuses when %s: nonzero exit, nothing persisted, actionable message", async (_name, overrides) => {
    const { h, writes } = counted(overrides as Partial<CliDeps>);
    expect(await runCli(["narration-backend", "onnx"], h.deps)).toBe(1);
    expect(writes).toEqual([]);
    expect(h.config().narrationBackend).toBe("torch");
    expect(h.err.join("\n")).toContain("open-vox setup narration-onnx --lid-source <dir>");
    expect(h.out).toEqual([]);
  });
  test.each([[["narration-backend", "fp16"]], [["narration-backend", "torch", "x"]], [["narration-backend", "ONNX"]], [["narration-backend", ""]]])(
    "%j is a usage error that writes nothing", async argv => {
      const { h, writes } = counted({ narrationOnnxStatus: async () => ready });
      expect(await runCli(argv, h.deps)).toBe(2);
      expect(writes).toEqual([]);
      expect(h.err.join("\n")).toContain("Usage: open-vox narration-backend [torch|onnx]");
    });
  test("help, status and config reset know the backend; reset returns to torch", async () => {
    expect((await run(["help"])).h.out.join("\n")).toContain("narration-backend [torch|onnx]");
    const { h } = counted({ narrationOnnxStatus: async () => ready });
    await runCli(["narration-backend", "onnx"], h.deps);
    await runCli(["status"], h.deps);
    expect(h.out.join("\n")).toContain("narration backend: onnx");
    await runCli(["config", "reset"], h.deps);
    expect(h.config().narrationBackend).toBe("torch");
  });
});
