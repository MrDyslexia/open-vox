import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { setupGpu, GPU_LOCK, validateGpuLock, GPU_PIP_BOOTSTRAP } from "../src/setup-gpu";

function fixture() {
  const calls: string[][] = [], writes: string[] = [], reserved: string[] = [];
  const deps = {
    home: "C:\\managed\\open-vox", systemPython: "C:\\Python313\\python.exe", platform: "win32",
    exists: (_: string) => false, assertPath: (_: string) => {}, freeBytes: () => 12 * 1024 ** 3,
    reserve: (path: string) => { reserved.push(path); }, validateAssets: () => {},
    run: async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return 0; },
    write: (path: string, _data: string) => { writes.push(path); }, log: (_: string) => {},
  };
  return { deps, calls, writes, reserved };
}

describe("managed CUDA13 provisioning", () => {
  test("anonymous pip bootstrap rejects credentialed/foreign requests without installing or networking", () => {
    const prefix = `import sys,types
for name in ('pip','pip._internal','pip._internal.network','pip._internal.network.session','pip._internal.cli','pip._internal.cli.main'):
    sys.modules[name] = types.ModuleType(name)
class Session:
    def __init__(self):
        self.trust_env=True
        self.proxies={'https':'private-proxy'}
    def send(self,request,**kwargs):
        assert kwargs['proxies']=={}
        assert not request.headers
        return 200
sys.modules['pip._internal.network.session'].PipSession=Session
def fake_main(args):
    assert args==['--isolated','install','--no-deps']
    s=Session()
    assert s.trust_env is False and s.proxies=={}
    s.auth.prompting=False
    r=types.SimpleNamespace(url='https://files.pythonhosted.org/pinned.whl',headers={'Authorization':'private','Cookie':'private','Proxy-Authorization':'private'})
    assert s.send(r)==200
    for url in ('http://pypi.org/x','https://foreign.invalid/x','https://user:password@pypi.org/x'):
        r.url=url
        try:
            s.send(r)
        except RuntimeError:
            continue
        raise AssertionError('unsafe request accepted')
    return 0
sys.modules['pip._internal.cli.main'].main=fake_main
`;
    const child = spawnSync("python", ["-I", "-B", "-c", prefix + GPU_PIP_BOOTSTRAP, "--isolated", "install", "--no-deps"], { encoding: "utf8", timeout: 10000 });
    expect(child.status).toBe(0); expect(child.stderr).toBe("");
  });
  test("lock rejects missing hashes, mixed ORT and incomplete closure before work", () => {
    expect(() => validateGpuLock(GPU_LOCK)).not.toThrow();
    for (const mutate of [
      (lock: any) => { lock.wheels[0].sha256 = ""; },
      (lock: any) => { lock.wheels[0].name = "onnxruntime"; },
      (lock: any) => { lock.wheels.pop(); },
      (lock: any) => { lock.wheels[0].url = "https://user:secret@files.pythonhosted.org/a.whl"; },
    ]) {
      const lock = structuredClone(GPU_LOCK); mutate(lock);
      expect(() => validateGpuLock(lock)).toThrow();
    }
  });
  test("reserves only new GPU siblings, installs hash-locked no-deps wheels, never activates", async () => {
    const h = fixture(); await setupGpu(h.deps);
    expect(h.reserved).toEqual(["C:\\managed\\open-vox\\pn-onnx-gpu-venv", "C:\\managed\\open-vox\\kokoro-gpu-venv"]);
    const installs = h.calls.filter(c => c.includes("install"));
    expect(installs).toHaveLength(2);
    for (const command of installs) {
      for (const flag of ["--isolated", "--no-deps", "--require-hashes", "--only-binary=:all:", "--no-cache-dir"]) expect(command).toContain(flag);
      expect(command.some(s => s.includes("onnxruntime-"))).toBe(false);
    }
    expect(h.writes).toHaveLength(0); // The interpreter probe publishes its own identity-bound readiness.
    expect(h.calls.flat().some(s => s.includes("config.json") || s.includes("setupKokoro"))).toBe(false);
  });
  test("existing destinations, redirected paths, low disk and bad assets stop before external work", async () => {
    for (const change of [
      (h: ReturnType<typeof fixture>) => { h.deps.exists = () => true; },
      (h: ReturnType<typeof fixture>) => { h.deps.freeBytes = () => 1; },
      (h: ReturnType<typeof fixture>) => { h.deps.assertPath = () => { throw Error("unsafe"); }; },
      (h: ReturnType<typeof fixture>) => { h.deps.validateAssets = () => { throw Error("corrupt"); }; },
    ]) {
      const h = fixture(); change(h);
      await expect(setupGpu(h.deps)).rejects.toThrow();
      expect(h.calls).toHaveLength(0); expect(h.reserved).toHaveLength(0);
    }
  });
  test("first failed operation stops and preserves partial directories", async () => {
    const h = fixture(); h.deps.run = async (cmd, args) => { h.calls.push([cmd, ...args]); return 1; };
    await expect(setupGpu(h.deps)).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
  });
});
