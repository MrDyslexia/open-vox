import { describe, expect, test } from "bun:test";
import { inspectInstall, install, uninstall, updateTuiConfig, type InstallFs } from "../src/installer";

function memoryFs(initial: Record<string, string> = {}): InstallFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    read: (path) => files.get(path),
    write: (path, data) => { files.set(path, data); },
    remove: (path) => { files.delete(path); },
    exists: (path) => files.has(path),
  };
}
const CFG = "C:\\u\\.config\\opencode";
const ROOT = "C:\\repo\\agentVoz";
const TEMPLATE = 'import { x } from "../src/config";\nexport default {};\n';
const base = { configDir: CFG, repoRoot: ROOT, tuiTemplate: TEMPLATE };
const PLUGIN = `${CFG}\\plugins\\open-vox.js`;
const TUI_FILE = `${CFG}\\tui-plugins\\open-vox.tsx`;
const TUI_JSON = `${CFG}\\tui.json`;

describe("updateTuiConfig", () => {
  test("creates a config with the entry when none exists", () => {
    const out = updateTuiConfig(undefined, "C:\\a.tsx", true);
    expect(JSON.parse(out).plugin).toEqual(["C:\\a.tsx"]);
  });
  test("preserves existing entries and unrelated keys, without duplicating", () => {
    const raw = JSON.stringify({ $schema: "s", theme: "t", plugin: ["x", ["y", { a: 1 }]] });
    const once = updateTuiConfig(raw, "C:\\a.tsx", true);
    const twice = updateTuiConfig(once, "C:\\a.tsx", true);
    expect(twice).toBe(once);
    const parsed = JSON.parse(once);
    expect(parsed.theme).toBe("t");
    expect(parsed.plugin).toEqual(["x", ["y", { a: 1 }], "C:\\a.tsx"]);
  });
  test("removes only the entry", () => {
    const raw = JSON.stringify({ plugin: ["x", "C:\\a.tsx"] });
    expect(JSON.parse(updateTuiConfig(raw, "C:\\a.tsx", false)).plugin).toEqual(["x"]);
  });
  test("refuses to rewrite a config it cannot parse", () => {
    expect(() => updateTuiConfig("{ // comment\n}", "C:\\a.tsx", true)).toThrow(/tui\.json/);
  });
});

describe("install", () => {
  test("writes the server loader pointing at the repository", () => {
    const fs = memoryFs();
    install({ ...base, fs, tui: false });
    expect(fs.files.get(PLUGIN)).toBe('export { OpenVoxPlugin } from "file:///C:/repo/agentVoz/src/index.ts";\n');
    expect(fs.files.has(TUI_FILE)).toBe(false);
    expect(fs.files.has(TUI_JSON)).toBe(false);
  });
  test("with tui, writes the generated TUI plugin with an absolute config import and registers it", () => {
    const fs = memoryFs({ [TUI_JSON]: JSON.stringify({ plugin: ["other"] }) });
    const result = install({ ...base, fs, tui: true });
    expect(fs.files.get(TUI_FILE)).toContain('from "file:///C:/repo/agentVoz/src/config.ts"');
    expect(fs.files.get(TUI_FILE)).not.toContain('"../src/config"');
    expect(JSON.parse(fs.files.get(TUI_JSON)!).plugin).toEqual(["other", TUI_FILE]);
    expect(result.tui).toBe(true);
  });
  test("is idempotent", () => {
    const fs = memoryFs();
    install({ ...base, fs, tui: true });
    const snapshot = new Map(fs.files);
    install({ ...base, fs, tui: true });
    expect(fs.files).toEqual(snapshot);
  });
  test("a malformed tui.json fails the TUI step but keeps the server plugin installed", () => {
    const fs = memoryFs({ [TUI_JSON]: "{ nope" });
    const result = install({ ...base, fs, tui: true });
    expect(fs.files.has(PLUGIN)).toBe(true);
    expect(result.tui).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/tui\.json/);
    expect(fs.files.get(TUI_JSON)).toBe("{ nope");
  });
});

describe("uninstall and inspect", () => {
  test("removes both loaders and the tui entry, leaving other entries", () => {
    const fs = memoryFs();
    install({ ...base, fs, tui: true });
    const raw = JSON.parse(fs.files.get(TUI_JSON)!);
    raw.plugin.push("other");
    fs.files.set(TUI_JSON, JSON.stringify(raw));
    uninstall({ ...base, fs });
    expect(fs.files.has(PLUGIN)).toBe(false);
    expect(fs.files.has(TUI_FILE)).toBe(false);
    expect(JSON.parse(fs.files.get(TUI_JSON)!).plugin).toEqual(["other"]);
  });
  test("uninstalling when nothing is installed is a no-op", () => {
    expect(() => uninstall({ ...base, fs: memoryFs() })).not.toThrow();
  });
  test("inspect reports what is installed", () => {
    const fs = memoryFs();
    expect(inspectInstall({ ...base, fs })).toEqual({ plugin: false, tuiFile: false, tuiRegistered: false });
    install({ ...base, fs, tui: true });
    expect(inspectInstall({ ...base, fs })).toEqual({ plugin: true, tuiFile: true, tuiRegistered: true });
  });
});

describe("legacy cleanup", () => {
  const OLD_PLUGIN = `${CFG}\\plugins\\agentvoz.js`;
  const OLD_TUI = `${CFG}\\tui-plugins\\agentvoz.tsx`;
  test("install removes the pre-rename files and entry, keeping other entries", () => {
    const fs = memoryFs({
      [OLD_PLUGIN]: "old", [OLD_TUI]: "old",
      [TUI_JSON]: JSON.stringify({ plugin: ["other", OLD_TUI] }),
    });
    const result = install({ ...base, fs, tui: true });
    expect(fs.files.has(OLD_PLUGIN)).toBe(false);
    expect(fs.files.has(OLD_TUI)).toBe(false);
    expect(JSON.parse(fs.files.get(TUI_JSON)!).plugin).toEqual(["other", TUI_FILE]);
    expect(result.removedLegacy).toBe(true);
  });
  test("uninstall also removes the pre-rename files", () => {
    const fs = memoryFs({ [OLD_PLUGIN]: "old", [OLD_TUI]: "old", [TUI_JSON]: JSON.stringify({ plugin: [OLD_TUI] }) });
    uninstall({ ...base, fs });
    expect(fs.files.has(OLD_PLUGIN)).toBe(false);
    expect(fs.files.has(OLD_TUI)).toBe(false);
    expect(JSON.parse(fs.files.get(TUI_JSON)!).plugin).toEqual([]);
  });
  test("a clean install reports no legacy removal", () => {
    expect(install({ ...base, fs: memoryFs(), tui: true }).removedLegacy).toBe(false);
  });
  test("a malformed tui.json still lets the legacy server loader be removed", () => {
    const fs = memoryFs({ [OLD_PLUGIN]: "old", [TUI_JSON]: "{ nope" });
    install({ ...base, fs, tui: true });
    expect(fs.files.has(OLD_PLUGIN)).toBe(false);
    expect(fs.files.get(TUI_JSON)).toBe("{ nope");
  });
});