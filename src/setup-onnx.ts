import { win32 } from "node:path";
import { KOKORO_FILES, PN_ENV_PROBE, nodeNarrationFs } from "./setup";
import {
  ONNX_BYTES, ONNX_PACKAGES, ONNX_READY_RECORD, assertNoSymlinkAncestors, assertOnnxLidDirectory,
  copyOnnxModelFromSource, narrationOnnxPaths,
} from "./narration-onnx-assets";

/**
 * Provenance/version/CPU probe for the dedicated ONNX environment. Same hardening as the Torch
 * probe (identity first, every origin/distribution root/exact version BEFORE any import, then a
 * re-check of what was actually imported), but it never mentions or imports torch/transformers.
 * No model construction, no inference, no downloads.
 */
export const ONNX_PROBE = `${PN_ENV_PROBE}import importlib, importlib.metadata as m
expected = ${JSON.stringify(ONNX_PACKAGES)}
names = {name: name.replace('-', '_') for name in expected}
# Preflight EVERY required origin/distribution before executing any required import.
for package, version in expected.items():
    check_spec(importlib.util.find_spec(names[package]), 'foreign-or-missing-managed-package-origin')
    distribution = m.distribution(package)
    require(concrete_inside(str(distribution.locate_file(''))), 'foreign-managed-distribution-root')
    require(distribution.version == version, 'incompatible-managed-package-version')
loaded = {}
for package, name in names.items():
    module = importlib.import_module(name)
    require(concrete_inside(getattr(module, '__file__', None)), 'foreign-or-missing-imported-package-file')
    check_spec(getattr(module, '__spec__', None), 'foreign-imported-package-origin')
    require(all(concrete_inside(location) for location in getattr(module, '__path__', [])), 'foreign-imported-package-path')
    distribution = m.distribution(package)
    require(concrete_inside(str(distribution.locate_file(''))) and distribution.version == expected[package], 'changed-managed-distribution')
    loaded[name] = module
providers = loaded['onnxruntime'].get_available_providers()
require(isinstance(providers, (list, tuple)) and 'CPUExecutionProvider' in providers, 'missing-cpu-execution-provider')
`;

export function onnxProbeArgs(expectedVenv: string, basic = false): string[] {
  return ["-B", "-c", basic ? PN_ENV_PROBE : ONNX_PROBE, win32.resolve(expectedVenv)];
}

export type NarrationOnnxSetupDeps = {
  home: string;
  systemPython: string;
  /** Required local directory with model.onnx and tokenizer/*; verified by size and sha256. */
  lidSource: string | undefined;
  exists: (path: string) => boolean;
  run: (cmd: string, args: string[]) => Promise<number>;
  log: (line: string) => void;
  assertManagedPath: (path: string) => void;
  /** Full source check (exact layout, no links, size + sha256). Throws; must not write. */
  validateSource: (directory: string) => void;
  /** Full managed model check (exact layout, no links, size + sha256). Throws. */
  validateModelDirectory: (directory: string) => void;
  /** Verified staged copy with exclusive publication. Must leave the destination absent on failure. */
  copyModel: (source: string, dest: string) => void;
  remove: (path: string) => void;
  writeReady: (path: string, record: string) => void;
};

async function must(deps: NarrationOnnxSetupDeps, cmd: string, args: string[]): Promise<void> {
  const code = await deps.run(cmd, args);
  if (code !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed with exit code ${code}`);
}

/**
 * Explicit, local-source provisioning of the standalone ONNX backend. It never touches the Torch
 * environment, model directory or marker, never downloads a model, and does not select the backend.
 */
export async function setupNarrationOnnx(deps: NarrationOnnxSetupDeps): Promise<void> {
  const requested = deps.lidSource?.trim();
  if (!requested || requested.startsWith("-") || !win32.isAbsolute(requested)) {
    throw new Error("An absolute local --lid-source <dir> with model.onnx and tokenizer/* is required: open-vox setup narration-onnx --lid-source <dir>");
  }
  const source = win32.resolve(requested);
  const paths = narrationOnnxPaths(deps.home);
  if (!KOKORO_FILES.every(file => deps.exists(win32.join(deps.home, "kokoro", file.name)))) {
    throw new Error("Existing Kokoro model/voices are required; run: open-vox setup kokoro");
  }
  deps.assertManagedPath(paths.venv);
  deps.assertManagedPath(win32.dirname(paths.model));
  deps.assertManagedPath(paths.model);
  // Reject a bad source or a corrupt existing model before any environment or marker change.
  deps.validateSource(source);
  const reuseModel = deps.exists(paths.model);
  if (reuseModel) {
    try { deps.validateModelDirectory(paths.model); }
    catch { throw new Error("Existing ONNX model directory failed integrity; preserved for manual inspection"); }
  }
  deps.log(`Standalone ONNX narration backend (inactive): ${ONNX_BYTES} model bytes (~709 MB) copied from a local source, plus a small isolated CPU environment without torch.`);
  if (!deps.exists(paths.python)) await must(deps, deps.systemPython, ["-m", "venv", paths.venv]);
  // Reject a hijacked existing launcher before pip or even invalidating its old hint.
  await must(deps, paths.python, onnxProbeArgs(paths.venv, true));
  if (deps.exists(paths.marker)) deps.remove(paths.marker);
  await must(deps, paths.python, ["-m", "pip", "--isolated", "install", "--disable-pip-version-check", "--no-input", "--no-cache-dir",
    "--only-binary=:all:", "--keyring-provider", "disabled", "--extra-index-url", "", "--index-url", "https://pypi.org/simple",
    ...Object.entries(ONNX_PACKAGES).map(([name, version]) => `${name}==${version}`)]);
  await must(deps, paths.python, onnxProbeArgs(paths.venv));
  if (!reuseModel) {
    deps.log("Copying and verifying the local ONNX model...");
    deps.copyModel(source, paths.model);
  }
  // Recheck the published directory before the dispatch hint exists.
  deps.validateModelDirectory(paths.model);
  deps.writeReady(paths.marker, ONNX_READY_RECORD);
  deps.log("ONNX narration assets/dependencies are ready but NOT active: backend selection is a separate step. Run: open-vox doctor");
}

export const nodeNarrationOnnxFs = {
  assertManagedPath: assertNoSymlinkAncestors,
  validateSource: (directory: string) => { assertOnnxLidDirectory(directory); },
  validateModelDirectory: (directory: string) => { assertOnnxLidDirectory(directory); },
  copyModel: (source: string, dest: string) => { copyOnnxModelFromSource(source, dest); },
  remove: nodeNarrationFs.remove,
  writeReady: nodeNarrationFs.writeReady,
};
