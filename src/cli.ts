#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KOKORO_VOICES, MAX_SPEED, MIN_SPEED, appHome, configPath, readConfig, writeConfig,
  type Config, type ConfigPatch, type EngineName,
} from "./config";
import { envValue, legacyHomeMigration } from "./brand";
import { inspectInstall, install, uninstall, type InstallFs } from "./installer";
import { resolveKokoro } from "./kokoro-engine";
import { resolvePiper } from "./piper-engine";
import { nodeDownload, nodeRun, nodeNarrationDownload, nodeNarrationFs, nodeNarrationRun, narrationProbeArgs, setupKokoro, setupNarration, setupPiper } from "./setup";
import { assertLidDirectory, fileFingerprint, inspectNarration, type NarrationReadiness } from "./narration-assets";

export type CliDeps = {
  out: (line: string) => void;
  err: (line: string) => void;
  readConfig: () => Config;
  writeConfig: (patch: ConfigPatch) => Config;
  configPath: string;
  installFs: InstallFs;
  configDir: string;
  repoRoot: string;
  tuiTemplate: string | (() => string);
  exists: (path: string) => boolean;
  env: Record<string, string | undefined>;
  platform?: string;
  say: (text: string) => Promise<void>;
  /** Moves the pre-rename data folder to its new location, when applicable. Throws on failure. */
  migrateHome: () => { from: string; to: string } | undefined;
  setup: (what: "kokoro" | "piper" | "narration") => Promise<void>;
  narrationStatus?: (home: string) => Promise<NarrationReadiness>;
};

const ENGINES: readonly EngineName[] = ["auto", "kokoro", "piper", "sapi"];

export const HELP = `Usage: open-vox <command>

Setup
  install [--no-tui] [--config-dir <dir>]   Register the plugin (and the sidebar block) in OpenCode
  uninstall [--config-dir <dir>]            Remove the plugin and the sidebar block
  setup kokoro|piper                        Download a local neural voice engine
  setup narration                           Explicit pinned local LID + isolated CPU environment (~2 GB estimate)
  doctor                                    Check the installation
  status                                    Show current settings

Controls (apply immediately, no restart)
  voice [<id>] | voice es|en <id>           Show or change the voice (see "voices")
  voices                                    List available voices
  speed <0.5-2>                             Speaking speed
  engine auto|kokoro|piper|sapi             Speech engine
  language es|en                           Narration base language (one voice per utterance)
  say <text>                                Speak a test sentence
  config path|show|reset                    Inspect or reset the settings file
`;

const usage = (deps: CliDeps, message: string): number => { deps.err(message); return 2; };

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function listVoices(deps: CliDeps): void {
  const config = deps.readConfig();
  for (const language of ["es", "en"] as const) {
    deps.out(language === "es" ? "Spanish" : "English");
    for (const v of KOKORO_VOICES.filter((x) => x.language === language)) {
      const mark = config.voices[language] === v.id ? "*" : " ";
      deps.out(` ${mark} ${v.id.padEnd(12)} ${v.label.padEnd(10)} ${v.gender}, ${v.accent}`);
    }
  }
  deps.out("(* = current)");
}

function check(label: string, level: "OK" | "WARN" | "FAIL", detail: string) {
  return { label, level, detail };
}

async function doctor(deps: CliDeps): Promise<number> {
  const home = appHome(deps.env);
  const platform = deps.platform ?? process.platform;
  const state = inspectInstall({ fs: deps.installFs, configDir: deps.configDir });
  const kokoro = resolveKokoro(home, deps.env, deps.exists);
  const piper = resolvePiper(home, deps.env, deps.exists);
  const narration = await deps.narrationStatus?.(home) ?? { ready: false, code: "missing-managed-environment" };
  const results = [
    check("Platform", platform === "win32" ? "OK" : "FAIL", platform === "win32" ? "Windows" : `${platform} is not supported (Windows only)`),
    check("OpenCode config", deps.exists(deps.configDir) ? "OK" : "FAIL", deps.configDir),
    check("Server plugin", state.plugin ? "OK" : "FAIL", state.plugin ? "installed" : "missing; run: open-vox install"),
    check("Sidebar block", state.tuiFile && state.tuiRegistered ? "OK" : "WARN", state.tuiFile && state.tuiRegistered ? "installed" : "not installed; run: open-vox install"),
    check("Kokoro engine", kokoro ? "OK" : "WARN", kokoro ? "ready" : "not set up; run: open-vox setup kokoro"),
    check("Contextual narration", narration.ready && kokoro ? "OK" : "WARN",
      narration.ready && kokoro ? "verified local assets/dependencies (not listening certification)" : `degraded: ${kokoro ? narration.code : "missing-kokoro-assets"}; dictionary/base fallback only; run: open-vox setup narration`),
    check("Piper engine", piper ? "OK" : "WARN", piper ? "ready" : "not set up (optional); run: open-vox setup piper"),
    check("Windows voices (SAPI)", platform === "win32" ? "OK" : "WARN", "built in, used as the last fallback"),
  ];
  for (const r of results) deps.out(`${r.level.padEnd(4)} ${r.label}: ${r.detail}`);
  return results.some((r) => r.level === "FAIL") ? 1 : 0;
}

function status(deps: CliDeps): void {
  const config = deps.readConfig();
  const state = inspectInstall({ fs: deps.installFs, configDir: deps.configDir });
  deps.out(`voices: es: ${config.voices.es}, en: ${config.voices.en}`);
  deps.out(`speed: ${config.speed}`);
  deps.out(`engine: ${config.engine}`);
  deps.out(`narration language: ${config.narrationLanguage}`);
  deps.out(`plugin: ${state.plugin ? "installed" : "not installed"}`);
  deps.out(`sidebar block: ${state.tuiFile && state.tuiRegistered ? "installed" : "not installed"}`);
  deps.out(`config file: ${deps.configPath}`);
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      deps.out(HELP.trimEnd());
      return 0;

    case "voices":
      listVoices(deps);
      return 0;
    case "voice": {
      if (args.length === 0) {
        const c = deps.readConfig();
        deps.out(`es: ${c.voices.es}`);
        deps.out(`en: ${c.voices.en}`);
        return 0;
      }
      const forced = args.length >= 2 && (args[0] === "es" || args[0] === "en") ? (args[0] as "es" | "en") : undefined;
      const id = forced ? args[1]! : args[0]!;
      const found = KOKORO_VOICES.find((v) => v.id === id && (!forced || v.language === forced));
      if (!found) return usage(deps, `Unknown voice "${id}"${forced ? ` for ${forced}` : ""}. Run "open-vox voices" to list them.`);
      deps.writeConfig({ voices: { [found.language]: found.id } });
      deps.out(`${found.language === "es" ? "Spanish" : "English"} voice set to ${found.label} (${found.id}).`);
      return 0;
    }

    case "speed": {
      const value = Number(args[0]);
      if (args[0] === undefined || !Number.isFinite(value) || value < MIN_SPEED || value > MAX_SPEED) {
        return usage(deps, `Speed must be a number between ${MIN_SPEED} and ${MAX_SPEED}.`);
      }
      deps.writeConfig({ speed: value });
      deps.out(`Speed set to ${value}.`);
      return 0;
    }
    case "language": {
      const language = args[0];
      if (args.length !== 1 || (language !== "es" && language !== "en")) return usage(deps, "Usage: open-vox language es|en");
      deps.writeConfig({ narrationLanguage: language });
      deps.out(`Narration language set to ${language}.`);
      return 0;
    }
    case "engine": {
      const name = args[0] as EngineName | undefined;
      if (!name || !ENGINES.includes(name)) return usage(deps, `Engine must be one of: ${ENGINES.join(", ")}.`);
      deps.writeConfig({ engine: name });
      deps.out(`Engine set to ${name}.`);
      return 0;
    }

    case "say": {
      const text = args.join(" ").trim();
      if (!text) return usage(deps, 'Usage: open-vox say "text to speak"');
      await deps.say(text);
      return 0;
    }

    case "install": {
      const configDir = flag(args, "--config-dir") ?? deps.configDir;
      const template = typeof deps.tuiTemplate === "function" ? deps.tuiTemplate() : deps.tuiTemplate;
      const wantTui = !args.includes("--no-tui");
      try {
        const moved = deps.migrateHome();
        if (moved) deps.out(`Moved your data (settings, models, voices) from ${moved.from} to ${moved.to}.`);
      } catch (error) {
        deps.err(`Warning: could not move the old data folder: ${error instanceof Error ? error.message : String(error)}`);
      }
      const result = install({ fs: deps.installFs, configDir, repoRoot: deps.repoRoot, tuiTemplate: template, tui: wantTui });
      if (result.removedLegacy) deps.out("Removed the old agentvoz plugin files.");
      deps.out(`Installed plugin: ${result.plugin}`);
      if (wantTui) deps.out(result.tui ? `Installed sidebar block: ${result.tuiFile}` : "Sidebar block NOT installed.");
      for (const warning of result.warnings) deps.err(`Warning: ${warning}`);
      deps.out("Restart OpenCode to load the changes.");
      return wantTui && !result.tui ? 1 : 0;
    }
    case "uninstall": {
      const configDir = flag(args, "--config-dir") ?? deps.configDir;
      uninstall({ fs: deps.installFs, configDir });
      deps.out("Removed the plugin and the sidebar block. Your settings and downloaded voices were kept.");
      deps.out("Restart OpenCode to unload them.");
      return 0;
    }

    case "setup": {
      const what = args[0];
      if (args.length !== 1 || (what !== "kokoro" && what !== "piper" && what !== "narration")) return usage(deps, "Usage: open-vox setup kokoro|piper|narration");
      await deps.setup(what);
      return 0;
    }

    case "doctor":
      return doctor(deps);
    case "status":
      status(deps);
      return 0;

    case "config": {
      const sub = args[0];
      if (sub === "path") { deps.out(deps.configPath); return 0; }
      if (sub === "show") { deps.out(JSON.stringify(deps.readConfig(), null, 2)); return 0; }
      if (sub === "reset") {
        deps.writeConfig({ voices: { es: "em_alex", en: "af_heart" }, speed: 1, engine: "auto", narrationLanguage: "es" });
        deps.out("Settings reset to defaults.");
        return 0;
      }
      return usage(deps, "Usage: open-vox config path|show|reset");
    }

    default:
      return usage(deps, `Unknown command "${command}". Run "open-vox help".`);
  }
}

const nodeInstallFs: InstallFs = {
  read: (path) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } },
  write: (path, data) => { mkdirSync(win32.dirname(path), { recursive: true }); writeFileSync(path, data, "utf8"); },
  remove: (path) => { rmSync(path, { force: true }); },
  exists: (path) => existsSync(path),
};

export async function main(argv: string[]): Promise<number> {
  const env = process.env;
  const repoRoot = win32.normalize(fileURLToPath(new URL("..", import.meta.url))).replace(/[\\/]+$/, "");
  const deps: CliDeps = {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    readConfig: () => readConfig(),
    writeConfig: (patch) => writeConfig(patch),
    configPath: configPath(env),
    installFs: nodeInstallFs,
    configDir: env.OPENCODE_CONFIG_DIR?.trim() || win32.join(homedir(), ".config", "opencode"),
    repoRoot,
    tuiTemplate: () => readFileSync(win32.join(repoRoot, "tui", "open-vox.tsx"), "utf8"),
    exists: (path) => existsSync(path),
    env,
    narrationStatus: home => inspectNarration(home, {
      exists: existsSync, read: path => readFileSync(path, "utf8"), fingerprint: fileFingerprint,
      validateDirectory: assertLidDirectory,
      probe: (python, expectedVenv) => nodeNarrationRun(python, narrationProbeArgs(expectedVenv)),
    }),
    migrateHome: () => {
      const plan = legacyHomeMigration(env, existsSync);
      if (plan) renameSync(plan.from, plan.to);
      return plan;
    },
    say: async (text) => {
      const { speakOnce } = await import("./plugin");
      await speakOnce(text);
    },
    setup: async (what) => {
      const setupDeps = {
        home: appHome(env), systemPython: envValue(env, "PYTHON") || "python",
        exists: (path: string) => existsSync(path), run: nodeRun, download: nodeDownload,
        log: (line: string) => console.log(line),
      };
      if (what === "narration") await setupNarration({ ...setupDeps, ...nodeNarrationFs, run: nodeNarrationRun, download: nodeNarrationDownload });
      else await (what === "kokoro" ? setupKokoro(setupDeps) : setupPiper(setupDeps));
    },
  };
  try {
    return await runCli(argv, deps);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
