import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";
import lock from "../resources/runtime-cuda13-windows.json";
import { assertNoSymlinkAncestors, narrationOnnxPaths, ONNX_MANIFEST } from "./narration-onnx-assets";

export type RuntimeProfile = "cpu" | "cuda13";
export type GpuRole = "lid" | "kokoro";
export const GPU_LOCK = lock;
export const GPU_LOCK_SHA256 = "f1ebc2749415b828d5f3c199d6680f4cee6cfdefe942060defae6a87e1026ff8";
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Seal the entire researched closure, not merely each individually well-formed wheel. */
export function validateGpuLock(value: unknown): asserts value is typeof lock {
  if (digest(JSON.stringify(value)) !== GPU_LOCK_SHA256) throw new Error("CUDA13 package lock is incomplete or changed");
  for (const w of (value as typeof lock).wheels) {
    const url = new URL(w.url);
    if (url.protocol !== "https:" || url.hostname !== "files.pythonhosted.org" || url.username || url.password
        || url.search || url.hash || !url.pathname.endsWith(`/${w.filename}`)
        || !/^[a-f0-9]{64}$/.test(w.sha256) || w.name === "onnxruntime") throw new Error("Unsafe CUDA13 wheel");
  }
}
export function gpuPaths(home: string, role: GpuRole) {
  const venv = win32.join(home, role === "lid" ? "pn-onnx-gpu-venv" : "kokoro-gpu-venv");
  return { venv, python: win32.join(venv, "Scripts", "python.exe"),
    marker: win32.join(venv, "gpu-dependencies.json"), qualification: win32.join(venv, "gpu-qualification.json") };
}
export const gpuPackages = (role: GpuRole) => Object.fromEntries(GPU_LOCK.wheels
  .filter(w => role === "lid" || w.role === "common").map(w => [w.name, w.version]));

export function gpuAssetPaths(home: string, role: GpuRole): Record<string, string> {
  const paths: Record<string, string> = {
    kokoro: win32.join(home, "kokoro", "kokoro-v1.0.onnx"), voices: win32.join(home, "kokoro", "voices-v1.0.bin"),
  };
  if (role === "lid") for (const f of ONNX_MANIFEST.files) paths[f.filename] = win32.join(narrationOnnxPaths(home).model, ...f.filename.split("/"));
  return paths;
}

export type GpuReadDeps = {
  exists: (path: string) => boolean; read: (path: string) => string;
  assertPath: (path: string) => void;
  stamp: (path: string) => { bytes: number; mtimeMs: number };
};
export const gpuReadDeps: GpuReadDeps = {
  exists: existsSync, read: p => { if (statSync(p).size > 256 * 1024) throw Error("oversized-gpu-record"); return readFileSync(p, "utf8"); }, assertPath: assertNoSymlinkAncestors,
  stamp: p => { const s = statSync(p); if (!s.isFile()) throw Error("not-file"); return { bytes: s.size, mtimeMs: s.mtimeMs }; },
};
function boundedJson(path: string, deps: GpuReadDeps): any {
  deps.assertPath(path);
  const text = deps.read(path);
  if (text.length > 256 * 1024) throw Error("oversized-gpu-record");
  return JSON.parse(text);
}
function sameMap(a: any, b: Record<string, string>) {
  return a && Object.keys(a).sort().join() === Object.keys(b).sort().join()
    && Object.entries(b).every(([k, v]) => a[k] === v);
}

/** Cheap dispatch gate. Full distribution/DLL checks run again in the selected Python worker.
 * Asset stamps bind the qualification to unchanged local files; LID also hashes before loading.
 * These local records are provenance, not signatures against a hostile local administrator.
 */
export function inspectGpuProfile(home: string, deps: GpuReadDeps = gpuReadDeps): { ready: boolean; qualified: boolean; code: string } {
  let ready = false;
  try {
    validateGpuLock(GPU_LOCK);
    for (const role of ["lid", "kokoro"] as const) {
      const p = gpuPaths(home, role);
      for (const path of [p.venv, p.python, p.marker]) { deps.assertPath(path); if (!deps.exists(path)) throw Error(); }
      const record = boundedJson(p.marker, deps);
      if (record.schemaVersion !== 1 || record.profile !== "cuda13" || record.role !== role
          || record.root !== p.venv || record.python !== p.python || record.lockSha256 !== GPU_LOCK_SHA256
          || typeof record.basePrefix !== "string" || !win32.isAbsolute(record.basePrefix) || record.basePrefix === p.venv
          || !/^[a-f0-9]{64}$/.test(record.executableSha256)
          || !/^3\.13\.\d+$/.test(record.pythonVersion) || !sameMap(record.packages, gpuPackages(role))) throw Error();
      if (!record.files || !record.files["Scripts/python.exe"] || Object.keys(record.files).length < Object.keys(gpuPackages(role)).length
          || Object.keys(record.files).length > 2048) throw Error();
      for (const [relative, expected] of Object.entries(record.files) as [string, any][]) {
        if (!relative || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === ".." || part.includes(":"))) throw Error();
        const path = win32.join(p.venv, ...relative.split("/"));
        deps.assertPath(path);
        const actual = deps.stamp(path);
        if (!Number.isSafeInteger(expected?.bytes) || !Number.isFinite(expected?.mtimeMs)
            || actual.bytes !== expected.bytes || Math.abs(actual.mtimeMs - expected.mtimeMs) > 0.01) throw Error();
      }
    }
    ready = true;
    for (const role of ["lid", "kokoro"] as const) {
      const p = gpuPaths(home, role), q = boundedJson(p.qualification, deps);
      const identity = boundedJson(p.marker, deps);
      if (q.schemaVersion !== 1 || q.qualified !== true || JSON.stringify(q.identity) !== JSON.stringify(identity)
          || q.dependenciesSha256 !== digest(deps.read(p.marker)) || q.cpuSanity !== true) throw Error();
      const expected = gpuAssetPaths(home, role);
      if (!q.assets || Object.keys(q.assets).sort().join() !== Object.keys(expected).sort().join()) throw Error();
      for (const [key, path] of Object.entries(expected)) {
        deps.assertPath(path);
        const stamp = deps.stamp(path), actual = q.assets[key];
        if (!actual || !Number.isSafeInteger(actual.bytes) || !Number.isFinite(actual.mtimeMs)
            || !/^[a-f0-9]{64}$/.test(actual.sha256) || actual.bytes !== stamp.bytes
            || Math.abs(actual.mtimeMs - stamp.mtimeMs) > 0.01) throw Error();
        const pinned = ONNX_MANIFEST.files.find(f => f.filename === key);
        if (pinned && (actual.sha256 !== pinned.sha256 || actual.bytes !== pinned.bytes)) throw Error();
      }
      for (const model of role === "lid" ? ["lid", "kokoro"] : ["kokoro"]) {
        const proof = q.models?.[model];
        const evidence = win32.join(p.venv, `${model}-cuda-evidence.json`);
        const events = boundedJson(evidence, deps);
        if (!proof || proof.sha256 !== digest(deps.read(evidence)) || !Array.isArray(events) || events.length > 100000
            || !/^[a-f0-9]{64}$/.test(proof.sourceProfileSha256)
            || !events.every(e => e && Object.keys(e).sort().join() === "cat,count,op,provider" && e.cat === "Node"
              && ["CUDAExecutionProvider", "CPUExecutionProvider"].includes(e.provider)
              && Number.isSafeInteger(e.count) && e.count > 0 && e.count <= 100000
              && typeof e.op === "string" && /^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(e.op))) throw Error();
        const compute = events.filter(e => e?.cat === "Node" && e?.provider === "CUDAExecutionProvider"
          && typeof e.op === "string" && !e.op.toLowerCase().includes("memcpy"));
        const cudaCount = compute.reduce((sum, e) => sum + e.count, 0);
        const cpuCount = events.filter(e => e.provider === "CPUExecutionProvider").reduce((sum, e) => sum + e.count, 0);
        if (!cudaCount || cudaCount + cpuCount > 100000 || proof.cudaComputeNodes !== cudaCount || proof.cpuNodes !== cpuCount) throw Error();
      }
    }
    return { ready, qualified: true, code: "qualified-cuda13" };
  } catch { return { ready, qualified: false, code: ready ? "gpu-profile-unqualified" : "gpu-dependencies-unavailable" }; }
}

export function selectGpuPython(home: string, role: GpuRole, profile: RuntimeProfile = "cpu", deps?: GpuReadDeps): string | undefined {
  return profile === "cuda13" && inspectGpuProfile(home, deps).qualified ? gpuPaths(home, role).python : undefined;
}
