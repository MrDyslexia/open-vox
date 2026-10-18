import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG, KOKORO_VOICES, appHome, createConfigReader, kokoroLanguageCode, parseConfig, readConfig, writeConfig, writeRuntimeProfile,
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
  test("runtime profiles are fixed enums, CPU by default, and preserve unrelated settings", () => {
    for (const runtimeProfile of [undefined, "C:\\foreign\\python.exe", "CUDA13", {}, 1]) expect(parseConfig({ runtimeProfile }).runtimeProfile).toBe("cpu");
    const fs = memoryFs(JSON.stringify({ voices: { es: "ef_dora", en: "bm_george" }, speed: 1.2, narrationBackend: "onnx" }));
    writeConfig({ runtimeProfile: "cuda13" }, PATH, fs);
    expect(readConfig(PATH, fs)).toMatchObject({ runtimeProfile: "cuda13", speed: 1.2, narrationBackend: "onnx", voices: { es: "ef_dora", en: "bm_george" } });
    writeConfig({ speed: 1.3 }, PATH, fs);
    expect(readConfig(PATH, fs).runtimeProfile).toBe("cuda13");
  });
  test("narration language is explicit, validated and persisted with readback", () => {
    const fs = memoryFs();
    expect(parseConfig({}).narrationLanguage).toBe("es");
    expect(parseConfig({ narrationLanguage: "fr" }).narrationLanguage).toBe("es");
    writeConfig({ narrationLanguage: "en" }, PATH, fs);
    expect(readConfig(PATH, fs).narrationLanguage).toBe("en");
    expect(JSON.parse(fs.files.get(PATH)!).narrationLanguage).toBe("en");
  });
  test("defaults to Alex for Spanish, speed 1, auto engine, with no runtime flags", () => {
    expect(DEFAULT_CONFIG).toEqual({ voices: { es: "em_alex", en: "af_heart" }, toneVoice: { es: "", en: "" }, toneWeight: { es: 0, en: 0 }, speed: 1, engine: "auto", narrationLanguage: "es", narrationBackend: "torch", runtimeProfile: "cpu" });
    expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG);
  });
  test("narration backend defaults to torch, validates, persists, and old files without the key keep working", () => {
    expect(parseConfig({}).narrationBackend).toBe("torch");
    for (const bad of ["ONNX", "tensorrt", 1, null, true, ["onnx"]]) expect(parseConfig({ narrationBackend: bad }).narrationBackend).toBe("torch");
    expect(parseConfig({ narrationBackend: "onnx" }).narrationBackend).toBe("onnx");
    const fs = memoryFs(JSON.stringify({ speed: 1.1, narrationLanguage: "en" }));
    expect(readConfig(PATH, fs)).toEqual({ ...DEFAULT_CONFIG, speed: 1.1, narrationLanguage: "en" });
    writeConfig({ narrationBackend: "onnx" }, PATH, fs);
    expect(JSON.parse(fs.files.get(PATH)!).narrationBackend).toBe("onnx");
    expect(readConfig(PATH, fs)).toMatchObject({ narrationBackend: "onnx", speed: 1.1, narrationLanguage: "en" });
    writeConfig({ speed: 1.2 }, PATH, fs);
    expect(readConfig(PATH, fs).narrationBackend).toBe("onnx");
    writeConfig({ narrationBackend: "bogus" as never }, PATH, fs);
    expect(readConfig(PATH, fs).narrationBackend).toBe("torch");
  });
  test("accepts valid values", () => {
    expect(parseConfig({ voices: { es: "ef_dora", en: "bm_george" }, speed: 1.25, engine: "piper" }))
      .toEqual({ ...DEFAULT_CONFIG, voices: { es: "ef_dora", en: "bm_george" }, speed: 1.25, engine: "piper" });
  });
  test("rejects invalid values field by field, keeping valid ones", () => {
    const r = parseConfig({ voices: { es: "nope", en: "bm_george" }, speed: 99, engine: "weird" });
    expect(r).toEqual({ ...DEFAULT_CONFIG, voices: { es: "em_alex", en: "bm_george" } });
  });
  test("a legacy paused key loads without error and is ignored", () => {
    for (const paused of [true, false, "yes", null]) {
      const r = parseConfig({ paused, speed: 1.5 });
      expect(r).toEqual({ ...DEFAULT_CONFIG, speed: 1.5 });
      expect("paused" in r).toBe(false);
    }
  });
  test("a voice of the wrong language is rejected", () => {
    expect(parseConfig({ voices: { es: "af_heart", en: "em_alex" } }).voices).toEqual(DEFAULT_CONFIG.voices);
  });
  test("non-objects fall back to defaults", () => {
    for (const bad of [null, 1, "x", [], true]) expect(parseConfig(bad)).toEqual(DEFAULT_CONFIG);
  });
});

describe("readConfig / writeConfig", () => {
  test("profile activation patches only the raw profile field, including unknown settings, and preserves invalid files", () => {
    const original = { custom: { retain: true }, speed: 1.3, narrationBackend: "onnx", voices: { en: "bm_george" } };
    const fs = memoryFs(JSON.stringify(original));
    writeRuntimeProfile("cuda13", PATH, fs);
    expect(JSON.parse(fs.files.get(PATH)!)).toEqual({ ...original, runtimeProfile: "cuda13" });
    fs.files.set(PATH, "invalid");
    expect(() => writeRuntimeProfile("cuda13", PATH, fs)).toThrow(); expect(fs.files.get(PATH)).toBe("invalid");
  });
  test("tone records round-trip and merge per language without weakening identity validation", () => {
    const fs = memoryFs();
    writeConfig({ toneVoice: { es: "am_onyx" }, toneWeight: { es: 0.75 } }, PATH, fs);
    writeConfig({ toneVoice: { en: "em_alex" }, toneWeight: { en: 1 }, voices: { es: "am_onyx" } }, PATH, fs);
    expect(readConfig(PATH, fs)).toMatchObject({
      toneVoice: { es: "am_onyx", en: "em_alex" }, toneWeight: { es: 0.75, en: 1 }, voices: DEFAULT_CONFIG.voices,
    });
    writeConfig({ speed: 1.2 }, PATH, fs);
    expect(JSON.parse(fs.files.get(PATH)!)).toEqual(readConfig(PATH, fs));
    writeConfig({ toneVoice: { es: "" }, toneWeight: { es: 0 } }, PATH, fs);
    expect(readConfig(PATH, fs)).toMatchObject({ toneVoice: { es: "", en: "em_alex" }, toneWeight: { es: 0, en: 1 } });
  });
  test("invalid tone patches preserve stored settings and never persist rejected values", () => {
    const fs = memoryFs();
    writeConfig({ toneVoice: { es: "am_onyx" }, toneWeight: { es: 0.75 } }, PATH, fs);
    for (const bad of [-0.1, 1.1, NaN, Infinity, -Infinity, "0.5", null, true]) {
      const next = writeConfig({ toneVoice: { es: "unknown" }, toneWeight: { es: bad as never } }, PATH, fs);
      expect(next.toneVoice.es).toBe("am_onyx");
      expect(next.toneWeight.es).toBe(0.75);
      expect(JSON.parse(fs.files.get(PATH)!)).toEqual(next);
    }
  });
  test("tone parsing uses off defaults, finite inclusive weights and a cross-language donor catalog", () => {
    expect(parseConfig({ toneVoice: { es: "am_onyx", en: "em_alex" }, toneWeight: { es: 0, en: 1 } }))
      .toMatchObject({ toneVoice: { es: "am_onyx", en: "em_alex" }, toneWeight: { es: 0, en: 1 } });
    for (const bad of [null, [], true, "am_onyx", { es: "unknown", en: 42 }]) {
      expect(parseConfig({ toneVoice: bad }).toneVoice).toEqual({ es: "", en: "" });
    }
    for (const bad of [-1, 2, NaN, Infinity, "0.75", null, true]) {
      expect(parseConfig({ toneWeight: { es: bad } }).toneWeight).toEqual({ es: 0, en: 0 });
    }
  });
  test("missing or corrupt files yield defaults", () => {
    expect(readConfig(PATH, memoryFs())).toEqual(DEFAULT_CONFIG);
    expect(readConfig(PATH, memoryFs("{not json"))).toEqual(DEFAULT_CONFIG);
  });
  test("write merges a patch and persists JSON", () => {
    const fs = memoryFs(JSON.stringify({ speed: 1.1 }));
    const next = writeConfig({ engine: "piper" }, PATH, fs);
    expect(next).toEqual({ ...DEFAULT_CONFIG, engine: "piper", speed: 1.1 });
    expect(JSON.parse(fs.files.get(PATH)!)).toEqual(next);
  });
  test("a legacy file with paused is read without it and the key is dropped on the next write", () => {
    const fs = memoryFs(JSON.stringify({ paused: true, speed: 1.1 }));
    expect(readConfig(PATH, fs)).toEqual({ ...DEFAULT_CONFIG, speed: 1.1 });
    writeConfig({ engine: "sapi" }, PATH, fs);
    expect(JSON.parse(fs.files.get(PATH)!)).toEqual({ ...DEFAULT_CONFIG, speed: 1.1, engine: "sapi" });
    expect(fs.files.get(PATH)).not.toContain("paused");
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
  test("bundled Spanish voice is selectable and phonemized as Spanish", () => {
    expect(KOKORO_VOICES.find((v) => v.id === "em_blocktype")).toMatchObject({ language: "es", gender: "male", label: "Blocktype" });
    expect(parseConfig({ voices: { es: "em_blocktype" } }).voices.es).toBe("em_blocktype");
    expect(parseConfig({ voices: { en: "em_blocktype" } }).voices.en).toBe("af_heart");
    expect(kokoroLanguageCode("em_blocktype")).toBe("es");
  });
  test("language code follows the voice accent", () => {
    expect(kokoroLanguageCode("em_alex")).toBe("es");
    expect(kokoroLanguageCode("af_heart")).toBe("en-us");
    expect(kokoroLanguageCode("bm_george")).toBe("en-gb");
    expect(kokoroLanguageCode("bf_emma")).toBe("en-gb");
  });
});

describe("appHome", () => {
  test("prefers OPEN_VOX_HOME, then the legacy variable, then LOCALAPPDATA", () => {
    expect(appHome({ OPEN_VOX_HOME: "D:\\x", AGENTVOZ_HOME: "D:\\old", LOCALAPPDATA: "C:\\L" })).toBe("D:\\x");
    expect(appHome({ AGENTVOZ_HOME: "D:\\old", LOCALAPPDATA: "C:\\L" })).toBe("D:\\old");
    expect(appHome({ LOCALAPPDATA: "C:\\L" })).toBe("C:\\L\\open-vox");
  });
});
