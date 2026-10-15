import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { KOKORO_VOICES } from "../src/config";
import { BUNDLED_VOICES_DIR, BUNDLED_VOICES_SCRIPT, KOKORO_FILES, setupKokoro } from "../src/setup";

const root = resolve(import.meta.dir, "..");
const VENV_PYTHON = "R\\kokoro-venv\\Scripts\\python.exe";

function env(existing: string[] = []) {
  const present = new Set(existing);
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      home: "R", systemPython: "python",
      exists: (p: string) => present.has(p),
      run: async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); present.add(VENV_PYTHON); return 0; },
      download: async (_url: string, dest: string) => { present.add(dest); },
      log: () => {},
    },
  };
}

describe("bundled voices in setup kokoro", () => {
  test("merges bundled voices into the downloaded pack with the venv python", async () => {
    const e = env();
    await setupKokoro(e.deps);
    const merge = e.calls[e.calls.length - 1]!;
    expect(merge[0]).toBe(VENV_PYTHON);
    expect(merge).toEqual([
      VENV_PYTHON, BUNDLED_VOICES_SCRIPT,
      "--pack", "R\\kokoro\\voices-v1.0.bin",
      "--voices-dir", BUNDLED_VOICES_DIR,
    ]);
  });

  test("also runs when everything is already installed, so existing installs receive the voice", async () => {
    const e = env([VENV_PYTHON, ...KOKORO_FILES.map((f) => `R\\kokoro\\${f.name}`)]);
    await setupKokoro(e.deps);
    expect(e.calls.some((c) => c.includes(BUNDLED_VOICES_SCRIPT))).toBe(true);
  });

  test("a failed merge fails the setup instead of leaving a catalog voice that cannot play", async () => {
    const e = env();
    e.deps.run = async (_cmd: string, args: string[]) => (args.includes(BUNDLED_VOICES_SCRIPT) ? 2 : 0);
    await expect(setupKokoro(e.deps)).rejects.toThrow();
  });

  test("the script and voices directory ship inside the repository", () => {
    expect(resolve(BUNDLED_VOICES_SCRIPT)).toBe(resolve(root, "scripts", "add_voices.py"));
    expect(resolve(BUNDLED_VOICES_DIR)).toBe(resolve(root, "resources", "voices"));
    expect(existsSync(BUNDLED_VOICES_SCRIPT)).toBe(true);
  });
});

describe("bundled voices and the catalog", () => {
  const files = readdirSync(resolve(root, "resources", "voices")).filter((f) => f.endsWith(".npy"));
  const ids = files.map((f) => basename(f, ".npy"));

  test("em_blocktype is bundled and selectable", () => {
    expect(ids).toContain("em_blocktype");
    expect(KOKORO_VOICES.find((v) => v.id === "em_blocktype")).toMatchObject({ language: "es" });
  });

  test("every bundled voice is in the catalog, so it can be chosen", () => {
    for (const id of ids) expect(KOKORO_VOICES.some((v) => v.id === id)).toBe(true);
  });

  test("bundled voice files have the expected size for a 510x1x256 float32 style", () => {
    for (const f of files) {
      const size = statSync(resolve(root, "resources", "voices", f)).size;
      expect(size).toBeGreaterThanOrEqual(510 * 256 * 4);
      expect(size).toBeLessThan(510 * 256 * 4 + 1024); // npy header only
    }
  });
});
