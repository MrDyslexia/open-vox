import { describe, expect, test } from "bun:test";
import { LEGACY, NAME, envValue, legacyHomeMigration } from "../src/brand";

describe("brand", () => {
  test("names", () => {
    expect(NAME).toBe("open-vox");
    expect(LEGACY.name).toBe("agentvoz");
  });
});

describe("envValue", () => {
  test("prefers the new OPEN_VOX_ variable", () => {
    expect(envValue({ OPEN_VOX_SPEED: "1.2", AGENTVOZ_SPEED: "1.5" }, "SPEED")).toBe("1.2");
  });
  test("falls back to the legacy AGENTVOZ_ variable", () => {
    expect(envValue({ AGENTVOZ_SPEED: "1.5" }, "SPEED")).toBe("1.5");
  });
  test("ignores blank values and trims", () => {
    expect(envValue({ OPEN_VOX_SPEED: "  ", AGENTVOZ_SPEED: " 1.5 " }, "SPEED")).toBe("1.5");
    expect(envValue({}, "SPEED")).toBeUndefined();
  });
});

describe("legacyHomeMigration", () => {
  const env = { LOCALAPPDATA: "C:\\L" };
  test("plans a move when only the legacy folder exists", () => {
    const present = new Set(["C:\\L\\agentVoz"]);
    expect(legacyHomeMigration(env, (p) => present.has(p))).toEqual({ from: "C:\\L\\agentVoz", to: "C:\\L\\open-vox" });
  });
  test("does nothing when the new folder already exists", () => {
    const present = new Set(["C:\\L\\agentVoz", "C:\\L\\open-vox"]);
    expect(legacyHomeMigration(env, (p) => present.has(p))).toBeUndefined();
  });
  test("does nothing when there is no legacy folder", () => {
    expect(legacyHomeMigration(env, () => false)).toBeUndefined();
  });
  test("does nothing when a custom home is configured", () => {
    expect(legacyHomeMigration({ ...env, OPEN_VOX_HOME: "D:\\x" }, () => true)).toBeUndefined();
    expect(legacyHomeMigration({ ...env, AGENTVOZ_HOME: "D:\\x" }, () => true)).toBeUndefined();
  });
});
