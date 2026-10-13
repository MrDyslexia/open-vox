import { copyFileSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { fileFingerprint, type Fingerprint } from "./narration-assets";

/**
 * Parallel, inactive asset layer for the standalone ONNX FP32 language detector.
 *
 * It never shares paths, markers, packages or manifests with the Torch layer in
 * `narration-assets.ts`. The ~709 MB graph has no download URL and is never a Git
 * file: it is copied from a LOCAL source directory after sha256 verification.
 * Field semantics mirror `scripts/narration_lid_onnx.py::validate_manifest`; the
 * tests run both validators against the real bundled file.
 */
export const ONNX_MANIFEST_PATH = fileURLToPath(new URL("../resources/lid-model-onnx-fp32.json", import.meta.url));
const BACKEND = "onnx-fp32";
const CHECKPOINT = "sagorsarker/codeswitch-spaeng-lid-lince";
const REVISION = "66d0e899b3fcf70d8727e4521c7a9c3f7a1fa73c";
export const ONNX_FILENAMES = ["model.onnx", "tokenizer/config.json", "tokenizer/special_tokens_map.json",
  "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json", "tokenizer/vocab.txt"] as const;
const DIRECTORIES = ["tokenizer"] as const;
const RUNTIME_KEYS = ["numpy", "onnxruntime", "tokenizers"];

export type OnnxLidFile = { filename: string; bytes: number; sha256: string };
export type OnnxLidManifest = {
  schemaVersion: 1; backend: "onnx-fp32";
  derivedFrom: { checkpoint: string; revision: string };
  runtime: { numpy: string; onnxruntime: string; tokenizers: string };
  files: OnnxLidFile[];
};

function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join() === [...expected].sort().join();
}

/** Strict, fixed-layout allowlist; a manifest can never introduce a filename, URL or extra field. */
export function validateOnnxManifest(value: unknown): OnnxLidManifest {
  if (!keys(value, ["schemaVersion", "backend", "derivedFrom", "runtime", "files"]) || value.schemaVersion !== 1
      || value.backend !== BACKEND
      || !keys(value.derivedFrom, ["checkpoint", "revision"])
      || value.derivedFrom.checkpoint !== CHECKPOINT || value.derivedFrom.revision !== REVISION
      || !keys(value.runtime, RUNTIME_KEYS)
      || !Object.values(value.runtime).every(v => typeof v === "string" && /^\d+(\.\d+){1,2}$/.test(v))
      || !Array.isArray(value.files) || value.files.length !== ONNX_FILENAMES.length) {
    throw new Error("Invalid pinned ONNX LID manifest");
  }
  for (const [index, file] of value.files.entries()) {
    if (!keys(file, ["filename", "bytes", "sha256"]) || file.filename !== ONNX_FILENAMES[index]
        || !Number.isSafeInteger(file.bytes) || (file.bytes as number) <= 0
        || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error("Invalid pinned ONNX LID file");
    }
  }
  return structuredClone(value) as unknown as OnnxLidManifest;
}

/** Pinned runtime dependencies for the dedicated ONNX environment (no torch/transformers/safetensors/huggingface_hub). */
export const ONNX_PACKAGES: Record<string, string> = {
  "kokoro-onnx": "0.6.1", onnxruntime: "1.31.0", soundfile: "0.14.0", numpy: "2.5.3", tokenizers: "0.23.3",
};

/** A manifest runtime entry is a version prefix ("1.31") or exact ("2.5.3") of the exact package pin. */
export function onnxPackagesMatchRuntime(manifest: OnnxLidManifest, packages: Record<string, string> = ONNX_PACKAGES): boolean {
  return RUNTIME_KEYS.every(name => {
    const pin = packages[name], want = (manifest.runtime as Record<string, string>)[name];
    return typeof pin === "string" && typeof want === "string" && (pin === want || pin.startsWith(`${want}.`));
  });
}

export const ONNX_MANIFEST = validateOnnxManifest(JSON.parse(readFileSync(ONNX_MANIFEST_PATH, "utf8")));
if (!onnxPackagesMatchRuntime(ONNX_MANIFEST)) throw new Error("ONNX package pins disagree with the pinned manifest");
export const ONNX_BYTES = ONNX_MANIFEST.files.reduce((sum, file) => sum + file.bytes, 0);
const GRAPH_SHA256 = ONNX_MANIFEST.files[0]!.sha256;

/**
 * Layout under the user's managed home:
 *   <home>/pn-onnx-venv/                       dedicated environment (torch layer uses pn-venv)
 *   <home>/pn-onnx-venv/narration-onnx-ready.json
 *   <home>/lid-onnx/<model name>/<revision>-onnx-fp32-<graph sha256[0..12]>
 * The model id ties the directory to the checkpoint revision AND the exact graph bytes,
 * so a different export never reuses a stale directory. Torch uses <home>/lid/... .
 */
export function narrationOnnxPaths(home: string) {
  const venv = win32.join(home, "pn-onnx-venv");
  return {
    venv, python: win32.join(venv, "Scripts", "python.exe"),
    marker: win32.join(venv, "narration-onnx-ready.json"),
    model: win32.join(home, "lid-onnx", ONNX_MANIFEST.derivedFrom.checkpoint.split("/")[1]!,
      `${ONNX_MANIFEST.derivedFrom.revision}-${BACKEND}-${GRAPH_SHA256.slice(0, 12)}`),
  };
}

export const ONNX_PROVENANCE = "managed-onnx-environment-v1";
export const ONNX_READY_RECORD = JSON.stringify({
  schemaVersion: 1, backend: BACKEND, revision: ONNX_MANIFEST.derivedFrom.revision, graphSha256: GRAPH_SHA256,
  packages: ONNX_PACKAGES, provenance: ONNX_PROVENANCE,
});

/** Throws when the path or any ancestor is a symlink/junction. */
export function assertNoSymlinkAncestors(path: string): void {
  let current = win32.resolve(path);
  for (;;) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Unsafe managed ONNX path");
    const parent = win32.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Cheap dispatch hint only. Integrity is rechecked explicitly by doctor/setup; nothing selects this yet. */
export function resolveNarrationOnnxPython(
  home: string, exists: (path: string) => boolean = existsSync,
  read = (path: string) => readFileSync(path, "utf8"),
  assertPath: (path: string) => void = assertNoSymlinkAncestors,
): string | undefined {
  const paths = narrationOnnxPaths(home);
  try {
    if (!exists(paths.python) || !exists(paths.marker)) return undefined;
    for (const path of [paths.venv, paths.python, paths.marker]) assertPath(path);
    const record = JSON.parse(read(paths.marker));
    if (!keys(record, ["schemaVersion", "backend", "revision", "graphSha256", "packages", "provenance"])
        || record.schemaVersion !== 1 || record.backend !== BACKEND || record.provenance !== ONNX_PROVENANCE
        || record.revision !== ONNX_MANIFEST.derivedFrom.revision || record.graphSha256 !== GRAPH_SHA256
        || !keys(record.packages, Object.keys(ONNX_PACKAGES))) return undefined;
    const packages = record.packages;
    if (!Object.entries(ONNX_PACKAGES).every(([name, version]) => packages[name] === version)) return undefined;
    return paths.python;
  } catch { return undefined; }
}

function listing(directory: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = win32.join(directory, entry.name), relative = `${prefix}${entry.name}`;
    // Dirent and lstat both: junctions/symlinks must never redirect what the loaders read.
    if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) throw new Error("Unsafe ONNX LID entry");
    if (entry.isDirectory()) found.push(`${relative}/`, ...listing(path, `${relative}/`));
    else if (entry.isFile()) found.push(relative);
    else throw new Error("Unsafe ONNX LID entry");
  }
  return found;
}

/** Exact tree: the fixed files plus the `tokenizer/` directory; no symlinks, extras or missing entries. */
export function assertOnnxLidStructure(directory: string, manifest: OnnxLidManifest = ONNX_MANIFEST): void {
  assertNoSymlinkAncestors(directory);
  const expected = [...manifest.files.map(f => f.filename), ...DIRECTORIES.map(d => `${d}/`)].sort();
  const actual = listing(directory).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error("Unexpected local ONNX model files");
  }
}

function matches(actual: Fingerprint, expected: OnnxLidFile): boolean {
  return actual.bytes === expected.bytes && actual.sha256 === expected.sha256;
}

/**
 * Structure first, then (unless `fingerprint` is null) byte size and sha256 of every file.
 * Hashing is bounded-memory and meant for explicit setup/doctor, never availability polling.
 */
export function assertOnnxLidDirectory(
  directory: string, fingerprint: ((path: string) => Fingerprint) | null = fileFingerprint,
  manifest: OnnxLidManifest = ONNX_MANIFEST,
): void {
  assertOnnxLidStructure(directory, manifest);
  if (!fingerprint) return;
  for (const file of manifest.files) {
    if (!matches(fingerprint(win32.join(directory, ...file.filename.split("/"))), file)) {
      throw new Error(`ONNX LID integrity failure: ${file.filename}`);
    }
  }
}

export type OnnxCopyDeps = {
  fingerprint: (path: string) => Fingerprint;
  /** Source/staging tree check (exact layout, no symlinks). */
  assertTree: (directory: string, manifest: OnnxLidManifest) => void;
  assertManagedPath: (path: string) => void;
  exists: (path: string) => boolean;
  mkdir: (path: string) => void;
  /** Must refuse an existing target. */
  copyFile: (from: string, to: string) => void;
  /** Must refuse an existing destination. */
  publish: (from: string, to: string) => void;
  remove: (path: string) => void;
};

export const nodeOnnxCopyFs: OnnxCopyDeps = {
  fingerprint: fileFingerprint,
  assertTree: (directory, manifest) => assertOnnxLidStructure(directory, manifest),
  assertManagedPath: assertNoSymlinkAncestors,
  exists: existsSync,
  mkdir: path => { mkdirSync(path, { recursive: true }); },
  copyFile: (from, to) => { copyFileSync(from, to, constants.COPYFILE_EXCL); },
  publish: (from, to) => {
    // Windows refuses a directory rename onto an existing directory; the check also covers other platforms.
    if (existsSync(to)) throw new Error("ONNX model destination already exists");
    renameSync(from, to);
  },
  remove: path => { rmSync(path, { recursive: true, force: true }); },
};

/**
 * Copies a LOCAL model directory into the managed destination. Order:
 * source tree check -> source size+sha256 of every file -> stage `<dest>.<uuid>.partial`
 * -> re-verify the staged copy -> exclusive publish. Any failure removes the partial and
 * leaves the destination absent; an existing destination is never touched. Copy only:
 * hard links would let later edits of the source change the verified bytes.
 */
export function copyOnnxModelFromSource(
  source: string, dest: string, deps: OnnxCopyDeps = nodeOnnxCopyFs, manifest: OnnxLidManifest = ONNX_MANIFEST,
): void {
  deps.assertManagedPath(source);
  deps.assertManagedPath(win32.dirname(dest));
  deps.assertManagedPath(dest);
  if (deps.exists(dest)) throw new Error("ONNX model destination already exists");
  deps.assertTree(source, manifest);
  for (const file of manifest.files) {
    if (!matches(deps.fingerprint(win32.join(source, ...file.filename.split("/"))), file)) {
      throw new Error(`ONNX LID source integrity failure: ${file.filename}`);
    }
  }
  const partial = `${dest}.${randomUUID()}.partial`;
  try {
    deps.mkdir(partial);
    for (const name of DIRECTORIES) deps.mkdir(win32.join(partial, name));
    for (const file of manifest.files) {
      const parts = file.filename.split("/");
      deps.copyFile(win32.join(source, ...parts), win32.join(partial, ...parts));
    }
    deps.assertTree(partial, manifest);
    for (const file of manifest.files) {
      if (!matches(deps.fingerprint(win32.join(partial, ...file.filename.split("/"))), file)) {
        throw new Error(`ONNX LID staged integrity failure: ${file.filename}`);
      }
    }
    deps.publish(partial, dest);
  } finally { deps.remove(partial); }
}

export type OnnxReadiness = { ready: boolean; code: string };
/**
 * Read-only readiness for the ONNX environment. Ordered like the Torch `inspectNarration`:
 * environment, marker, files, structure+hashes, then the dependency probe. It never
 * loads model weights and never creates, repairs or deletes anything.
 */
export async function inspectNarrationOnnx(home: string, deps: {
  exists: (path: string) => boolean;
  read: (path: string) => string;
  fingerprint: (path: string) => Fingerprint;
  validateDirectory: (directory: string) => void;
  probe: (python: string, expectedVenv: string) => Promise<number>;
  assertPath?: (path: string) => void;
}): Promise<OnnxReadiness> {
  const paths = narrationOnnxPaths(home);
  if (!deps.exists(paths.python) || !deps.exists(paths.marker)) return { ready: false, code: "missing-managed-environment" };
  if (!resolveNarrationOnnxPython(home, deps.exists, deps.read, deps.assertPath)) return { ready: false, code: "invalid-managed-environment" };
  if (!ONNX_MANIFEST.files.every(file => deps.exists(win32.join(paths.model, ...file.filename.split("/"))))) {
    return { ready: false, code: "missing-local-assets" };
  }
  try {
    deps.validateDirectory(paths.model);
    for (const file of ONNX_MANIFEST.files) {
      if (!matches(deps.fingerprint(win32.join(paths.model, ...file.filename.split("/"))), file)) {
        return { ready: false, code: "local-model-integrity-failed" };
      }
    }
  } catch { return { ready: false, code: "local-model-integrity-failed" }; }
  try {
    if (await deps.probe(paths.python, paths.venv) !== 0) return { ready: false, code: "missing-or-incompatible-dependencies" };
  } catch { return { ready: false, code: "missing-or-incompatible-dependencies" }; }
  return { ready: true, code: "verified-local-assets-and-dependencies" };
}
