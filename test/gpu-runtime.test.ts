import { describe, expect, test } from "bun:test";
import { win32 } from "node:path";
import { digest, gpuAssetPaths, gpuPackages, gpuPaths, GPU_LOCK_SHA256, inspectGpuProfile, selectGpuPython, type GpuReadDeps } from "../src/gpu-runtime";
import { ONNX_MANIFEST } from "../src/narration-onnx-assets";
import { resolveNarrationRuntime } from "../src/narration-runtime";

function fixture() {
  const home = "C:\\managed\\open-vox", files = new Map<string, string>(), stamps = new Map<string, { bytes: number; mtimeMs: number }>();
  const deps: GpuReadDeps = {
    exists: path => files.has(path), read: path => { if (!files.has(path)) throw Error(); return files.get(path)!; },
    assertPath: () => {}, stamp: path => { if (!stamps.has(path)) throw Error(); return stamps.get(path)!; },
  };
  for (const role of ["lid", "kokoro"] as const) {
    const p = gpuPaths(home, role);
    files.set(p.venv, ""); files.set(p.python, "");
    const states = Object.fromEntries(Object.keys(gpuPackages(role)).map((_, i) => [`Lib/pkg${i}/METADATA`, { bytes: 100, mtimeMs: 42 }]));
    states["Scripts/python.exe"] = { bytes: 100, mtimeMs: 42 };
    for (const [relative, stamp] of Object.entries(states)) stamps.set(win32.join(p.venv, ...relative.split("/")), stamp);
    const identity = { schemaVersion: 1, profile: "cuda13", role, root: p.venv, python: p.python,
      pythonVersion: "3.13.15", lockSha256: GPU_LOCK_SHA256, packages: gpuPackages(role), files: states };
    Object.assign(identity, { basePrefix: "C:\\Python313", executableSha256: "a".repeat(64) });
    files.set(p.marker, JSON.stringify(identity));
    const assets = Object.fromEntries(Object.entries(gpuAssetPaths(home, role)).map(([name, path]) => {
      const pin = ONNX_MANIFEST.files.find(f => f.filename === name);
      const stamp = { bytes: pin?.bytes ?? 100, mtimeMs: 42 };
      stamps.set(path, stamp);
      return [name, { ...stamp, sha256: pin?.sha256 ?? "a".repeat(64) }];
    }));
    const models: Record<string, unknown> = {};
    for (const model of role === "lid" ? ["lid", "kokoro"] : ["kokoro"]) {
      const evidence = JSON.stringify([{ cat: "Node", provider: "CUDAExecutionProvider", op: "MatMul", count: 1 }]);
      files.set(win32.join(p.venv, `${model}-cuda-evidence.json`), evidence);
      models[model] = { cudaComputeNodes: 1, cpuNodes: 0, sha256: digest(evidence), sourceProfileSha256: "a".repeat(64) };
    }
    files.set(p.qualification, JSON.stringify({ schemaVersion: 1, qualified: true, identity,
      dependenciesSha256: digest(files.get(p.marker)!), assets, models, cpuSanity: true }));
  }
  return { home, files, stamps, deps };
}

describe("coherent GPU profiles", () => {
  test("default CPU does not read GPU state; qualified profile selects both new interpreters", () => {
    const h = fixture();
    expect(selectGpuPython(h.home, "lid", undefined, { ...h.deps, read: () => { throw Error("must not read"); } })).toBeUndefined();
    expect(inspectGpuProfile(h.home, h.deps)).toEqual({ ready: true, qualified: true, code: "qualified-cuda13" });
    for (const role of ["lid", "kokoro"] as const) expect(selectGpuPython(h.home, role, "cuda13", h.deps)).toBe(gpuPaths(h.home, role).python);
    const tuple = resolveNarrationRuntime({ root: h.home, backend: "onnx", profile: "cuda13", gpuDeps: h.deps, fallbackPython: "cpu", exists: () => false });
    expect(tuple.backend).toBe("onnx"); expect(tuple.python).toBe(gpuPaths(h.home, "lid").python);
    expect(tuple.lidDirectory).toContain("a322d9809cd3");
  });
  test("dependencies-ready is not qualification; missing either env blocks BOTH", () => {
    for (const role of ["lid", "kokoro"] as const) {
      const h = fixture(); h.files.delete(gpuPaths(h.home, role).qualification);
      expect(inspectGpuProfile(h.home, h.deps)).toEqual({ ready: true, qualified: false, code: "gpu-profile-unqualified" });
      expect(selectGpuPython(h.home, "lid", "cuda13", h.deps)).toBeUndefined();
      expect(selectGpuPython(h.home, "kokoro", "cuda13", h.deps)).toBeUndefined();
    }
  });
  test("mixed pins, foreign identity, malformed records and redirected paths fail closed", () => {
    for (const change of [
      (q: any) => { q.profile = "cpu"; }, (q: any) => { q.packages.onnxruntime = "1.31.0"; },
      (q: any) => { q.python = "C:\\foreign\\python.exe"; }, (q: any) => { q.lockSha256 = "b".repeat(64); },
      (q: any) => { q.files["../foreign"] = { bytes: 1, mtimeMs: 1 }; },
    ]) {
      const h = fixture(), path = gpuPaths(h.home, "lid").marker;
      const q = JSON.parse(h.files.get(path)!); change(q); h.files.set(path, JSON.stringify(q));
      expect(inspectGpuProfile(h.home, h.deps).ready).toBe(false);
    }
    const h = fixture(); h.deps.assertPath = () => { throw Error("junction"); };
    expect(inspectGpuProfile(h.home, h.deps).qualified).toBe(false);
  });
  test("stale assets, changed native package files and provider-only evidence invalidate qualification", () => {
    for (const change of [
      (h: ReturnType<typeof fixture>) => { h.stamps.set(gpuAssetPaths(h.home, "lid").kokoro!, { bytes: 101, mtimeMs: 42 }); },
      (h: ReturnType<typeof fixture>) => { h.stamps.delete(win32.join(gpuPaths(h.home, "lid").venv, "Lib", "pkg0", "METADATA")); },
      (h: ReturnType<typeof fixture>) => { h.files.set(win32.join(gpuPaths(h.home, "lid").venv, "lid-cuda-evidence.json"), "[]"); },
      (h: ReturnType<typeof fixture>) => { const p = gpuPaths(h.home, "kokoro").qualification; const q = JSON.parse(h.files.get(p)!); q.qualified = false; h.files.set(p, JSON.stringify(q)); },
    ]) {
      const h = fixture(); change(h); expect(inspectGpuProfile(h.home, h.deps).qualified).toBe(false);
    }
  });
  test("unqualified GPU keeps CPU fallback and emits a bounded reason; Torch is not a GPU profile", () => {
    const h = fixture(), codes: string[] = [];
    h.files.delete(gpuPaths(h.home, "lid").qualification);
    const options = { root: h.home, profile: "cuda13" as const, gpuDeps: h.deps, fallbackPython: "cpu", exists: () => false, onDiagnostic: (c: string) => codes.push(c) };
    expect(resolveNarrationRuntime({ ...options, backend: "onnx" }).python).toBe("cpu");
    expect(codes).toContain("gpu-profile-unavailable");
    expect(resolveNarrationRuntime({ ...options, backend: "torch" }).python).toBe("cpu");
  });
});
