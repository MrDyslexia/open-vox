import { win32 } from "node:path";
import { LEGACY, NAME } from "./brand";

export type InstallFs = {
  read: (path: string) => string | undefined;
  write: (path: string, data: string) => void;
  remove: (path: string) => void;
  exists: (path: string) => boolean;
};
export type InstallOptions = {
  fs: InstallFs;
  /** OpenCode config directory, e.g. %USERPROFILE%\.config\opencode */
  configDir: string;
  /** Absolute path of this repository checkout. */
  repoRoot: string;
  /** Source of the TUI plugin; its `"../src/*"` imports are rewritten to absolute URLs. */
  tuiTemplate: string;
};
export type InstallResult = { plugin: string; tui: boolean; tuiFile?: string; warnings: string[]; removedLegacy: boolean };
export type InstallState = { plugin: boolean; tuiFile: boolean; tuiRegistered: boolean };

// OpenCode V2 loads TUI plugins listed in cli.json `plugins`, and only as directories holding a
// `tui.*` entry; single-file targets are skipped. The V1 layout (a single .tsx file registered
// in tui.json) is migrated away on install.
export const paths = (configDir: string) => ({
  plugin: win32.join(configDir, "plugins", `${NAME}.js`),
  tuiDir: win32.join(configDir, "tui-plugins", NAME),
  tuiFile: win32.join(configDir, "tui-plugins", NAME, "tui.tsx"),
  cliJson: win32.join(configDir, "cli.json"),
  tuiJson: win32.join(configDir, "tui.json"),
  v1TuiFile: win32.join(configDir, "tui-plugins", `${NAME}.tsx`),
  legacyPlugin: win32.join(configDir, "plugins", LEGACY.pluginFile),
  legacyTuiFile: win32.join(configDir, "tui-plugins", LEGACY.tuiFile),
});

const fileUrl = (absolutePath: string) => "file:///" + encodeURI(absolutePath.replace(/\\/g, "/"));
/** The cli.json entry that registers the TUI plugin directory. */
export const tuiEntry = (configDir: string) => fileUrl(paths(configDir).tuiDir);

type TuiEntry = string | [string, unknown];
const entrySpec = (entry: unknown): string | undefined =>
  typeof entry === "string" ? entry : Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : undefined;

type PluginList = { file: string; key: string; schema: string };
const TUI_JSON: PluginList = { file: "tui.json", key: "plugin", schema: "https://opencode.ai/tui.json" };
const CLI_JSON: PluginList = { file: "cli.json", key: "plugins", schema: "https://opencode.ai/v2/cli.json" };

/** Adds or removes one plugin entry in a plugin list, preserving everything else. Throws on unparsable input. */
function updatePluginList(list: PluginList, raw: string | undefined, entry: string, add: boolean): string {
  let config: Record<string, unknown>;
  if (raw === undefined) {
    config = { $schema: list.schema };
  } else {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      config = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`${list.file} is not plain JSON (comments or syntax errors); add the plugin entry manually`);
    }
  }
  const current: TuiEntry[] = Array.isArray(config[list.key]) ? (config[list.key] as TuiEntry[]) : [];
  const without = current.filter((item) => entrySpec(item) !== entry);
  const plugin = add ? [...without, entry] : without;
  const next: Record<string, unknown> = { ...config };
  if (plugin.length > 0 || list.key in config) next[list.key] = plugin;
  return JSON.stringify(next, null, 2) + "\n";
}

/** Adds or removes one plugin entry in the V1 tui.json, preserving everything else. Throws on unparsable input. */
export const updateTuiConfig = (raw: string | undefined, entry: string, add: boolean) => updatePluginList(TUI_JSON, raw, entry, add);
/** Adds or removes one plugin entry in the V2 cli.json `plugins` list. Throws on unparsable input. */
export const updateCliConfig = (raw: string | undefined, entry: string, add: boolean) => updatePluginList(CLI_JSON, raw, entry, add);

/** Removes pre-rename and V1-layout TUI loaders so OpenCode never loads two copies. Returns whether anything was removed. */
function removeLegacy(fs: InstallFs, p: ReturnType<typeof paths>): boolean {
  let removed = false;
  for (const file of [p.legacyPlugin, p.legacyTuiFile, p.v1TuiFile]) {
    if (fs.exists(file)) { fs.remove(file); removed = true; }
  }
  const raw = fs.read(p.tuiJson);
  if (raw !== undefined) {
    try {
      const next = updateTuiConfig(updateTuiConfig(raw, p.legacyTuiFile, false), p.v1TuiFile, false);
      if (next !== raw) { fs.write(p.tuiJson, next); removed = true; }
    } catch {
      // A tui.json we cannot parse is left untouched.
    }
  }
  return removed;
}

export function install(options: InstallOptions & { tui: boolean }): InstallResult {
  const { fs, configDir, repoRoot } = options;
  const p = paths(configDir);
  const warnings: string[] = [];
  // The V2 loader requires a default `{ id, setup }` export.
  const loader = `export { default } from "${fileUrl(win32.join(repoRoot, "src", "opencode-v2.ts"))}";\n`;
  if (fs.read(p.plugin) !== loader) fs.write(p.plugin, loader);
  const result: InstallResult = { plugin: p.plugin, tui: false, warnings, removedLegacy: removeLegacy(fs, p) };
  if (!options.tui) return result;

  let tuiSource = options.tuiTemplate;
  for (const module of ["config", "repeat-ui", "rpc"])
    tuiSource = tuiSource.split(`"../src/${module}"`).join(`"${fileUrl(win32.join(repoRoot, "src", `${module}.ts`))}"`);
  try {
    // OpenCode's V2 migration copies tui.json entries into cli.json, including the V1 file path.
    const nextJson = updateCliConfig(updateCliConfig(fs.read(p.cliJson), p.v1TuiFile, false), tuiEntry(configDir), true);
    // Validate the config before touching anything else, so a failure leaves no half-installed TUI.
    if (fs.read(p.tuiFile) !== tuiSource) fs.write(p.tuiFile, tuiSource);
    if (fs.read(p.cliJson) !== nextJson) fs.write(p.cliJson, nextJson);
    result.tui = true;
    result.tuiFile = p.tuiFile;
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}

export function uninstall(options: Omit<InstallOptions, "repoRoot" | "tuiTemplate"> & Partial<InstallOptions>): void {
  const { fs, configDir } = options;
  const p = paths(configDir);
  removeLegacy(fs, p);
  if (fs.exists(p.plugin)) fs.remove(p.plugin);
  if (fs.exists(p.tuiFile)) fs.remove(p.tuiFile);
  const raw = fs.read(p.cliJson);
  if (raw !== undefined) {
    try {
      const next = updateCliConfig(raw, tuiEntry(configDir), false);
      if (next !== raw) fs.write(p.cliJson, next);
    } catch {
      // Leave a config we cannot parse untouched.
    }
  }
}

export function inspectInstall(options: Omit<InstallOptions, "repoRoot" | "tuiTemplate"> & Partial<InstallOptions>): InstallState {
  const { fs, configDir } = options;
  const p = paths(configDir);
  let tuiRegistered = false;
  try {
    const parsed = JSON.parse(fs.read(p.cliJson) ?? "{}");
    tuiRegistered = Array.isArray(parsed.plugins) && parsed.plugins.some((item: unknown) => entrySpec(item) === tuiEntry(configDir));
  } catch {}
  return { plugin: fs.exists(p.plugin), tuiFile: fs.exists(p.tuiFile), tuiRegistered };
}
