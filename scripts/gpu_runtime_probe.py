"""Model-free managed CUDA13 provenance, dependency and DLL checks.

The package lock contains public PyPI wheel identities, never credentials. CPU
environments do not use this exception policy. No global PATH changes are made.
"""
import argparse
import base64
import contextlib
import hashlib
import importlib
import importlib.metadata as metadata
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import sysconfig
import sys
import warnings

LOCK_PATH = Path(__file__).resolve().parents[1] / 'resources' / 'runtime-cuda13-windows.json'
LOCK_SHA256 = 'f1ebc2749415b828d5f3c199d6680f4cee6cfdefe942060defae6a87e1026ff8'
HANDLES = []
WORKER_IDENTITY = None
PREPARED_IDENTITY = None
INSPECTED_DLLS = {}
PRELOAD_FAILED = False


class ProbeError(RuntimeError):
    pass


def require(condition):
    if not condition:
        raise ProbeError('invalid-managed-cuda13-runtime')


def canonical(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def safe_path(path):
    path = Path(path)
    require(path.is_absolute())
    for parent in (path, *path.parents):
        require(not parent.is_symlink() and not (hasattr(parent, 'is_junction') and parent.is_junction()))
    return path


def inside(path, root):
    try:
        safe_path(path)
        return Path(path).resolve().is_relative_to(root.resolve())
    except (OSError, ValueError, TypeError, ProbeError):
        return False


def load_lock():
    value = json.loads(LOCK_PATH.read_text(encoding='utf-8'))
    require(hashlib.sha256(canonical(value).encode()).hexdigest() == LOCK_SHA256)
    return value


def requirement_satisfied(owner, text, versions):
    # Called only after packaging's origin and exact distribution pin are checked.
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name
    requirement = Requirement(text)
    if requirement.marker and not requirement.marker.evaluate({'extra': ''}):
        return True
    name = canonicalize_name(requirement.name)
    version = versions.get(name)
    if name == 'onnxruntime' and owner == 'kokoro-onnx' and versions.get('onnxruntime-gpu') == '1.31.0':
        version = '1.31.0'
    return version is not None and version in requirement.specifier and not requirement.url and not requirement.extras


def preload(ort, directories, *, add_directory=None):
    """Keep DLL search handles alive. Native prose/warnings are failures, never JSON."""
    handles = []
    add_directory = add_directory or os.add_dll_directory
    output, errors = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors), warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('always')
            for directory in directories:
                handles.append(add_directory(str(directory)))
            ort.preload_dlls(directory='')
        require(not output.getvalue().strip() and not errors.getvalue().strip() and not caught)
    except Exception:
        for handle in handles:
            if hasattr(handle, 'close'):
                handle.close()
        raise ProbeError('managed-cuda13-preload-failed') from None
    return handles


def basic_identity(root, role):
    root = safe_path(root)
    require(sys.platform == 'win32' and sys.version_info[:2] == (3, 13) and struct.calcsize('P') == 8)
    require(sysconfig.get_platform() == 'win-amd64' and not sysconfig.get_config_var('Py_GIL_DISABLED'))
    require(root.name == ('pn-onnx-gpu-venv' if role == 'lid' else 'kokoro-gpu-venv'))
    require(Path(sys.prefix).resolve() == root.resolve() and Path(sys.base_prefix).resolve() != root.resolve())
    require(Path(os.path.abspath(sys.executable)) == root / 'Scripts' / 'python.exe')
    return root


def check_module(name, root):
    # Validate namespace parents without guessing distribution -> module spelling.
    for index in range(1, len(name.split('.')) + 1):
        prefix = '.'.join(name.split('.')[:index])
        spec = importlib.util.find_spec(prefix)
        require(spec is not None)
        if spec.origin is not None:
            require(inside(spec.origin, root))
        else:
            require(spec.submodule_search_locations is not None)
        require(all(inside(p, root) for p in (spec.submodule_search_locations or [])))


def eager_import_applicable(wheel, platform=None):
    # phonemizer deliberately does not import dlinfo on Windows: its non-Darwin
    # initializer assumes glibc/libdl. Keep its locked distribution, dependency,
    # origin and file checks; skip only executing this inapplicable initializer.
    platform = sys.platform if platform is None else platform
    return not (platform == 'win32' and wheel['name'] == 'dlinfo' and wheel['module'] == 'dlinfo')


def inspect_environment(root, role, *, load=True):
    root = basic_identity(root, role)
    lock = load_lock()
    wheels = [w for w in lock['wheels'] if role == 'lid' or w['role'] == 'common']
    versions = {w['name']: w['version'] for w in wheels}
    distributions = {}
    states = {}
    def remember(path):
        path = Path(path)
        require(inside(path, root) and path.is_file())
        stat = path.stat()
        states[path.relative_to(root).as_posix()] = {'bytes': stat.st_size, 'mtimeMs': stat.st_mtime_ns / 1_000_000}
    remember(root / 'Scripts' / 'python.exe')
    for forbidden in ('onnxruntime', 'onnxruntime-directml', 'onnxruntime-openvino', 'onnxruntime-rocm',
                      'onnxruntime-qnn', 'onnxruntime-training', 'torch'):
        try:
            metadata.distribution(forbidden)
        except metadata.PackageNotFoundError:
            continue
        raise ProbeError('mixed-managed-runtime-distributions')
    dlls = []
    for wheel in wheels:
        dist = metadata.distribution(wheel['name'])
        require(dist.version == wheel['version'] and inside(dist.locate_file(''), root))
        require(dist.files is not None)
        for item in dist.files:
            path = Path(dist.locate_file(item))
            require(inside(path, root))
            if path.name == 'METADATA' or path.suffix.lower() in ('.dll', '.pyd'):
                remember(path)
            if path.suffix.lower() in ('.dll', '.pyd'):
                require(path.is_file() and item.hash is not None and item.hash.mode == 'sha256')
                actual = base64.urlsafe_b64encode(bytes.fromhex(sha256(path))).decode().rstrip('=')
                require(actual == item.hash.value)
                if wheel['name'].startswith('nvidia-') and path.suffix.lower() == '.dll':
                    dlls.append(path)
        if wheel['module']:
            check_module(wheel['module'], root)
            remember(importlib.util.find_spec(wheel['module']).origin)
        distributions[wheel['name']] = dist
    # All managed package and native origins are checked BEFORE executing their imports.
    for name, dist in distributions.items():
        require(all(requirement_satisfied(name, text, versions) for text in (dist.requires or [])))
    check_module('nvidia', root)
    identity = {'schemaVersion': 1, 'profile': 'cuda13', 'role': role, 'root': str(root),
                'python': str(root / 'Scripts' / 'python.exe'), 'pythonVersion': '.'.join(map(str, sys.version_info[:3])),
                'basePrefix': str(Path(sys.base_prefix).resolve()), 'executableSha256': sha256(root / 'Scripts' / 'python.exe'),
                'lockSha256': LOCK_SHA256, 'packages': versions, 'files': states}
    INSPECTED_DLLS[str(root)] = dlls
    if not load:
        return identity
    load_native(root, versions, dlls)
    for wheel in wheels:
        if wheel['module']:
            if eager_import_applicable(wheel):
                module = importlib.import_module(wheel['module'])
                require(inside(getattr(module, '__file__', None), root))
            check_module(wheel['module'], root)
            require(metadata.distribution(wheel['name']).version == wheel['version'])
    require(callable(importlib.import_module('kokoro_onnx').Kokoro.from_session))
    return identity


def load_native(root, versions, dlls):
    require(dlls and any('cudnn' in p.name.lower() for p in dlls))
    ort = importlib.import_module('onnxruntime')
    require(inside(ort.__file__, root) and ort.__version__ == versions['onnxruntime-gpu'])
    HANDLES.extend(preload(ort, sorted({p.parent for p in dlls})))
    # Reject already-loaded foreign NVIDIA libraries with matching names. This is
    # provenance validation, not a claim of hermetic Windows loader isolation.
    import ctypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetModuleHandleW.argtypes = [ctypes.c_wchar_p]
    kernel.GetModuleHandleW.restype = ctypes.c_void_p
    kernel.GetModuleFileNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint]
    kernel.GetModuleFileNameW.restype = ctypes.c_uint
    loaded = []
    for path in dlls:
        handle = kernel.GetModuleHandleW(path.name)
        if handle:
            buffer = ctypes.create_unicode_buffer(32768)
            require(0 < kernel.GetModuleFileNameW(handle, buffer, len(buffer)) < len(buffer))
            require(Path(buffer.value).resolve() == path.resolve())
            loaded.append(path.name.lower())
    require(any('cudnn' in name for name in loaded) and any('cudart' in name for name in loaded))
    require('CUDAExecutionProvider' in ort.get_available_providers())


def prepare_worker():
    """Preflight managed dependencies BEFORE Kokoro/ORT imports, without requiring CUDA.

    A native CUDA load failure must still permit the existing CPU provider path.
    """
    global PREPARED_IDENTITY
    root = Path(sys.prefix)
    if PREPARED_IDENTITY is not None:
        require(PREPARED_IDENTITY['root'] == str(root))
        return PREPARED_IDENTITY
    role = 'lid' if root.name == 'pn-onnx-gpu-venv' else 'kokoro'
    identity = inspect_environment(root, role, load=False)
    marker_path = safe_path(root / 'gpu-dependencies.json')
    qualification_path = safe_path(root / 'gpu-qualification.json')
    require(marker_path.stat().st_size <= 256 * 1024 and qualification_path.stat().st_size <= 256 * 1024)
    marker = json.loads(marker_path.read_text(encoding='utf-8'))
    qualification = json.loads(qualification_path.read_text(encoding='utf-8'))
    require(identity == marker == qualification['identity'] and qualification['qualified'] is True)
    require(qualification['dependenciesSha256'] == sha256(marker_path))
    PREPARED_IDENTITY = identity
    return identity


def preload_for_worker(ort):
    """CPU workers remain unchanged; managed GPU workers must pass provenance first."""
    root = Path(sys.prefix)
    if root.name not in ('pn-onnx-gpu-venv', 'kokoro-gpu-venv'):
        return True
    try:
        global WORKER_IDENTITY, PRELOAD_FAILED
        if PRELOAD_FAILED:
            return False
        if WORKER_IDENTITY is not None:
            require(WORKER_IDENTITY['root'] == str(root))
            if ort is not None:
                require(inside(ort.__file__, root))
            return True
        identity = prepare_worker()
        load_native(root, identity['packages'], INSPECTED_DLLS[str(root)])
        if ort is not None:
            require(inside(ort.__file__, root))
        WORKER_IDENTITY = identity
        return True
    except Exception:
        PRELOAD_FAILED = True
        return False


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--role', required=True, choices=('lid', 'kokoro'))
    parser.add_argument('--basic', action='store_true')
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.basic:
            basic_identity(args.root, args.role)
        else:
            record = inspect_environment(args.root, args.role)
            if args.publish:
                target = safe_path(Path(args.root) / 'gpu-dependencies.json')
                with target.open('x', encoding='utf-8', newline='\n') as stream:
                    stream.write(canonical(record))
        print('{"ready":true}')
        return 0
    except Exception:
        print('{"ready":false,"code":"managed-cuda13-probe-failed"}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
