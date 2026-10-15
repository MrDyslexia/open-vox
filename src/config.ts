import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";
import { homeFor } from "./brand";
import type { Language } from "./speech-text";

export type EngineName = "auto" | "kokoro" | "piper" | "sapi";
/** Contextual language-detector backend. `torch` is the default; `onnx` is explicit opt-in. */
export type NarrationBackend = "torch" | "onnx";
/** Shared persisted defaults only. Runtime controls such as pause live in memory, per plugin instance. */
export type Config = {
  narrationLanguage: Language;
  voices: Record<Language, string>;
  speed: number;
  engine: EngineName;
  narrationBackend: NarrationBackend;
};
export type ConfigPatch = {
  narrationLanguage?: Language;
  voices?: Partial<Record<Language, string>>;
  speed?: number;
  engine?: EngineName;
  narrationBackend?: NarrationBackend;
};
export type ConfigFs = {
  read: (path: string) => string;
  writeAtomic: (path: string, data: string) => void;
};

export type KokoroVoice = { id: string; language: Language; label: string; gender: "female" | "male"; accent: string };

const voice = (id: string, language: Language, gender: "female" | "male", accent: string): KokoroVoice => ({
  id, language, gender, accent, label: id.slice(3).replace(/^./, (c) => c.toUpperCase()),
});

/** Voices shipped in Kokoro v1.0 for the two supported languages. */
export const KOKORO_VOICES: readonly KokoroVoice[] = [
  voice("em_alex", "es", "male", "Spanish"),
  voice("em_santa", "es", "male", "Spanish"),
  voice("ef_dora", "es", "female", "Spanish"),
  // Bundled custom voice: not part of Kokoro. Its style lives in resources/voices/em_blocktype.npy and
  // `open-vox setup kokoro` merges it into voices-v1.0.bin; without that step the engine cannot play it.
  voice("em_blocktype", "es", "male", "Spanish"),
  ...["heart", "bella", "nicole", "sarah", "sky", "alloy", "aoede", "jessica", "kore", "nova", "river"]
    .map((n) => voice(`af_${n}`, "en", "female", "American")),
  ...["adam", "michael", "echo", "eric", "fenrir", "liam", "onyx", "puck", "santa"]
    .map((n) => voice(`am_${n}`, "en", "male", "American")),
  ...["emma", "alice", "isabella", "lily"].map((n) => voice(`bf_${n}`, "en", "female", "British")),
  ...["george", "daniel", "fable", "lewis"].map((n) => voice(`bm_${n}`, "en", "male", "British")),
];

export const DEFAULT_CONFIG: Config = {
  narrationLanguage: "es",
  voices: { es: "em_alex", en: "af_heart" },
  speed: 1,
  engine: "auto",
  narrationBackend: "torch",
};

const ENGINES: readonly EngineName[] = ["auto", "kokoro", "piper", "sapi"];
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

const validVoice = (id: unknown, language: Language): id is string =>
  typeof id === "string" && KOKORO_VOICES.some((v) => v.id === id && v.language === language);
const validSpeed = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= MIN_SPEED && value <= MAX_SPEED;

/**
 * Tolerant parser: invalid fields fall back to defaults individually. Unknown keys, including
 * the legacy `paused` flag from older files, are ignored and therefore dropped on the next write.
 */
export function parseConfig(raw: unknown): Config {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const voices = input.voices && typeof input.voices === "object" ? (input.voices as Record<string, unknown>) : {};
  return {
    narrationLanguage: input.narrationLanguage === "en" ? "en" : "es",
    voices: {
      es: validVoice(voices.es, "es") ? voices.es : DEFAULT_CONFIG.voices.es,
      en: validVoice(voices.en, "en") ? voices.en : DEFAULT_CONFIG.voices.en,
    },
    speed: validSpeed(input.speed) ? input.speed : DEFAULT_CONFIG.speed,
    engine: ENGINES.includes(input.engine as EngineName) ? (input.engine as EngineName) : DEFAULT_CONFIG.engine,
    narrationBackend: input.narrationBackend === "onnx" ? "onnx" : "torch",
  };
}

export function appHome(env: Record<string, string | undefined> = process.env): string {
  return homeFor(env);
}
export const configPath = (env: Record<string, string | undefined> = process.env) => win32.join(appHome(env), "config.json");

export const nodeConfigFs: ConfigFs = {
  read: (path) => readFileSync(path, "utf8"),
  writeAtomic: (path, data) => {
    mkdirSync(win32.dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, path);
  },
};

export function readConfig(path: string = configPath(), fs: ConfigFs = nodeConfigFs): Config {
  try { return parseConfig(JSON.parse(fs.read(path))); } catch { return DEFAULT_CONFIG; }
}

/** Merges a patch into the stored config. Invalid patch values are dropped, never persisted. */
export function writeConfig(patch: ConfigPatch, path: string = configPath(), fs: ConfigFs = nodeConfigFs): Config {
  const current = readConfig(path, fs);
  const next = parseConfig({
    ...current,
    ...patch,
    voices: { ...current.voices, ...(patch.voices ?? {}) },
  });
  fs.writeAtomic(path, JSON.stringify(next, null, 2) + "\n");
  return next;
}

export type ConfigReader = (() => Config) & { invalidate(): void };

/** Cached reader so hot paths (every host event) do not hit the disk each time. */
export function createConfigReader(
  read: () => Config = () => readConfig(),
  ttlMs = 400,
  now: () => number = Date.now,
): ConfigReader {
  let cached: Config | undefined;
  let at = -Infinity;
  const reader = (() => {
    const t = now();
    if (!cached || t - at >= ttlMs) { cached = read(); at = t; }
    return cached;
  }) as ConfigReader;
  reader.invalidate = () => { cached = undefined; };
  return reader;
}

/** Kokoro phonemizer language for a voice: Spanish, British or American English. */
export function kokoroLanguageCode(voiceId: string): "es" | "en-us" | "en-gb" {
  if (voiceId.startsWith("e")) return "es";
  return voiceId.startsWith("b") ? "en-gb" : "en-us";
}

