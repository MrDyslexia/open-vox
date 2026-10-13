import { describe, expect, test } from "bun:test";
import { win32 } from "node:path";
import { LID_MANIFEST_PATH, PN_READY_RECORD, narrationPaths } from "../src/narration-assets";
import { ONNX_MANIFEST, ONNX_MANIFEST_PATH, ONNX_READY_RECORD, narrationOnnxPaths } from "../src/narration-onnx-assets";
import { ONNX_FALLBACK_DIAGNOSTIC, createNarrationRuntimeSource, resolveNarrationRuntime } from "../src/narration-runtime";

const ROOT = "C:\\H";
const torch = narrationPaths(ROOT), onnx = narrationOnnxPaths(ROOT);
const modelFiles = ONNX_MANIFEST.files.map(f => win32.join(onnx.model, ...f.filename.split("/")));

function fakes(state: { torch?: boolean; onnx?: boolean; model?: boolean; badMarker?: boolean } = {}) {
  const present = new Set<string>(["C:\\kokoro\\python.exe"]);
  const files = new Map<string, string>();
  if (state.torch) { present.add(torch.python); present.add(torch.marker); files.set(torch.marker, PN_READY_RECORD); }
  if (state.onnx) {
    present.add(onnx.python); present.add(onnx.marker);
    files.set(onnx.marker, state.badMarker ? "{}" : ONNX_READY_RECORD);
  }
  if (state.model !== false && state.onnx) for (const f of modelFiles) present.add(f);
  return { exists: (p: string) => present.has(p), read: (p: string) => files.get(p) ?? "", assertPath: () => {} };
}
const base = { root: ROOT, fallbackPython: "C:\\kokoro\\python.exe" };

describe("resolveNarrationRuntime tuple matrix", () => {
  test("torch backend with a ready torch environment returns the existing torch tuple, even when ONNX is ready", () => {
    const diagnostics: string[] = [];
    const rt = resolveNarrationRuntime({ ...base, backend: "torch", ...fakes({ torch: true, onnx: true }), onDiagnostic: c => diagnostics.push(c) });
    expect(rt).toEqual({ backend: "torch", python: torch.python, lidManifest: LID_MANIFEST_PATH });
    expect(diagnostics).toEqual([]);
  });
  test("torch backend without a ready torch environment falls back to the Kokoro interpreter as today", () => {
    const rt = resolveNarrationRuntime({ ...base, backend: "torch", ...fakes({ onnx: true }) });
    expect(rt).toEqual({ backend: "torch", python: "C:\\kokoro\\python.exe", lidManifest: LID_MANIFEST_PATH });
  });
  test("onnx backend with ONNX ready returns ONE coherent onnx tuple", () => {
    const rt = resolveNarrationRuntime({ ...base, backend: "onnx", ...fakes({ torch: true, onnx: true }) });
    expect(rt).toEqual({ backend: "onnx", python: onnx.python, lidManifest: ONNX_MANIFEST_PATH, lidDirectory: onnx.model });
    expect(rt.lidManifest.endsWith("lid-model-onnx-fp32.json")).toBe(true);
    expect(win32.isAbsolute(rt.lidManifest) && win32.isAbsolute(rt.lidDirectory!)).toBe(true);
  });
  test.each([
    ["no ONNX environment", { torch: true }],
    ["invalid ONNX marker", { torch: true, onnx: true, badMarker: true }],
    ["missing model files", { torch: true, onnx: true, model: false }],
  ])("onnx selected but %s falls back to the full torch tuple with one bounded diagnostic", (_name, state) => {
    const diagnostics: string[] = [];
    const rt = resolveNarrationRuntime({ ...base, backend: "onnx", ...fakes(state), onDiagnostic: c => diagnostics.push(c) });
    expect(rt).toEqual({ backend: "torch", python: torch.python, lidManifest: LID_MANIFEST_PATH });
    expect(rt.python).not.toBe(onnx.python);
    expect(diagnostics).toEqual([ONNX_FALLBACK_DIAGNOSTIC]);
    expect(ONNX_FALLBACK_DIAGNOSTIC).toMatch(/^[a-z][a-z0-9-]{0,79}$/);
  });
  test("onnx selected, nothing ready: Kokoro interpreter plus torch manifest, never an onnx fragment", () => {
    const rt = resolveNarrationRuntime({ ...base, backend: "onnx", ...fakes() });
    expect(rt).toEqual({ backend: "torch", python: "C:\\kokoro\\python.exe", lidManifest: LID_MANIFEST_PATH });
    expect("lidDirectory" in rt).toBe(false);
  });
  test("a throwing diagnostic sink never breaks resolution", () => {
    const rt = resolveNarrationRuntime({ ...base, backend: "onnx", ...fakes(), onDiagnostic: () => { throw new Error("x"); } });
    expect(rt.backend).toBe("torch");
  });
});

describe("createNarrationRuntimeSource", () => {
  test("reads the backend on every call and reports the fallback once per streak", () => {
    let backend: "torch" | "onnx" = "onnx";
    let state = fakes({ torch: true });
    const diagnostics: string[] = [];
    const source = createNarrationRuntimeSource({ ...base, backend: () => backend, onDiagnostic: c => diagnostics.push(c),
      deps: { exists: p => state.exists(p), read: p => state.read(p), assertPath: () => {} } });
    expect(source().backend).toBe("torch");
    expect(source().backend).toBe("torch");
    expect(diagnostics).toEqual([ONNX_FALLBACK_DIAGNOSTIC]);
    state = fakes({ torch: true, onnx: true });
    expect(source().backend).toBe("onnx");
    state = fakes({ torch: true });
    source();
    expect(diagnostics).toEqual([ONNX_FALLBACK_DIAGNOSTIC, ONNX_FALLBACK_DIAGNOSTIC]);
    backend = "torch";
    source();
    expect(diagnostics).toHaveLength(2);
  });
});
