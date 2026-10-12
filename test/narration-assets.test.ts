import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LID_MANIFEST, LID_BYTES, assertLidDirectory, fileFingerprint, inspectNarration, lidDownloadUrl, narrationPaths, PN_READY_RECORD, resolveNarrationPython, validateLidManifest } from "../src/narration-assets";

test("bundled manifest pins the minimal safetensors-only set and precise forecast", () => {
  expect(LID_BYTES).toBe(712465856);
  expect(LID_MANIFEST.files.find(f => f.filename === "model.safetensors")!.bytes).toBe(711469178);
  expect(narrationPaths("C:\\owned").model).toBe(`C:\\owned\\lid\\codeswitch-spaeng-lid-lince\\${LID_MANIFEST.revision}`);
  expect(lidDownloadUrl(LID_MANIFEST.files[0]!)).toContain(`/resolve/${LID_MANIFEST.revision}/config.json`);
});
test("strict manifest rejects traversal, unsafe URLs, pickle, wrong revision and malformed hashes", () => {
  for (const change of [
    (m: any) => { m.files[0].filename = "../config.json"; },
    (m: any) => { m.files[0].filename = "C:\\config.json"; },
    (m: any) => { m.files[0].url = "http://evil.test"; },
    (m: any) => { m.files[1].filename = "pytorch_model.bin"; },
    (m: any) => { m.revision = "main"; },
    (m: any) => { m.modelId = "other/model"; },
    (m: any) => { m.files[0].sha256 = "a".repeat(63); },
    (m: any) => { m.files[0].bytes = -1; },
  ]) {
    const value = structuredClone(LID_MANIFEST); change(value);
    expect(() => validateLidManifest(value)).toThrow();
  }
});
test("cheap dispatch needs an exact readiness record, not just a python path", () => {
  const paths = narrationPaths("R");
  expect(resolveNarrationPython("R", () => true, () => "{}")).toBeUndefined();
  expect(resolveNarrationPython("R", () => true, () => PN_READY_RECORD)).toBe(paths.python);
  expect(resolveNarrationPython("R", p => p !== paths.python, () => PN_READY_RECORD)).toBeUndefined();
  expect(resolveNarrationPython("R", () => true, () => PN_READY_RECORD.replace(LID_MANIFEST.revision, "main"))).toBeUndefined();
  const old = JSON.parse(PN_READY_RECORD); delete old.provenance;
  expect(resolveNarrationPython("R", () => true, () => JSON.stringify(old))).toBeUndefined();
});
test("doctor hashes assets and probes dependencies without loading weights, with distinct negatives", async () => {
  let probes = 0;
  const deps = { exists: () => true, read: () => PN_READY_RECORD,
    validateDirectory() {},
    fingerprint: (p: string) => LID_MANIFEST.files.find(f => p.endsWith(`\\${f.filename}`))!,
    probe: async (python: string, expectedVenv: string) => {
      probes++;
      expect(python).toBe(narrationPaths("R").python);
      expect(expectedVenv).toBe(narrationPaths("R").venv);
      return 0;
    } };
  expect(await inspectNarration("R", deps)).toEqual({ ready: true, code: "verified-local-assets-and-dependencies" });
  expect(probes).toBe(1);
  expect((await inspectNarration("R", { ...deps, exists: p => !p.endsWith("vocab.txt") })).code).toBe("missing-local-assets");
  expect((await inspectNarration("R", { ...deps, fingerprint: () => ({ bytes: 1, sha256: "0".repeat(64) }) })).code).toBe("local-model-integrity-failed");
  expect(probes).toBe(1);
  expect((await inspectNarration("R", { ...deps, probe: async () => 1 })).code).toBe("missing-or-incompatible-dependencies");
});
test("native fingerprint hashes exact bytes with bounded buffers", () => {
  const root = mkdtempSync(join(tmpdir(), "open-vox-pn-test-"));
  try {
    const path = join(root, "fixture"); writeFileSync(path, "abc");
    expect(fileFingerprint(path)).toEqual({ bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("native directory checks forbid alternate tokenizer/model files", () => {
  const root = mkdtempSync(join(tmpdir(), "open-vox-pn-directory-test-"));
  try {
    assertLidDirectory(root, true);
    writeFileSync(join(root, "tokenizer.json"), "{}");
    expect(() => assertLidDirectory(root, true)).toThrow("Unexpected local model files");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
