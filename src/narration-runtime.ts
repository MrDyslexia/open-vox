import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";
import type { NarrationBackend } from "./config";
import { LID_MANIFEST_PATH, resolveNarrationPython } from "./narration-assets";
import { ONNX_MANIFEST, ONNX_MANIFEST_PATH, narrationOnnxPaths, resolveNarrationOnnxPython } from "./narration-onnx-assets";
import { selectGpuPython, type RuntimeProfile, type GpuReadDeps } from "./gpu-runtime";

/**
 * One coherent runtime for a planned narration run: interpreter, LID manifest and (ONNX only)
 * model directory always belong to the same backend. Never mix fragments of two backends.
 */
export type NarrationRuntime = {
  backend: NarrationBackend;
  python: string;
  lidManifest: string;
  /** Present only for the onnx tuple: the absolute managed model directory. */
  lidDirectory?: string;
};

/** Bounded, prose-free code reported when onnx was selected but its environment is not ready. */
export const ONNX_FALLBACK_DIAGNOSTIC = "onnx-backend-unavailable";

export type RuntimeDeps = {
  exists: (path: string) => boolean;
  read: (path: string) => string;
  assertPath?: (path: string) => void;
};
const nodeDeps = { exists: existsSync, read: (path: string) => readFileSync(path, "utf8") };

/**
 * Cheap, per-utterance readiness (marker + file presence). Full size/sha256 and dependency
 * verification stay in explicit setup/doctor and in the Python helper before any model load.
 */
function onnxTuple(root: string, deps: RuntimeDeps): NarrationRuntime | undefined {
  const python = resolveNarrationOnnxPython(root, deps.exists, deps.read, deps.assertPath);
  if (!python) return undefined;
  const { model } = narrationOnnxPaths(root);
  if (!ONNX_MANIFEST.files.every(file => deps.exists(win32.join(model, ...file.filename.split("/"))))) return undefined;
  return { backend: "onnx", python, lidManifest: ONNX_MANIFEST_PATH, lidDirectory: model };
}

export function resolveNarrationRuntime(options: {
  root: string;
  backend: NarrationBackend;
  /** Interpreter used today when the managed torch environment is not ready (the Kokoro venv). */
  fallbackPython: string;
  profile?: RuntimeProfile;
  gpuDeps?: GpuReadDeps;
  onDiagnostic?: (code: string) => void;
} & Partial<RuntimeDeps>): NarrationRuntime {
  const deps: RuntimeDeps = { exists: options.exists ?? nodeDeps.exists, read: options.read ?? nodeDeps.read, assertPath: options.assertPath };
  if (options.profile === "cuda13" && options.backend !== "onnx") {
    try { options.onDiagnostic?.("gpu-profile-requires-onnx"); } catch {}
  }
  if (options.backend === "onnx") {
    if (options.profile === "cuda13") {
      const python = selectGpuPython(options.root, "lid", options.profile, options.gpuDeps);
      if (python) return { backend: "onnx", python, lidManifest: ONNX_MANIFEST_PATH, lidDirectory: narrationOnnxPaths(options.root).model };
      try { options.onDiagnostic?.("gpu-profile-unavailable"); } catch {}
    }
    const tuple = onnxTuple(options.root, deps);
    if (tuple) return tuple;
    try { options.onDiagnostic?.(ONNX_FALLBACK_DIAGNOSTIC); } catch {}
  }
  return {
    backend: "torch",
    python: resolveNarrationPython(options.root, deps.exists, deps.read) ?? options.fallbackPython,
    lidManifest: LID_MANIFEST_PATH,
  };
}

/**
 * Per-utterance runtime provider. The backend is re-read on every call so `open-vox
 * narration-backend` applies immediately; a fallback is reported once per consecutive streak.
 */
export function createNarrationRuntimeSource(options: {
  root: string;
  backend: () => NarrationBackend;
  profile?: () => RuntimeProfile;
  fallbackPython: string;
  onDiagnostic?: (code: string) => void;
  deps?: RuntimeDeps;
}): () => NarrationRuntime {
  let reported = false;
  return () => {
    const backend = options.backend();
    let fellBack = false;
    const runtime = resolveNarrationRuntime({
      root: options.root, backend, profile: options.profile?.(), fallbackPython: options.fallbackPython, ...options.deps,
      onDiagnostic: code => { fellBack = true; if (!reported) { reported = true; options.onDiagnostic?.(code); } },
    });
    if (!fellBack) reported = false;
    return runtime;
  };
}
