import { describe, expect, test } from "bun:test";
import { runCli, type CliDeps } from "../src/cli";
import { DEFAULT_CONFIG, parseConfig, type Config } from "../src/config";
import type { InstallFs } from "../src/installer";
import { setupKokoro, KOKORO_FILES } from "../src/setup";

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
    writeConfig: (patch) => { config = parseConfig({ ...config, ...patch, voices: { ...config.voices, ...(patch.voices ?? {}) } }); return config; },
    configPath: "C:\\h\\config.json",
    installFs: fs, configDir: "C:\\cfg", repoRoot: "C:\\repo", tuiTemplate: 'import "../src/config";',
    exists: () => false,
    env: {},
    say: async (text) => { spoken.push(text); },
    setup: async (what) => { out.push(`setup ${what}`); },
    ...overrides,
  };
  return { deps, out, err, files, spoken, config: () => config };
}
const run = (argv: string[], h = harness()) => runCli(argv, h.deps).then((code) => ({ code, h }));

describe("pause / resume / toggle", () => {
  test("pause and resume persist the flag", async () => {
    const { code, h } = await run(["pause"]);
    expect(code).toBe(0);
    expect(h.config().paused).toBe(true);
    await runCli(["resume"], h.deps);
    expect(h.config().paused).toBe(false);
    await runCli(["toggle"], h.deps);
    expect(h.config().paused).toBe(true);
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

describe("speed and engine", () => {
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
    expect(h.files.has("C:\\cfg\\plugins\\agentvoz.js")).toBe(true);
    expect(h.files.has("C:\\cfg\\tui-plugins\\agentvoz.tsx")).toBe(true);
    expect(h.out.join("\n")).toMatch(/Restart OpenCode/i);
  });
  test("--no-tui skips the sidebar plugin", async () => {
    const { h } = await run(["install", "--no-tui"]);
    expect(h.files.has("C:\\cfg\\tui-plugins\\agentvoz.tsx")).toBe(false);
  });
  test("uninstall removes them", async () => {
    const h = harness();
    await runCli(["install"], h.deps);
    const code = await runCli(["uninstall"], h.deps);
    expect(code).toBe(0);
    expect(h.files.has("C:\\cfg\\plugins\\agentvoz.js")).toBe(false);
  });
});

describe("status, config and misc", () => {
  test("status shows pause state, voices and install state", async () => {
    const { h } = await run(["status"]);
    const text = h.out.join("\n");
    expect(text).toMatch(/paused: no/);
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
    expect(help.h.out.join("\n")).toMatch(/Usage: agentvoz/);
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
