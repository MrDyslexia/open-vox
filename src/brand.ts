import { win32 } from "node:path";

export const NAME = "open-vox";
export const ENV_PREFIX = "OPEN_VOX_";
export const HOME_DIR = "open-vox";

/** Names used before the rename. Kept so existing installs keep working and can be migrated. */
export const LEGACY = {
  name: "agentvoz",
  envPrefix: "AGENTVOZ_",
  homeDir: "agentVoz",
  tuiId: "agentvoz",
  pluginFile: "agentvoz.js",
  tuiFile: "agentvoz.tsx",
} as const;

type Env = Record<string, string | undefined>;

/** Reads `OPEN_VOX_<key>`, falling back to the legacy `AGENTVOZ_<key>`. Blank values count as unset. */
export function envValue(env: Env, key: string): string | undefined {
  for (const prefix of [ENV_PREFIX, LEGACY.envPrefix]) {
    const value = env[prefix + key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function homeFor(env: Env = process.env): string {
  return envValue(env, "HOME") ?? win32.join(env.LOCALAPPDATA ?? "", HOME_DIR);
}

/**
 * Plans moving the pre-rename data folder (models, venv, settings) to its new place.
 * Only applies to the default location: a custom home is never touched.
 */
export function legacyHomeMigration(
  env: Env,
  exists: (path: string) => boolean,
): { from: string; to: string } | undefined {
  if (envValue(env, "HOME")) return undefined;
  const base = env.LOCALAPPDATA ?? "";
  const from = win32.join(base, LEGACY.homeDir);
  const to = win32.join(base, HOME_DIR);
  return exists(from) && !exists(to) ? { from, to } : undefined;
}
