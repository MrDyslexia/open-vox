import { existsSync, mkdirSync, statfsSync } from "node:fs";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { assertOnnxLidDirectory, assertNoSymlinkAncestors, narrationOnnxPaths } from "./narration-onnx-assets";
import { GPU_LOCK, validateGpuLock, gpuPaths } from "./gpu-runtime";
import { nodeNarrationRun } from "./setup";
export { GPU_LOCK, validateGpuLock } from "./gpu-runtime";

export const GPU_PROBE_PATH = fileURLToPath(new URL("../scripts/gpu_runtime_probe.py", import.meta.url));
export const GPU_LOCK_PATH = fileURLToPath(new URL("../resources/runtime-cuda13-windows.json", import.meta.url));
export const GPU_FREE_BYTES = 12 * 1024 ** 3;
/** pip --isolated alone does not suppress Requests' registry proxies/netrc.
 * Disable ambient HTTP state in the child session as well as pip configuration.
 */
export const GPU_PIP_BOOTSTRAP = `import os,sys
os.environ['PIP_CONFIG_FILE'] = os.devnull
from urllib.parse import urlsplit
from pip._internal.network.session import PipSession
original_init, original_send = PipSession.__init__, PipSession.send
class AnonymousAuth:
    def __call__(self,request):
        for name in ('Authorization','Proxy-Authorization','Cookie'):
            request.headers.pop(name,None)
        return request
def initialize(self,*args,**kwargs):
    original_init(self,*args,**kwargs)
    self.trust_env = False
    self.auth = AnonymousAuth()
    self.proxies.clear()
def send(self,request,**kwargs):
    url = urlsplit(request.url)
    if url.scheme != 'https' or url.hostname not in ('pypi.org','files.pythonhosted.org') or url.username or url.password:
        raise RuntimeError('unsafe-public-wheel-request')
    AnonymousAuth()(request)
    kwargs['proxies'] = {}
    return original_send(self,request,**kwargs)
PipSession.__init__, PipSession.send = initialize, send
from pip._internal.cli.main import main
sys.exit(main(sys.argv[1:]))
`;
export type GpuSetupDeps = {
  home: string; systemPython: string; platform: string;
  exists: (path: string) => boolean; assertPath: (path: string) => void;
  freeBytes: () => number; reserve: (path: string) => void; validateAssets: () => void;
  run: (cmd: string, args: string[]) => Promise<number>; log: (line: string) => void;
};

/** New environments only. Never repair, delete, rename, reuse or activate an existing destination. */
export async function setupGpu(deps: GpuSetupDeps): Promise<void> {
  validateGpuLock(GPU_LOCK);
  if (deps.platform !== "win32" || !win32.isAbsolute(deps.home) || deps.home.startsWith("\\\\")
      || win32.resolve(deps.home) === win32.parse(deps.home).root) throw Error("CUDA13 requires a local absolute Windows app home");
  deps.assertPath(deps.home);
  const paths = (["lid", "kokoro"] as const).map(role => ({ role, ...gpuPaths(deps.home, role) }));
  for (const p of paths) {
    deps.assertPath(p.venv);
    if (deps.exists(p.venv)) throw Error("GPU destination already exists; preserved for manual inspection");
  }
  if (deps.freeBytes() < GPU_FREE_BYTES) throw Error("CUDA13 setup requires at least 12 GiB free before provisioning");
  deps.validateAssets();
  const must = async (cmd: string, args: string[]) => {
    if (win32.isAbsolute(cmd)) deps.assertPath(cmd);
    if (await deps.run(cmd, args) !== 0) throw Error("CUDA13 setup failed; CPU environments and partial GPU destinations were preserved");
  };
  // Validate the base before creating either venv. No network or model imports.
  await must(deps.systemPython, ["-I", "-B", "-c", "import sys,struct,sysconfig;sys.exit(0 if sys.platform=='win32' and sys.version_info[:2]==(3,13) and struct.calcsize('P')==8 and sysconfig.get_platform()=='win-amd64' and not sysconfig.get_config_var('Py_GIL_DISABLED') else 1)"]);
  for (const p of paths) deps.reserve(p.venv);
  deps.log("Creating two isolated CUDA13 environments (~2.64 GB wheel transfer); no model downloads or activation.");
  for (const p of paths) {
    deps.assertPath(p.venv);
    await must(deps.systemPython, ["-I", "-B", "-m", "venv", p.venv]);
    await must(p.python, ["-I", "-B", GPU_PROBE_PATH, "--root", p.venv, "--role", p.role, "--basic"]);
    const wheels = GPU_LOCK.wheels.filter(w => p.role === "lid" || w.role === "common");
    await must(p.python, ["-I", "-B", "-c", GPU_PIP_BOOTSTRAP, "--isolated", "install", "--disable-pip-version-check", "--no-input",
      "--no-cache-dir", "--only-binary=:all:", "--no-deps", "--require-hashes", "--keyring-provider", "disabled",
      "--index-url", "https://pypi.org/simple", "--extra-index-url", "",
      ...wheels.map(w => `${w.url}#sha256=${w.sha256}`)]);
    await must(p.python, ["-I", "-B", GPU_PROBE_PATH, "--root", p.venv, "--role", p.role, "--publish"]);
  }
  deps.log("GPU dependencies ready, not inference-qualified or active. Run offline qualification in BOTH new environments.");
}

export async function nodeSetupGpu(home: string, systemPython: string, log: (line: string) => void): Promise<void> {
  const temp = win32.join(process.env.LOCALAPPDATA ?? "", "Temp", "opencode");
  return setupGpu({ home, systemPython, log, platform: process.platform, exists: existsSync,
    assertPath: assertNoSymlinkAncestors,
    freeBytes: () => { const s = statfsSync(home); return s.bavail * s.bsize; },
    reserve: path => { mkdirSync(path); },
    validateAssets: () => {
      assertNoSymlinkAncestors(temp);
      if (!win32.isAbsolute(temp) || !existsSync(temp)) throw Error("Existing local Temp/opencode directory required for isolated GPU installer scratch space");
      assertOnnxLidDirectory(narrationOnnxPaths(home).model);
      for (const name of ["kokoro-v1.0.onnx", "voices-v1.0.bin"]) {
        const path = win32.join(home, "kokoro", name);
        assertNoSymlinkAncestors(path);
        if (!existsSync(path)) throw Error("Existing local Kokoro assets required; no model downloads in GPU setup");
      }
    }, run: (cmd, args) => nodeNarrationRun(cmd, args, { ...process.env, TEMP: temp, TMP: temp }) });
}
