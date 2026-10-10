import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG, KOKORO_VOICES, appHome, createConfigReader, kokoroLanguageCode, parseConfig, readConfig, writeConfig,
  type ConfigFs,
} from "../src/config";

function memoryFs(initial?: string): ConfigFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set("C:\\h\\config.json", initial);
  return {
    files,
    read: (path) => { const v = files.get(path); if (v === undefined) throw new Error("ENOENT"); return v; },
    writeAtomic: (path, data) => { files.set(path, data); },
  };
}
const PATH = "C:\\h\\config.json";

describe("parseConfig", () => {
  test("defaults to Alex for Spanish, unpaused, speed 1, auto engine", () => {
    expect(DEFAULT_CONFIG).toEqual({ paused: false, voices: { es: "em_alex", en: "af_heart" }, speed: 1, engine: "auto" });
    expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG);
  });
  test("accepts valid values", () => {
    expect(parseConfig({ paused: true, voices: { es: "ef_dora", en: "bm_george" }, speed: 1.25, engine: "piper" }))
      .toEqual({ paused: true, voices: { es: "ef_dora", en: "bm_george" }, speed: 1.25, engine: "piper" });
  });
  test("rejects invalid values field by field, keeping valid ones", () => {
    const r = parseConfig({ paused: "yes", voices: { es: "nope", en: "bm_george" }, speed: 99, engine: "weird" });
    expect(r).toEqual({ ...DEFAULT_CONFIG, voices: { es: "em_alex", en: "bm_george" } });
  });
  test("a voice of the wrong language is rejected", () => {
    expect(parseConfig({ voices: { es: "af_heart", en: "em_alex" } }).voices).toEqual(DEFAULT_CONFIG.voices);
  });
  test("non-objects fall back to defaults", () => {
    for (const bad of [null, 1, "x", [], true]) expect(parseConfig(bad)).toEqual(DEFAULT_CONFIG);
  });
});

describe("readConfig / writeConfig", () => {
  test("missing or corrupt files yield defaults", () => {
    expect(readConfig(PATH, memoryFs())).toEqual(DEFAULT_CONFIG);
    expect(readConfig(PATH, memoryFs("{not json"))).toEqual(DEFAULT_CONFIG);
  });
  test("write merges a patch and persists JSON", () => {
    const fs = memoryFs(JSON.stringify({ speed: 1.1 }));
    const next = writeConfig({ paused: true }, PATH, fs);
    expect(next).toEqual({ ...DEFAULT_CONFIG, paused: true, speed: 1.1 });
    expect(JSON.parse(fs.files.get(PATH)!)).toEqual(next);
  });
  test("write merges nested voices without dropping the other language", () => {
    const fs = memoryFs();
    const next = writeConfig({ voices: { es: "em_santa" } }, PATH, fs);
    expect(next.voices).toEqual({ es: "em_santa", en: "af_heart" });
  });
  test("an invalid patch value is ignored rather than persisted", () => {
    const fs = memoryFs();
    expect(writeConfig({ speed: 50 }, PATH, fs).speed).toBe(1);
  });
});

describe("createConfigReader", () => {
  test("caches within the ttl and refreshes after it", () => {
    let now = 0;
    let reads = 0;
    const reader = createConfigReader(() => { reads++; return { ...DEFAULT_CONFIG, speed: reads }; }, 500, () => now);
    expect(reader().speed).toBe(1);
    now = 100;
    expect(reader().speed).toBe(1);
    now = 600;
    expect(reader().speed).toBe(2);
  });
  test("invalidate forces a fresh read", () => {
    let reads = 0;
    const reader = createConfigReader(() => { reads++; return DEFAULT_CONFIG; }, 10_000, () => 0);
    reader();
    reader.invalidate();
    reader();
    expect(reads).toBe(2);
  });
});

describe("voices", () => {
  test("catalog covers Spanish and English with labels", () => {
    const es = KOKORO_VOICES.filter((v) => v.language === "es").map((v) => v.id);
    expect(es).toEqual(expect.arrayContaining(["em_alex", "em_santa", "ef_dora"]));
    expect(KOKORO_VOICES.find((v) => v.id === "bm_george")?.label).toBe("George");
  });
  test("language code follows the voice accent", () => {
    expect(kokoroLanguageCode("em_alex")).toBe("es");
    expect(kokoroLanguageCode("af_heart")).toBe("en-us");
    expect(kokoroLanguageCode("bm_george")).toBe("en-gb");
    expect(kokoroLanguageCode("bf_emma")).toBe("en-gb");
  });
});

describe("appHome", () => {
  test("prefers AGENTVOZ_HOME, then LOCALAPPDATA", () => {
    expect(appHome({ AGENTVOZ_HOME: "D:\\x", LOCALAPPDATA: "C:\\L" })).toBe("D:\\x");
    expect(appHome({ LOCALAPPDATA: "C:\\L" })).toBe("C:\\L\\agentVoz");
  });
});
