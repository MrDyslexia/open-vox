import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { PN_ENV_PROBE, narrationProcessEnv } from "../src/setup";
import { narrationPaths } from "../src/narration-assets";
import { ONNX_MANIFEST, ONNX_PACKAGES, ONNX_READY_RECORD, copyOnnxModelFromSource, narrationOnnxPaths, type OnnxCopyDeps } from "../src/narration-onnx-assets";
import { ONNX_PROBE, nodeNarrationOnnxFs, onnxProbeArgs, setupNarrationOnnx, type NarrationOnnxSetupDeps } from "../src/setup-onnx";

const testAppHome = process.env.OPEN_VOX_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "open-vox");
const testPython = process.env.OPEN_VOX_TEST_PYTHON ?? join(testAppHome, "kokoro-venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

/** Executes only the exported probe with every import mocked; nothing real is imported. */
function probeFixture(options: { prefix?: string; outside?: string; actualOutside?: string; distributionOutside?: string; basePrefix?: string; executable?: string; importedSpecOutside?: string; namespace?: string; version?: string; providers?: string[]; basic?: boolean; torchBroken?: boolean } = {}) {
  const expected = "C:/managed/pn-onnx-venv";
  const script = `import sys, os, json, types, ntpath, importlib.util, importlib.metadata, importlib
from unittest.mock import patch
options = json.loads(sys.stdin.read())
expected = ${JSON.stringify(expected)}
packages = ${JSON.stringify(ONNX_PACKAGES)}
path = ntpath
module_names = {name: name.replace('-', '_') for name in packages}
def origin(name):
    root = 'C:/foreign/site-packages' if name == options.get('outside') or options.get('prefix') else expected + '/site-packages'
    return root + '/' + name + '/__init__.py'
specs = {name: types.SimpleNamespace(origin=origin(name), submodule_search_locations=[path.dirname(origin(name))]) for name in module_names.values()}
specs['pip'] = types.SimpleNamespace(origin=expected + '/site-packages/pip/__init__.py', submodule_search_locations=None)
if options.get('namespace'):
    specs[options['namespace']].origin = None
modules = {name: types.ModuleType(name) for name in module_names.values()}
for name, module in modules.items():
    module.__file__ = origin(name)
    module.__spec__ = specs[name]
    if name == options.get('actualOutside'):
        module.__file__ = 'C:/foreign/site-packages/' + name + '/__init__.py'
    if name == options.get('importedSpecOutside'):
        module.__spec__ = types.SimpleNamespace(origin='C:/foreign/site-packages/' + name + '/__init__.py', submodule_search_locations=None)
providers = options.get('providers', ['CPUExecutionProvider'])
modules['onnxruntime'].get_available_providers = lambda: providers
def distribution(name):
    root = 'C:/foreign/site-packages' if name == options.get('distributionOutside') or options.get('prefix') else expected + '/site-packages'
    return types.SimpleNamespace(version=options.get('version') if name == 'numpy' and options.get('version') else packages[name], locate_file=lambda unused: root)
imports = []
spec_checks = []
def find_spec(name):
    spec_checks.append(name)
    return specs[name]
def load(name):
    imports.append(name)
    if name in ('torch', 'transformers'):
        raise AssertionError('torch-or-transformers-imported')
    return modules[name]
executable = options.get('executable') or expected + '/Scripts/python.exe'
with patch.object(sys, 'prefix', options.get('prefix', expected)), patch.object(sys, 'base_prefix', options.get('basePrefix', '/base/python')), \
     patch.object(sys, 'executable', executable), patch.object(sys, 'argv', ['probe', expected]), \
     patch.object(os, 'name', 'nt'), patch.object(os, 'path', path), \
     patch('importlib.util.find_spec', side_effect=find_spec), \
     patch('importlib.metadata.distribution', side_effect=distribution), patch('importlib.import_module', side_effect=load):
    try:
        exec(${JSON.stringify(options.basic ? PN_ENV_PROBE : ONNX_PROBE)}, {})
        result = {'ok': True}
    except Exception as error:
        result = {'ok': False, 'code': str(error)}
result['imports'] = imports
result['specs'] = spec_checks
print(json.dumps(result))
`;
  const child = spawnSync(testPython, ["-B", "-c", script], {
    input: JSON.stringify(options), encoding: "utf8", env: narrationProcessEnv(), timeout: 10000,
  });
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout) as { ok: boolean; code?: string; imports: string[]; specs: string[] };
}

test("ONNX probe text never mentions torch or transformers and requires the CPU provider", () => {
  expect(/torch|transformers|safetensors|huggingface/i.test(ONNX_PROBE)).toBe(false);
  expect(ONNX_PROBE).toContain("CPUExecutionProvider");
  expect(onnxProbeArgs("C:/x/pn-onnx-venv")).toEqual(["-B", "-c", ONNX_PROBE, win32.resolve("C:/x/pn-onnx-venv")]);
  expect(onnxProbeArgs("C:/x/pn-onnx-venv", true)[2]).toBe(PN_ENV_PROBE);
});
test("ONNX probe accepts isolated origins, imports exactly the five packages and never torch", () => {
  const result = probeFixture();
  expect(result.ok).toBe(true);
  expect(result.imports.sort()).toEqual(["kokoro_onnx", "numpy", "onnxruntime", "soundfile", "tokenizers"]);
});
test("ONNX probe rejects a foreign interpreter before any package import", () => {
  const result = probeFixture({ prefix: "C:/foreign/kokoro-venv" });
  expect(result.ok).toBe(false); expect(result.code).toBe("foreign-or-nonvirtual-managed-interpreter");
  expect(result.imports).toEqual([]);
  expect(probeFixture({ basePrefix: "C:/managed/pn-onnx-venv" }).ok).toBe(false);
  expect(probeFixture({ executable: "C:/foreign/Scripts/python.exe" }).ok).toBe(false);
});
test("ONNX probe preflights every origin, distribution root and version before importing", () => {
  const spec = probeFixture({ outside: "numpy" });
  expect(spec.code).toBe("foreign-or-missing-managed-package-origin"); expect(spec.imports).toEqual([]);
  const distribution = probeFixture({ distributionOutside: "tokenizers" });
  expect(distribution.code).toBe("foreign-managed-distribution-root"); expect(distribution.imports).toEqual([]);
  const version = probeFixture({ version: "0.0.0" });
  expect(version.code).toBe("incompatible-managed-package-version"); expect(version.imports).toEqual([]);
  const namespace = probeFixture({ namespace: "onnxruntime" });
  expect(namespace.code).toBe("foreign-or-missing-managed-package-origin"); expect(namespace.imports).toEqual([]);
});
test("ONNX probe rechecks the actually imported module origin", () => {
  expect(probeFixture({ actualOutside: "soundfile" }).code).toBe("foreign-or-missing-imported-package-file");
  expect(probeFixture({ importedSpecOutside: "kokoro_onnx" }).code).toBe("foreign-imported-package-origin");
});
test("ONNX probe fails closed without the CPU execution provider", () => {
  expect(probeFixture({ providers: ["CUDAExecutionProvider"] }).code).toBe("missing-cpu-execution-provider");
  expect(probeFixture({ providers: [] }).ok).toBe(false);
  expect(probeFixture({ providers: ["CUDAExecutionProvider", "CPUExecutionProvider"] }).ok).toBe(true);
});
test("basic identity probe stays dependency-free", () => {
  const result = probeFixture({ basic: true, outside: "numpy", version: "wrong" });
  expect(result.ok).toBe(true); expect(result.imports).toEqual([]);
});

const SOURCE = "D:\\src\\lid-onnx";
function fixture() {
  const paths = narrationOnnxPaths("R"), torch = narrationPaths("R");
  const files = new Map<string, string>([["R\\kokoro\\kokoro-v1.0.onnx", "user model"], ["R\\kokoro\\voices-v1.0.bin", "user voices"]]);
  const calls: { cmd: string; args: string[] }[] = [], events: string[] = [];
  let exit: (args: string[]) => number = () => 0;
  const deps: NarrationOnnxSetupDeps = {
    home: "R", systemPython: "system-python", lidSource: SOURCE, exists: p => files.has(p), log() {},
    run: async (cmd, args) => { calls.push({ cmd, args }); events.push(`run:${args.includes("pip") ? "pip" : args.includes("-c") ? (args[2] === PN_ENV_PROBE ? "basic" : "probe") : "venv"}`); const code = exit(args); if (code === 0) files.set(paths.python, "python"); return code; },
    assertManagedPath() {}, validateSource() { events.push("validate-source"); },
    validateModelDirectory() { events.push("validate-model"); },
    copyModel(_from, to) { events.push("copy"); files.set(to, "dir"); },
    remove: p => { events.push(`remove:${p}`); files.delete(p); },
    writeReady: (p, record) => { events.push("ready"); files.set(p, record); },
  };
  return { deps, paths, torch, files, calls, events, exit: (fn: (args: string[]) => number) => { exit = fn; } };
}

test("provisioning order and arguments: venv, identity probe, one anonymous binary-only pip, full probe, copy, recheck, marker last", async () => {
  const f = fixture();
  await setupNarrationOnnx(f.deps);
  expect(f.calls).toHaveLength(4);
  expect(f.calls[0]).toEqual({ cmd: "system-python", args: ["-m", "venv", f.paths.venv] });
  expect(f.calls[1]).toEqual({ cmd: f.paths.python, args: onnxProbeArgs(f.paths.venv, true) });
  const pip = f.calls[2]!.args;
  expect(f.calls[2]!.cmd).toBe(f.paths.python);
  expect(pip).toEqual(expect.arrayContaining(["-m", "pip", "--isolated", "install", "--only-binary=:all:", "--no-input", "--no-cache-dir", "--index-url", "https://pypi.org/simple"]));
  for (const [name, version] of Object.entries(ONNX_PACKAGES)) expect(pip).toContain(`${name}==${version}`);
  expect(pip.filter(a => a.includes("=="))).toHaveLength(Object.keys(ONNX_PACKAGES).length);
  expect(pip.join(" ")).not.toMatch(/torch|transformers|safetensors|huggingface|download\.pytorch/i);
  expect(pip.filter(a => a === "--index-url")).toHaveLength(1);
  expect(f.calls[3]).toEqual({ cmd: f.paths.python, args: onnxProbeArgs(f.paths.venv) });
  expect(f.events).toEqual(["validate-source", "run:venv", "run:basic", "run:pip", "run:probe", "copy", "validate-model", "ready"]);
  expect(f.files.get(f.paths.marker)).toBe(ONNX_READY_RECORD);
});
test("an old ONNX marker is deleted after the identity probe and before pip", async () => {
  const f = fixture(); f.files.set(f.paths.python, "python"); f.files.set(f.paths.marker, ONNX_READY_RECORD);
  await setupNarrationOnnx(f.deps);
  expect(f.events).toEqual(["validate-source", "run:basic", `remove:${f.paths.marker}`, "run:pip", "run:probe", "copy", "validate-model", "ready"]);
  expect(f.calls.some(c => c.args.includes("venv"))).toBe(false);
});
test("torch environment, torch model, kokoro files and torch marker are never touched", async () => {
  const f = fixture(); f.files.set(f.torch.marker, "torch marker"); f.files.set(f.torch.python, "torch python"); f.files.set(f.torch.model, "torch model");
  await setupNarrationOnnx(f.deps);
  expect(f.files.get(f.torch.marker)).toBe("torch marker");
  expect(f.files.get(f.torch.python)).toBe("torch python");
  expect(f.files.get(f.torch.model)).toBe("torch model");
  expect(f.files.get("R\\kokoro\\kokoro-v1.0.onnx")).toBe("user model");
  expect(f.files.get("R\\kokoro\\voices-v1.0.bin")).toBe("user voices");
  expect(f.events.some(e => e.startsWith("remove:") && e.includes("pn-venv"))).toBe(false);
  expect(JSON.stringify(f.calls)).not.toContain("pn-venv");
  expect(f.paths.venv).not.toBe(f.torch.venv); expect(f.paths.model).not.toBe(f.torch.model);
});
test("absent Kokoro instructs existing setup without writing", async () => {
  const f = fixture(); f.files.clear();
  await expect(setupNarrationOnnx(f.deps)).rejects.toThrow("setup kokoro");
  expect(f.calls).toHaveLength(0); expect(f.events).toEqual([]);
});
test("a missing, empty, flag-like or relative --lid-source is rejected before anything is written", async () => {
  for (const lidSource of [undefined, "", "   ", "--x", "relative\\dir"]) {
    const f = fixture(); (f.deps as { lidSource?: string }).lidSource = lidSource;
    await expect(setupNarrationOnnx(f.deps)).rejects.toThrow("--lid-source");
    expect(f.calls).toHaveLength(0); expect(f.events).toEqual([]);
  }
});
test("an invalid source writes nothing, leaves no environment and does not remove an existing marker", async () => {
  const f = fixture(); f.files.set(f.paths.marker, ONNX_READY_RECORD); const before = new Map(f.files);
  f.deps.validateSource = () => { throw new Error("ONNX LID source integrity failure: model.onnx"); };
  await expect(setupNarrationOnnx(f.deps)).rejects.toThrow("source integrity");
  expect(f.calls).toHaveLength(0); expect(f.events).toEqual([]);
  expect(f.files).toEqual(before);
});
test("a foreign existing interpreter is rejected before pip and keeps the old hint", async () => {
  const f = fixture(); f.files.set(f.paths.python, "foreign"); f.files.set(f.paths.marker, ONNX_READY_RECORD);
  f.exit(args => args[2] === PN_ENV_PROBE ? 1 : 0);
  await expect(setupNarrationOnnx(f.deps)).rejects.toThrow();
  expect(f.calls.some(c => c.args.includes("pip"))).toBe(false);
  expect(f.files.get(f.paths.marker)).toBe(ONNX_READY_RECORD);
  expect(f.events).not.toContain("copy");
});
test("a failed pip leaves the old marker deleted and copies nothing", async () => {
  const f = fixture(); f.files.set(f.paths.python, "python"); f.files.set(f.paths.marker, ONNX_READY_RECORD);
  f.exit(args => args.includes("pip") ? 1 : 0);
  await expect(setupNarrationOnnx(f.deps)).rejects.toThrow();
  expect(f.files.has(f.paths.marker)).toBe(false); expect(f.events).not.toContain("copy");
});
test("a failed full probe (wrong version, foreign origin or no CPU provider) copies nothing and writes no marker", async () => {
  const f = fixture();
  f.exit(args => args[2] === ONNX_PROBE ? 1 : 0);
  await expect(setupNarrationOnnx(f.deps)).rejects.toThrow();
  expect(f.events).not.toContain("copy"); expect(f.files.has(f.paths.marker)).toBe(false); expect(f.files.has(f.paths.model)).toBe(false);
});
test("a failed copy with the real copier cleans its partial, publishes nothing and writes no marker", async () => {
  const f = fixture(); f.files.set(f.paths.marker, ONNX_READY_RECORD);
  const staged: string[] = [], removed: string[] = [];
  const copyDeps: OnnxCopyDeps = {
    fingerprint: p => { const file = ONNX_MANIFEST.files.find(x => p.endsWith(x.filename.replace("/", "\\")))!; return { bytes: file.bytes, sha256: p.includes(".partial") ? "0".repeat(64) : file.sha256 }; },
    assertTree() {}, assertManagedPath() {}, exists: p => f.files.has(p), mkdir: p => { staged.push(p); },
    copyFile: (_from, to) => { staged.push(to); }, publish: () => { throw new Error("must not publish"); }, remove: p => { removed.push(p); },
  };
  f.deps.copyModel = (from, to) => copyOnnxModelFromSource(from, to, copyDeps);
  await expect(setupNarrationOnnx(f.deps)).rejects.toThrow("staged integrity");
  expect(removed).toHaveLength(1); expect(removed[0]).toContain(".partial");
  expect(f.files.has(f.paths.model)).toBe(false); expect(f.files.has(f.paths.marker)).toBe(false);
});
test("the marker is written only after the post-copy integrity recheck passes", async () => {
  const f = fixture();
  let calls = 0;
  f.deps.validateModelDirectory = () => { calls++; throw new Error("ONNX LID integrity failure: model.onnx"); };
  await expect(setupNarrationOnnx(f.deps)).rejects.toThrow("integrity");
  expect(calls).toBe(1); expect(f.events).not.toContain("ready"); expect(f.files.has(f.paths.marker)).toBe(false);
});
test("an existing invalid model directory is preserved: no environment work, no copy", async () => {
  const f = fixture(); f.files.set(f.paths.model, "dir");
  f.deps.validateModelDirectory = () => { throw new Error("bad"); };
  await expect(setupNarrationOnnx(f.deps)).rejects.toThrow("preserved for manual inspection");
  expect(f.calls).toHaveLength(0); expect(f.events).not.toContain("copy"); expect(f.files.get(f.paths.model)).toBe("dir");
});
test("an existing valid model directory is reused without copying", async () => {
  const f = fixture(); f.files.set(f.paths.model, "dir");
  await setupNarrationOnnx(f.deps);
  expect(f.events).not.toContain("copy"); expect(f.files.get(f.paths.marker)).toBe(ONNX_READY_RECORD);
});
test("unsafe managed paths stop before any installer runs", async () => {
  const f = fixture(); f.deps.assertManagedPath = () => { throw new Error("unsafe"); };
  await expect(setupNarrationOnnx(f.deps)).rejects.toThrow("unsafe");
  expect(f.calls).toHaveLength(0); expect(f.events).toEqual([]);
});
test("node ONNX filesystem helpers reject an empty temp source and never create anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "ov-onnx-src-"));
  try {
    expect(() => nodeNarrationOnnxFs.validateSource(dir)).toThrow();
    expect(() => nodeNarrationOnnxFs.validateSource(join(dir, "missing"))).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
