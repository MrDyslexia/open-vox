import { win32 } from "node:path";

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
  /** Source of the TUI plugin; its `"../src/config"` import is rewritten to an absolute URL. */
  tuiTemplate: string;
};
export type InstallResult = { plugin: string; tui: boolean; tuiFile?: string; warnings: string[] };
export type InstallState = { plugin: boolean; tuiFile: boolean; tuiRegistered: boolean };

export const paths = (configDir: string) => ({
  plugin: win32.join(configDir, "plugins", "agentvoz.js"),
  tuiFile: win32.join(configDir, "tui-plugins", "agentvoz.tsx"),
  tuiJson: win32.join(configDir, "tui.json"),
});

const fileUrl = (absolutePath: string) => "file:///" + encodeURI(absolutePath.replace(/\\/g, "/"));

type TuiEntry = string | [string, unknown];
const entrySpec = (entry: unknown): string | undefined =>
  typeof entry === "string" ? entry : Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : undefined;

/** Adds or removes one plugin entry in tui.json, preserving everything else. Throws on unparsable input. */
export function updateTuiConfig(raw: string | undefined, entry: string, add: boolean): string {
  let config: Record<string, unknown>;
  if (raw === undefined) {
    config = { $schema: "https://opencode.ai/tui.json" };
  } else {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      config = parsed as Record<string, unknown>;
    } catch {
      throw new Error("tui.json is not plain JSON (comments or syntax errors); add the plugin entry manually");
    }
  }
  const current: TuiEntry[] = Array.isArray(config.plugin) ? (config.plugin as TuiEntry[]) : [];
  const without = current.filter((item) => entrySpec(item) !== entry);
  const plugin = add ? [...without, entry] : without;
  const next: Record<string, unknown> = { ...config };
  if (plugin.length > 0 || "plugin" in config) next.plugin = plugin;
  return JSON.stringify(next, null, 2) + "\n";
}

export function install(options: InstallOptions & { tui: boolean }): InstallResult {
  const { fs, configDir, repoRoot } = options;
  const p = paths(configDir);
  const warnings: string[] = [];
  const loader = `export { AgentVozPlugin } from "${fileUrl(win32.join(repoRoot, "src", "index.ts"))}";\n`;
  if (fs.read(p.plugin) !== loader) fs.write(p.plugin, loader);
  const result: InstallResult = { plugin: p.plugin, tui: false, warnings };
  if (!options.tui) return result;

  const configUrl = fileUrl(win32.join(repoRoot, "src", "config.ts"));
  const tuiSource = options.tuiTemplate.split('"../src/config"').join(`"${configUrl}"`);
  try {
    const nextJson = updateTuiConfig(fs.read(p.tuiJson), p.tuiFile, true);
    // Validate the config before touching anything else, so a failure leaves no half-installed TUI.
    if (fs.read(p.tuiFile) !== tuiSource) fs.write(p.tuiFile, tuiSource);
    if (fs.read(p.tuiJson) !== nextJson) fs.write(p.tuiJson, nextJson);
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
  if (fs.exists(p.plugin)) fs.remove(p.plugin);
  if (fs.exists(p.tuiFile)) fs.remove(p.tuiFile);
  const raw = fs.read(p.tuiJson);
  if (raw !== undefined) {
    try {
      const next = updateTuiConfig(raw, p.tuiFile, false);
      if (next !== raw) fs.write(p.tuiJson, next);
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
    const parsed = JSON.parse(fs.read(p.tuiJson) ?? "{}");
    tuiRegistered = Array.isArray(parsed.plugin) && parsed.plugin.some((item: unknown) => entrySpec(item) === p.tuiFile);
  } catch {}
  return { plugin: fs.exists(p.plugin), tuiFile: fs.exists(p.tuiFile), tuiRegistered };
}
