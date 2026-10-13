import { expect, test } from "bun:test";
import { ONNX_MANIFEST, ONNX_READY_RECORD, inspectNarrationOnnx, narrationOnnxPaths } from "../src/narration-onnx-assets";

const paths = narrationOnnxPaths("R");
function deps(overrides: Record<string, unknown> = {}) {
  const probes: [string, string][] = [];
  const base = {
    exists: () => true, read: () => ONNX_READY_RECORD, assertPath() {}, validateDirectory() {},
    fingerprint: (p: string) => ONNX_MANIFEST.files.find(f => p.endsWith(f.filename.replace("/", "\\")))!,
    probe: async (python: string, venv: string) => { probes.push([python, venv]); return 0; },
  };
  return { deps: { ...base, ...overrides } as Parameters<typeof inspectNarrationOnnx>[1], probes };
}

test("a verified install is ready and the probe is bound to the ONNX interpreter and venv", async () => {
  const d = deps();
  expect(await inspectNarrationOnnx("R", d.deps)).toEqual({ ready: true, code: "verified-local-assets-and-dependencies" });
  expect(d.probes).toEqual([[paths.python, paths.venv]]);
});
test("missing interpreter or marker is missing-managed-environment and nothing else runs", async () => {
  for (const missing of [paths.python, paths.marker]) {
    const d = deps({ exists: (p: string) => p !== missing });
    expect(await inspectNarrationOnnx("R", d.deps)).toEqual({ ready: false, code: "missing-managed-environment" });
    expect(d.probes).toHaveLength(0);
  }
});
test("a wrong, foreign or torch-style marker is invalid-managed-environment", async () => {
  for (const read of ["{}", "not json", ONNX_READY_RECORD.replace(ONNX_MANIFEST.derivedFrom.revision, "main"), JSON.stringify({ schemaVersion: 1, revision: "x", packages: {}, provenance: "managed-environment-v1" })]) {
    const d = deps({ read: () => read });
    expect((await inspectNarrationOnnx("R", d.deps)).code).toBe("invalid-managed-environment");
    expect(d.probes).toHaveLength(0);
  }
  expect((await inspectNarrationOnnx("R", deps({ assertPath() { throw new Error("link"); } }).deps)).code).toBe("invalid-managed-environment");
});
test("a missing model file is missing-local-assets", async () => {
  expect((await inspectNarrationOnnx("R", deps({ exists: (p: string) => !p.endsWith("vocab.txt") }).deps)).code).toBe("missing-local-assets");
  expect((await inspectNarrationOnnx("R", deps({ exists: (p: string) => !p.endsWith("model.onnx") }).deps)).code).toBe("missing-local-assets");
});
test("structure or hash failures are local-model-integrity-failed and skip the probe", async () => {
  const structure = deps({ validateDirectory() { throw new Error("extra"); } });
  expect((await inspectNarrationOnnx("R", structure.deps)).code).toBe("local-model-integrity-failed");
  const hash = deps({ fingerprint: () => ({ bytes: 1, sha256: "0".repeat(64) }) });
  expect((await inspectNarrationOnnx("R", hash.deps)).code).toBe("local-model-integrity-failed");
  const throws = deps({ fingerprint: () => { throw new Error("unsafe"); } });
  expect((await inspectNarrationOnnx("R", throws.deps)).code).toBe("local-model-integrity-failed");
  expect(structure.probes.length + hash.probes.length + throws.probes.length).toBe(0);
});
test("a failing or throwing probe is missing-or-incompatible-dependencies", async () => {
  expect((await inspectNarrationOnnx("R", deps({ probe: async () => 1 }).deps)).code).toBe("missing-or-incompatible-dependencies");
  expect((await inspectNarrationOnnx("R", deps({ probe: async () => { throw new Error("spawn"); } }).deps)).code).toBe("missing-or-incompatible-dependencies");
});
test("inspection only reads: the dependency surface has no writer and the model weights are never loaded", async () => {
  const d = deps();
  expect(Object.keys(d.deps).sort()).toEqual(["assertPath", "exists", "fingerprint", "probe", "read", "validateDirectory"]);
});
