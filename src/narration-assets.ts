import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const LID_MANIFEST_PATH = fileURLToPath(new URL("../resources/lid-model.json", import.meta.url));
const MODEL_ID = "sagorsarker/codeswitch-spaeng-lid-lince";
const REVISION = "66d0e899b3fcf70d8727e4521c7a9c3f7a1fa73c";
const FILENAMES = ["config.json", "model.safetensors", "special_tokens_map.json", "tokenizer_config.json", "vocab.txt"];
export type LidFile = { filename: string; bytes: number; sha256: string };
export type LidManifest = { schemaVersion: 1; modelId: string; revision: string; files: LidFile[] };

function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join() === [...expected].sort().join();
}

/** A declarative, fixed-repository allowlist; URLs are derived, never supplied by a manifest. */
export function validateLidManifest(value: unknown): LidManifest {
  if (!keys(value, ["schemaVersion", "modelId", "revision", "files"]) || value.schemaVersion !== 1
      || value.modelId !== MODEL_ID || value.revision !== REVISION || !Array.isArray(value.files)
      || value.files.length !== FILENAMES.length) throw new Error("Invalid pinned LID manifest");
  for (const [index, file] of value.files.entries()) {
    if (!keys(file, ["filename", "bytes", "sha256"]) || file.filename !== FILENAMES[index]
        || !Number.isSafeInteger(file.bytes) || (file.bytes as number) <= 0
        || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error("Invalid pinned LID file");
    }
  }
  return structuredClone(value) as LidManifest;
}

export const LID_MANIFEST = validateLidManifest(JSON.parse(readFileSync(LID_MANIFEST_PATH, "utf8")));
export const LID_BYTES = LID_MANIFEST.files.reduce((sum, file) => sum + file.bytes, 0);
export function lidDownloadUrl(file: LidFile, manifest = LID_MANIFEST): string {
  const checked = validateLidManifest(manifest);
  if (!checked.files.some(f => f.filename === file.filename && f.sha256 === file.sha256 && f.bytes === file.bytes)) {
    throw new Error("File is not in pinned LID manifest");
  }
  return `https://huggingface.co/${checked.modelId}/resolve/${checked.revision}/${file.filename}`;
}

export function narrationPaths(home: string) {
  const venv = win32.join(home, "pn-venv");
  return {
    venv, python: win32.join(venv, "Scripts", "python.exe"),
    marker: win32.join(venv, "narration-ready.json"),
    model: win32.join(home, "lid", LID_MANIFEST.modelId.split("/")[1]!, LID_MANIFEST.revision),
  };
}

export const PN_PACKAGES: Record<string, string> = {
  torch: "2.14.1+cpu", transformers: "5.19.0", tokenizers: "0.23.3", safetensors: "0.8.0",
  huggingface_hub: "2.2.0", "kokoro-onnx": "0.6.1", onnxruntime: "1.31.0", soundfile: "0.14.0", numpy: "2.5.3",
};
export const PN_READY_RECORD = JSON.stringify({ schemaVersion: 1, revision: LID_MANIFEST.revision, packages: PN_PACKAGES, provenance: "managed-environment-v1" });

/** Cheap dispatch hint only. Runtime rechecks model integrity before loading; doctor probes dependencies. */
export function resolveNarrationPython(home: string, exists: (path: string) => boolean = existsSync, read = (path: string) => readFileSync(path, "utf8")): string | undefined {
  const paths = narrationPaths(home);
  try {
    if (!exists(paths.python) || !exists(paths.marker)) return undefined;
    const record = JSON.parse(read(paths.marker));
    if (!keys(record, ["schemaVersion", "revision", "packages", "provenance"]) || record.schemaVersion !== 1 || record.provenance !== "managed-environment-v1"
        || record.revision !== LID_MANIFEST.revision || !keys(record.packages, Object.keys(PN_PACKAGES))) return undefined;
    const packages = record.packages;
    if (!Object.entries(PN_PACKAGES).every(([name, version]) => packages[name] === version)) return undefined;
    return paths.python;
  } catch { return undefined; }
}

export type Fingerprint = { bytes: number; sha256: string };
/** Bounded memory hashing, shared by explicit doctor/setup; never on engine availability polling. */
export function fileFingerprint(path: string): Fingerprint {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe LID asset");
  const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, "r");
  let bytes = 0;
  try {
    for (;;) {
      const size = readSync(fd, buffer, 0, buffer.length, null);
      if (!size) break;
      hash.update(buffer.subarray(0, size));
      bytes += size;
    }
  } finally { closeSync(fd); }
  return { bytes, sha256: hash.digest("hex") };
}
export function matchesLidFile(actual: Fingerprint, expected: LidFile): boolean {
  return actual.bytes === expected.bytes && actual.sha256 === expected.sha256;
}

export function assertLidDirectory(directory: string, allowMissing = false): void {
  let current = win32.resolve(directory);
  for (;;) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Unsafe LID directory");
    const parent = win32.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (allowMissing && !existsSync(directory)) return;
  const names = readdirSync(directory);
  if (names.some(name => !FILENAMES.includes(name)) || (!allowMissing && names.length !== FILENAMES.length)) {
    throw new Error("Unexpected local model files");
  }
}

export type NarrationReadiness = { ready: boolean; code: string };
export async function inspectNarration(home: string, deps: {
  exists: (path: string) => boolean;
  read: (path: string) => string;
  fingerprint: (path: string) => Fingerprint;
  validateDirectory: (directory: string) => void;
  probe: (python: string, expectedVenv: string) => Promise<number>;
}): Promise<NarrationReadiness> {
  const paths = narrationPaths(home);
  if (!deps.exists(paths.python) || !deps.exists(paths.marker)) return { ready: false, code: "missing-managed-environment" };
  if (!resolveNarrationPython(home, deps.exists, deps.read)) return { ready: false, code: "invalid-managed-environment" };
  if (!LID_MANIFEST.files.every(file => deps.exists(win32.join(paths.model, file.filename)))) return { ready: false, code: "missing-local-assets" };
  try {
    deps.validateDirectory(paths.model);
    for (const file of LID_MANIFEST.files) {
      const path = win32.join(paths.model, file.filename);
      if (!matchesLidFile(deps.fingerprint(path), file)) return { ready: false, code: "local-model-integrity-failed" };
    }
  } catch { return { ready: false, code: "local-model-integrity-failed" }; }
  try {
    if (await deps.probe(paths.python, paths.venv) !== 0) return { ready: false, code: "missing-or-incompatible-dependencies" };
  } catch { return { ready: false, code: "missing-or-incompatible-dependencies" }; }
  return { ready: true, code: "verified-local-assets-and-dependencies" };
}
