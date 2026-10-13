import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileFingerprint, narrationPaths, PN_PACKAGES } from "../src/narration-assets";
import {
  ONNX_BYTES, ONNX_FILENAMES, ONNX_MANIFEST, ONNX_MANIFEST_PATH, ONNX_PACKAGES, ONNX_READY_RECORD,
  assertOnnxLidDirectory, copyOnnxModelFromSource, narrationOnnxPaths, nodeOnnxCopyFs, onnxPackagesMatchRuntime,
  resolveNarrationOnnxPython, validateOnnxManifest, type OnnxCopyDeps, type OnnxLidManifest,
} from "../src/narration-onnx-assets";

const temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });
function temp(): string { const path = mkdtempSync(join(tmpdir(), "ov-onnx-")); temps.push(path); return path; }

/** Small synthetic bundle with the real layout and a matching manifest (real hashes of tiny bytes). */
function fixture(root = temp()) {
  const source = join(root, "source");
  mkdirSync(join(source, "tokenizer"), { recursive: true });
  const files = ONNX_FILENAMES.map((filename, index) => {
    const bytes = Buffer.from(`fixture-${index}-${filename}`);
    writeFileSync(join(source, ...filename.split("/")), bytes);
    return { filename, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const manifest = validateOnnxManifest({ ...structuredClone(ONNX_MANIFEST), files });
  return { root, source, manifest };
}
const realManifest = () => structuredClone(ONNX_MANIFEST) as any;

test("bundled manifest is valid, fixed-layout and totals the known byte count", () => {
  expect(ONNX_MANIFEST.files.map(f => f.filename)).toEqual([...ONNX_FILENAMES]);
  expect(ONNX_MANIFEST.backend).toBe("onnx-fp32");
  expect(ONNX_BYTES).toBe(709298327 + 991 + 112 + 3039058 + 49 + 995526);
  expect(validateOnnxManifest(JSON.parse(readFileSync(ONNX_MANIFEST_PATH, "utf8")))).toEqual(ONNX_MANIFEST);
});

test("strict manifest rejects extra/missing keys, bad hash, bad layout, wrong identity and loose runtime", () => {
  const changes: Array<(m: any) => void> = [
    m => { m.extra = 1; },
    m => { delete m.backend; },
    m => { m.schemaVersion = 2; },
    m => { m.backend = "onnx-int8"; },
    m => { m.derivedFrom.revision = "main"; },
    m => { m.derivedFrom.checkpoint = "other/model"; },
    m => { m.derivedFrom.extra = "x"; },
    m => { delete m.runtime.numpy; },
    m => { m.runtime.torch = "2.0"; },
    m => { m.runtime.numpy = "latest"; },
    m => { m.runtime.onnxruntime = ">=1.31"; },
    m => { m.files[0].url = "http://evil.test/model.onnx"; },
    m => { m.files[0].filename = "../model.onnx"; },
    m => { m.files[0].filename = "weights.onnx"; },
    m => { m.files[1].filename = "tokenizer/../config.json"; },
    m => { m.files.reverse(); },
    m => { m.files.pop(); },
    m => { m.files.push({ ...m.files[0] }); },
    m => { m.files[0].sha256 = "a".repeat(63); },
    m => { m.files[0].sha256 = "A".repeat(64); },
    m => { m.files[0].bytes = 0; },
    m => { m.files[0].bytes = 1.5; },
    m => { m.files[0].bytes = "10"; },
  ];
  for (const change of changes) {
    const value = realManifest(); change(value);
    expect(() => validateOnnxManifest(value)).toThrow();
  }
  expect(() => validateOnnxManifest(null)).toThrow();
  expect(() => validateOnnxManifest([])).toThrow();
});

test("paths are dedicated and never equal or nest inside the torch layer", () => {
  const onnx = narrationOnnxPaths("C:\\owned"), torch = narrationPaths("C:\\owned");
  expect(onnx.venv).toBe("C:\\owned\\pn-onnx-venv");
  expect(onnx.python).toBe("C:\\owned\\pn-onnx-venv\\Scripts\\python.exe");
  expect(onnx.marker).toBe("C:\\owned\\pn-onnx-venv\\narration-onnx-ready.json");
  expect(onnx.model).toBe(`C:\\owned\\lid-onnx\\codeswitch-spaeng-lid-lince\\${ONNX_MANIFEST.derivedFrom.revision}-onnx-fp32-a322d9809cd3`);
  expect(onnx.marker.endsWith("narration-ready.json")).toBe(false);
  for (const key of ["venv", "python", "marker", "model"] as const) {
    for (const other of ["venv", "python", "marker", "model"] as const) {
      const a = onnx[key].toLowerCase(), b = torch[other].toLowerCase();
      expect(a === b || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`)).toBe(false);
    }
  }
});

test("package pins are exact, ONNX-only and consistent with the manifest runtime", () => {
  expect(ONNX_PACKAGES).toEqual({ "kokoro-onnx": "0.6.1", onnxruntime: "1.31.0", soundfile: "0.14.0", numpy: "2.5.3", tokenizers: "0.23.3" });
  for (const heavy of ["torch", "transformers", "safetensors", "huggingface_hub"]) expect(ONNX_PACKAGES[heavy]).toBeUndefined();
  expect(onnxPackagesMatchRuntime(ONNX_MANIFEST)).toBe(true);
  for (const name of ["numpy", "onnxruntime", "tokenizers"] as const) {
    expect(ONNX_PACKAGES[name]!.startsWith(ONNX_MANIFEST.runtime[name])).toBe(true);
    // Shared pins agree with the torch layer so both environments resolve the same wheels.
    expect(ONNX_PACKAGES[name]).toBe(PN_PACKAGES[name]!);
  }
  const drift = realManifest(); drift.runtime.numpy = "2.5.4";
  expect(onnxPackagesMatchRuntime(drift)).toBe(false);
  drift.runtime.numpy = "2.5"; drift.runtime.onnxruntime = "1.3";
  expect(onnxPackagesMatchRuntime(drift)).toBe(false);
  expect(onnxPackagesMatchRuntime(ONNX_MANIFEST, { ...ONNX_PACKAGES, tokenizers: "0.23.4" })).toBe(false);
});

test("ready record resolves only with exact keys, packages and provenance", () => {
  const paths = narrationOnnxPaths("R"), ok = () => {};
  const resolve = (record: string, exists: (p: string) => boolean = () => true, assertPath = ok) =>
    resolveNarrationOnnxPython("R", exists, () => record, assertPath);
  expect(resolve(ONNX_READY_RECORD)).toBe(paths.python);
  expect(resolve("{}")).toBeUndefined();
  expect(resolve("not json")).toBeUndefined();
  expect(resolve(ONNX_READY_RECORD, p => p !== paths.python)).toBeUndefined();
  expect(resolve(ONNX_READY_RECORD, p => p !== paths.marker)).toBeUndefined();
  const mutate = (change: (r: any) => void) => { const r = JSON.parse(ONNX_READY_RECORD); change(r); return JSON.stringify(r); };
  for (const change of [
    (r: any) => { delete r.provenance; }, (r: any) => { r.provenance = "managed-environment-v1"; },
    (r: any) => { r.revision = "main"; }, (r: any) => { r.graphSha256 = "0".repeat(64); },
    (r: any) => { r.backend = "torch"; }, (r: any) => { r.schemaVersion = 2; }, (r: any) => { r.extra = true; },
    (r: any) => { r.packages.torch = "2.14.1+cpu"; }, (r: any) => { delete r.packages.numpy; },
    (r: any) => { r.packages.numpy = "2.5.2"; },
  ]) expect(resolve(mutate(change))).toBeUndefined();
  // The torch record must never satisfy the ONNX resolver.
  expect(resolve(JSON.stringify({ schemaVersion: 1, revision: ONNX_MANIFEST.derivedFrom.revision, packages: PN_PACKAGES, provenance: "managed-environment-v1" }))).toBeUndefined();
  expect(resolve(ONNX_READY_RECORD, () => true, () => { throw new Error("symlink"); })).toBeUndefined();
});

test("ready record rejects a real symlinked/junctioned environment directory", () => {
  const root = temp(), real = join(root, "real"), home = join(root, "home");
  mkdirSync(join(real, "Scripts"), { recursive: true }); mkdirSync(home);
  writeFileSync(join(real, "Scripts", "python.exe"), "");
  writeFileSync(join(real, "narration-onnx-ready.json"), ONNX_READY_RECORD);
  try { symlinkSync(real, join(home, "pn-onnx-venv"), "junction"); } catch { return; /* link creation unavailable */ }
  expect(resolveNarrationOnnxPython(home)).toBeUndefined();
  rmSync(join(home, "pn-onnx-venv"), { recursive: true, force: true });
  mkdirSync(join(home, "pn-onnx-venv", "Scripts"), { recursive: true });
  writeFileSync(join(home, "pn-onnx-venv", "Scripts", "python.exe"), "");
  writeFileSync(join(home, "pn-onnx-venv", "narration-onnx-ready.json"), ONNX_READY_RECORD);
  expect(resolveNarrationOnnxPython(home)).toBe(narrationOnnxPaths(home).python);
});

test("directory integrity accepts the exact tree and rejects missing, corrupt, extra and wrong-size entries", () => {
  const { source, manifest } = fixture();
  expect(() => assertOnnxLidDirectory(source, fileFingerprint, manifest)).not.toThrow();
  expect(() => assertOnnxLidDirectory(source, null, manifest)).not.toThrow();

  writeFileSync(join(source, "tokenizer", "vocab.txt"), "corrupt");
  expect(() => assertOnnxLidDirectory(source, fileFingerprint, manifest)).toThrow();
  expect(() => assertOnnxLidDirectory(source, null, manifest)).not.toThrow(); // structure only
  writeFileSync(join(source, "tokenizer", "vocab.txt"), `fixture-5-tokenizer/vocab.txt`);
  expect(() => assertOnnxLidDirectory(source, fileFingerprint, manifest)).not.toThrow();

  writeFileSync(join(source, "extra.txt"), "x");
  expect(() => assertOnnxLidDirectory(source, null, manifest)).toThrow();
  rmSync(join(source, "extra.txt"));
  writeFileSync(join(source, "tokenizer", "extra.json"), "x");
  expect(() => assertOnnxLidDirectory(source, null, manifest)).toThrow();
  rmSync(join(source, "tokenizer", "extra.json"));
  mkdirSync(join(source, "other"));
  expect(() => assertOnnxLidDirectory(source, null, manifest)).toThrow();
  rmSync(join(source, "other"), { recursive: true });

  rmSync(join(source, "tokenizer", "config.json"));
  expect(() => assertOnnxLidDirectory(source, null, manifest)).toThrow();
  expect(() => assertOnnxLidDirectory(join(source, "missing"), null, manifest)).toThrow();
});

test("directory integrity rejects a symlinked/junctioned tokenizer directory and a symlinked file", () => {
  const { root, source, manifest } = fixture();
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  for (const name of readdirSync(join(source, "tokenizer"))) writeFileSync(join(elsewhere, name), readFileSync(join(source, "tokenizer", name)));
  rmSync(join(source, "tokenizer"), { recursive: true });
  try { symlinkSync(elsewhere, join(source, "tokenizer"), "junction"); } catch { return; }
  expect(() => assertOnnxLidDirectory(source, null, manifest)).toThrow();
  rmSync(join(source, "tokenizer"), { recursive: true, force: true });
  mkdirSync(join(source, "tokenizer"));
  for (const name of readdirSync(elsewhere)) writeFileSync(join(source, "tokenizer", name), readFileSync(join(elsewhere, name)));
  expect(() => assertOnnxLidDirectory(source, fileFingerprint, manifest)).not.toThrow();
  rmSync(join(source, "model.onnx"));
  try { symlinkSync(join(elsewhere, "vocab.txt"), join(source, "model.onnx"), "file"); } catch { return; }
  expect(() => assertOnnxLidDirectory(source, null, manifest)).toThrow();
});

function partials(dir: string): string[] { return existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith(".partial")) : []; }

test("copy publishes a verified, byte-identical tree and leaves no partial", () => {
  const { root, source, manifest } = fixture();
  const dest = join(root, "managed", "lid-onnx", "model", "id");
  copyOnnxModelFromSource(source, dest, nodeOnnxCopyFs, manifest);
  expect(() => assertOnnxLidDirectory(dest, fileFingerprint, manifest)).not.toThrow();
  expect(partials(join(root, "managed", "lid-onnx", "model"))).toEqual([]);
  expect(readdirSync(join(root, "managed", "lid-onnx", "model"))).toEqual(["id"]);
  // Copy, not link: mutating the source later cannot change the published bytes.
  writeFileSync(join(source, "model.onnx"), "tampered after copy");
  expect(() => assertOnnxLidDirectory(dest, fileFingerprint, manifest)).not.toThrow();
  expect(readFileSync(join(dest, "model.onnx"), "utf8")).toBe(`fixture-0-model.onnx`);
});

test("a corrupt, missing, extra or symlinked source publishes nothing and leaves no partial", () => {
  const cases: Array<[string, (source: string) => void]> = [
    ["corrupt", s => writeFileSync(join(s, "tokenizer", "tokenizer.json"), "bad")],
    ["truncated", s => writeFileSync(join(s, "model.onnx"), "")],
    ["missing", s => rmSync(join(s, "tokenizer", "vocab.txt"))],
    ["extra", s => writeFileSync(join(s, "notes.txt"), "x")],
    ["extra-nested", s => writeFileSync(join(s, "tokenizer", "added_tokens.json"), "{}")],
  ];
  for (const [label, damage] of cases) {
    const { root, source, manifest } = fixture();
    damage(source);
    const parent = join(root, "managed"), dest = join(parent, "id");
    mkdirSync(parent);
    expect(() => copyOnnxModelFromSource(source, dest, nodeOnnxCopyFs, manifest), label).toThrow();
    expect(existsSync(dest), label).toBe(false);
    expect(readdirSync(parent), label).toEqual([]);
  }
  const { root, source, manifest } = fixture();
  const link = join(root, "linked-source");
  try { symlinkSync(source, link, "junction"); } catch { return; }
  expect(() => copyOnnxModelFromSource(link, join(root, "out"), nodeOnnxCopyFs, manifest)).toThrow();
  expect(existsSync(join(root, "out"))).toBe(false);
});

test("an existing destination is never overwritten, even when empty or valid", () => {
  const { root, source, manifest } = fixture();
  const dest = join(root, "managed", "id");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "keep.txt"), "mine");
  expect(() => copyOnnxModelFromSource(source, dest, nodeOnnxCopyFs, manifest)).toThrow();
  expect(readdirSync(dest)).toEqual(["keep.txt"]);
  expect(partials(join(root, "managed"))).toEqual([]);

  const empty = join(root, "managed", "empty");
  mkdirSync(empty);
  expect(() => copyOnnxModelFromSource(source, empty, nodeOnnxCopyFs, manifest)).toThrow();
  expect(readdirSync(empty)).toEqual([]);
});

test("the staged copy is re-verified and removed when the source changes mid-copy", () => {
  const { root, source, manifest } = fixture();
  const dest = join(root, "managed", "id");
  const deps: OnnxCopyDeps = { ...nodeOnnxCopyFs, copyFile: (from, to) => {
    nodeOnnxCopyFs.copyFile(from, to);
    if (from.endsWith("vocab.txt")) writeFileSync(to, "flipped bits");
  } };
  expect(() => copyOnnxModelFromSource(source, dest, deps, manifest)).toThrow(/staged integrity/);
  expect(existsSync(dest)).toBe(false);
  expect(partials(join(root, "managed"))).toEqual([]);
});

test("the partial is removed when publishing fails, and a lost publish race is not an overwrite", () => {
  const { root, source, manifest } = fixture();
  const dest = join(root, "managed", "id");
  const removed: string[] = [];
  const deps: OnnxCopyDeps = {
    ...nodeOnnxCopyFs,
    publish: () => { throw new Error("publish refused"); },
    remove: path => { removed.push(path); nodeOnnxCopyFs.remove(path); },
  };
  expect(() => copyOnnxModelFromSource(source, dest, deps, manifest)).toThrow("publish refused");
  expect(removed).toHaveLength(1);
  expect(removed[0]!.startsWith(`${dest}.`) && removed[0]!.endsWith(".partial")).toBe(true);
  expect(existsSync(removed[0]!)).toBe(false);

  const raced: OnnxCopyDeps = { ...nodeOnnxCopyFs, publish: (from, to) => {
    mkdirSync(to, { recursive: true }); writeFileSync(join(to, "winner.txt"), "other");
    nodeOnnxCopyFs.publish(from, to);
  } };
  expect(() => copyOnnxModelFromSource(source, dest, raced, manifest)).toThrow();
  expect(readdirSync(dest)).toEqual(["winner.txt"]);
  expect(partials(join(root, "managed"))).toEqual([]);
});

test("verification happens before anything is staged", () => {
  const { root, source, manifest } = fixture();
  writeFileSync(join(source, "model.onnx"), "wrong");
  const calls: string[] = [];
  const deps: OnnxCopyDeps = { ...nodeOnnxCopyFs, mkdir: p => { calls.push(`mkdir ${p}`); nodeOnnxCopyFs.mkdir(p); },
    copyFile: (a, b) => { calls.push(`copy ${a}`); nodeOnnxCopyFs.copyFile(a, b); } };
  expect(() => copyOnnxModelFromSource(source, join(root, "managed", "id"), deps, manifest)).toThrow(/source integrity/);
  expect(calls).toEqual([]);
});

test("hard-linked sources are copied, never linked", () => {
  const { root, source, manifest } = fixture();
  const dest = join(root, "managed", "id");
  copyOnnxModelFromSource(source, dest, nodeOnnxCopyFs, manifest);
  const probe = join(root, "probe");
  linkSync(join(dest, "model.onnx"), probe);
  // A published file linked to the source would share content; verify independence by rewriting the source.
  writeFileSync(join(source, "model.onnx"), "x");
  expect(readFileSync(join(dest, "model.onnx"), "utf8")).toBe("fixture-0-model.onnx");
});

const REAL_ASSETS = process.env.OPEN_VOX_TEST_ONNX_ASSETS ?? join(tmpdir(), "open-vox-reference-assets", "assets");
test.skipIf(!existsSync(join(REAL_ASSETS, "model.onnx")))(
  "real reference assets match the bundled manifest (skipped when absent)", () => {
    const stubbedManifest: OnnxLidManifest = ONNX_MANIFEST; // ~0.5 s: hashes the real 709 MB graph once
    // Reference directory may carry an experimental manifest beside the pinned set; compare only the pinned files.
    for (const file of stubbedManifest.files) {
      expect(fileFingerprint(join(REAL_ASSETS, ...file.filename.split("/")))).toEqual({ bytes: file.bytes, sha256: file.sha256 });
    }
  }, 120_000);

test("TS and Python validators agree on constants and on accept/reject for the same manifests", () => {
  const testAppHome = process.env.OPEN_VOX_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "open-vox");
  const python = process.env.OPEN_VOX_TEST_PYTHON ?? join(testAppHome, "pn-venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!existsSync(python)) return;
  const cases: any[] = [realManifest()];
  const mut = (change: (m: any) => void) => { const m = realManifest(); change(m); cases.push(m); };
  mut(m => { m.extra = 1; }); mut(m => { m.backend = "x"; }); mut(m => { m.derivedFrom.revision = "main"; });
  mut(m => { m.runtime.numpy = "latest"; }); mut(m => { m.runtime.torch = "2.0"; }); mut(m => { m.runtime.onnxruntime = "1.31.0.1"; });
  mut(m => { m.files[0].sha256 = "g".repeat(64); }); mut(m => { m.files[0].bytes = 0; });
  mut(m => { m.files[0].bytes = true; }); mut(m => { m.files[2].filename = "tokenizer/other.json"; }); mut(m => { m.files.pop(); });
  const script = [
    "import sys, json", "sys.path.insert(0, 'scripts')", "import narration_lid_onnx as m",
    "cases = json.load(sys.stdin)", "out = []",
    "for c in cases:", "    try: m.validate_manifest(c); out.append(True)", "    except Exception: out.append(False)",
    "print(json.dumps({'files': list(m.FILES), 'graph': m.BACKEND['graphSha256'], 'tok': m.BACKEND['tokenizerSha256'], 'ok': out}))",
  ].join("\n");
  const run = Bun.spawnSync([python, "-c", script], { cwd: join(import.meta.dir, ".."), stdin: new TextEncoder().encode(JSON.stringify(cases)), env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(run.exitCode).toBe(0);
  const result = JSON.parse(run.stdout.toString());
  expect(result.files).toEqual([...ONNX_FILENAMES]);
  expect(result.graph).toBe(ONNX_MANIFEST.files[0]!.sha256);
  expect(result.tok).toBe(ONNX_MANIFEST.files.find(f => f.filename === "tokenizer/tokenizer.json")!.sha256);
  const ts = cases.map(c => { try { validateOnnxManifest(c); return true; } catch { return false; } });
  expect(ts).toEqual(result.ok);
  expect(ts[0]).toBe(true);
  expect(ts.slice(1).every(v => v === false)).toBe(true);
});
