import { describe, expect, test } from "bun:test";
import { inspectInstall, install, uninstall, updateTuiConfig, type InstallFs } from "../src/installer";
import { readFileSync } from "node:fs";

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
const TUI_FILE = `${CFG}\\tui-plugins\\open-vox\\tui.tsx`;
const V1_TUI_FILE = `${CFG}\\tui-plugins\\open-vox.tsx`;
const TUI_JSON = `${CFG}\\tui.json`;
const CLI_JSON = `${CFG}\\cli.json`;
const TUI_ENTRY = "file:///C:/u/.config/opencode/tui-plugins/open-vox";
const registered = (fs: { files: Map<string, string> }) => JSON.parse(fs.files.get(CLI_JSON)!).plugins;

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
  test("actual sidebar template copies the device formatter rewriting every repository import", () => {
    const fs = memoryFs();
    const template = readFileSync(new URL("../tui/open-vox.tsx", import.meta.url), "utf8");
    install({ ...base, fs, tui: true, tuiTemplate: template });
    const copied = fs.files.get(TUI_FILE)!;
    expect(copied).toContain('from "file:///C:/repo/agentVoz/src/config.ts"');
    expect(copied).toContain('from "file:///C:/repo/agentVoz/src/repeat-ui.ts"');
    expect(copied).toContain('from "file:///C:/repo/agentVoz/src/rpc.ts"');
    expect(copied).toContain("{deviceLabel(view())}");
    expect(copied).not.toContain('from "../src/');
  });
  test("rewrites the Repeat helper import in the copied TUI without touching settings", () => {
    const fs = memoryFs();
    install({ ...base, fs, tui: true, tuiTemplate: TEMPLATE + 'import { x } from "../src/repeat-ui";' });
    expect(fs.files.get(TUI_FILE)).toContain('from "file:///C:/repo/agentVoz/src/repeat-ui.ts"');
    expect(fs.files.get(TUI_FILE)).not.toContain('"../src/repeat-ui"');
  });
  test("writes the V2 server loader pointing at the repository", () => {
    const fs = memoryFs();
    install({ ...base, fs, tui: false });
    expect(fs.files.get(PLUGIN)).toBe('export { default } from "file:///C:/repo/agentVoz/src/opencode-v2.ts";\n');
    expect(fs.files.has(TUI_FILE)).toBe(false);
    expect(fs.files.has(CLI_JSON)).toBe(false);
  });
  test("with tui, writes the TUI plugin directory and registers it in cli.json, keeping other entries and keys", () => {
    const fs = memoryFs({ [CLI_JSON]: JSON.stringify({ plugins: ["other"], animations: true }) });
    const result = install({ ...base, fs, tui: true });
    expect(fs.files.get(TUI_FILE)).toContain('from "file:///C:/repo/agentVoz/src/config.ts"');
    expect(fs.files.get(TUI_FILE)).not.toContain('"../src/config"');
    expect(registered(fs)).toEqual(["other", TUI_ENTRY]);
    expect(JSON.parse(fs.files.get(CLI_JSON)!).animations).toBe(true);
    expect(fs.files.has(TUI_JSON)).toBe(false);
    expect(result).toMatchObject({ tui: true, tuiFile: TUI_FILE });
  });
  test("migrates the V1 single-file TUI and its tui.json entry, keeping other entries", () => {
    const fs = memoryFs({ [V1_TUI_FILE]: "old", [TUI_JSON]: JSON.stringify({ plugin: ["other", V1_TUI_FILE] }) });
    const result = install({ ...base, fs, tui: true });
    expect(fs.files.has(V1_TUI_FILE)).toBe(false);
    expect(JSON.parse(fs.files.get(TUI_JSON)!).plugin).toEqual(["other"]);
    expect(registered(fs)).toEqual([TUI_ENTRY]);
    expect(result.removedLegacy).toBe(true);
  });
  test("drops the V1 file entry OpenCode copied from tui.json into cli.json", () => {
    const fs = memoryFs({ [CLI_JSON]: JSON.stringify({ plugins: ["other", V1_TUI_FILE] }) });
    install({ ...base, fs, tui: true });
    expect(registered(fs)).toEqual(["other", TUI_ENTRY]);
  });
  test("is idempotent", () => {
    const fs = memoryFs();
    install({ ...base, fs, tui: true });
    const snapshot = new Map(fs.files);
    install({ ...base, fs, tui: true });
    expect(fs.files).toEqual(snapshot);
  });
  test("a malformed cli.json fails the TUI step but keeps the server plugin installed", () => {
    const fs = memoryFs({ [CLI_JSON]: "{ nope" });
    const result = install({ ...base, fs, tui: true });
    expect(fs.files.has(PLUGIN)).toBe(true);
    expect(fs.files.has(TUI_FILE)).toBe(false);
    expect(result.tui).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/cli\.json/);
    expect(fs.files.get(CLI_JSON)).toBe("{ nope");
  });
});

describe("uninstall and inspect", () => {
  test("removes both loaders and the cli.json entry, leaving other entries", () => {
    const fs = memoryFs();
    install({ ...base, fs, tui: true });
    const raw = JSON.parse(fs.files.get(CLI_JSON)!);
    raw.plugins.push("other");
    fs.files.set(CLI_JSON, JSON.stringify(raw));
    uninstall({ ...base, fs });
    expect(fs.files.has(PLUGIN)).toBe(false);
    expect(fs.files.has(TUI_FILE)).toBe(false);
    expect(registered(fs)).toEqual(["other"]);
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
    expect(JSON.parse(fs.files.get(TUI_JSON)!).plugin).toEqual(["other"]);
    expect(registered(fs)).toEqual([TUI_ENTRY]);
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
