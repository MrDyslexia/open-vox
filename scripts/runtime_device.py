"""Model-free CUDA candidate selection and explicit, bounded session initialization.

Candidates are shared per worker; registered providers remain model-specific.
No provisioning, model imports, environment overrides or inference retries.
"""
from dataclasses import dataclass
import subprocess
import sys
from gpu_runtime_probe import preload_for_worker

CPU = 'CPUExecutionProvider'
CUDA = 'CUDAExecutionProvider'


@dataclass(frozen=True)
class RuntimeDevice:
    ort_cuda: bool = False
    torch_cuda: bool = False


def cuda_driver_available(run=subprocess.run):
    """Isolate native driver discovery in one model-free, two-second process.

    cuInit + cuDeviceGetCount verify the driver and a CUDA device, not just an
    installed NVIDIA display adapter. Runtime DLL readiness is checked by ORT
    initialization later. Never capture or forward native probe output.
    """
    code = (
        'import ctypes, sys\n'
        'driver = ctypes.CDLL("nvcuda.dll" if sys.platform == "win32" else "libcuda.so.1")\n'
        'count = ctypes.c_int()\n'
        'ok = driver.cuInit(0) == 0 and driver.cuDeviceGetCount(ctypes.byref(count)) == 0\n'
        'sys.exit(0 if ok and count.value > 0 else 1)\n'
    )
    try:
        return run([sys.executable, '-B', '-c', code], timeout=2,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def probe_runtime(include_torch=False, *, ort=None, torch=None, driver_probe=None):
    ort_cuda = torch_cuda = False
    try:
        if ort is None:
            import onnxruntime as ort
        if preload_for_worker(ort) and CUDA in ort.get_available_providers():
            ort_cuda = bool((driver_probe or cuda_driver_available)())
    except Exception:
        pass
    if include_torch:
        try:
            if torch is None:
                import torch
            torch_cuda = bool(torch.cuda.is_available())
        except Exception:
            pass
    return RuntimeDevice(ort_cuda, torch_cuda)


def acceleration_error(error):
    """Only known accelerator failures qualify; asset/graph failures never retry.

    Third-party messages are inspected internally, never emitted. Generic runtime
    errors are intentionally not sufficient evidence of an accelerator failure.
    """
    name = type(error).__name__
    if name in {'InvalidProtobuf', 'InvalidGraph', 'InvalidArgument', 'NoSuchFile'}:
        return False
    if name == 'EPFail':
        return True
    if not (isinstance(error, RuntimeError) or name in {'Fail', 'RuntimeException'}):
        return False
    message = str(error).lower()
    return any(marker in message for marker in (
        'cuda failure', 'cuda error', 'cuda initialization', 'cuda driver',
        'cuda dll', 'cuda allocation', 'cuda out of memory',
        'not compiled with cuda', 'no cuda gpus', 'no cuda-capable device',
        'failed to create cudaexecutionprovider', 'cudnn_status_', 'cublas_status_',
    )) or ('failed to load' in message and any(
        library in message for library in ('onnxruntime_providers_cuda', 'cudnn', 'cublas')))


def create_onnx_session(ort, model_path, candidate, options=None):
    """Return (file-backed session, registered device), never run the graph."""
    def initialize(providers):
        # ORT's constructor otherwise retries internally and prints exception
        # contents to stdout, corrupting the narration envelope.
        loaded = ort.InferenceSession(str(model_path), sess_options=options,
                                      providers=providers, enable_fallback=False)
        loaded.disable_fallback()
        registered = list(loaded.get_providers())
        if registered == [CPU]:
            return loaded, 'cpu'
        if providers == [CUDA, CPU] and registered == [CUDA, CPU]:
            return loaded, 'cuda'
        raise ValueError('invalid-registered-providers')

    if not candidate.ort_cuda:
        return initialize([CPU])
    try:
        return initialize([CUDA, CPU])
    except Exception as error:
        if not acceleration_error(error):
            raise
    return initialize([CPU])
