"""Explicit offline CUDA qualification. Synthetic input only; NEVER plays audio.

Run separately in each new managed environment. Dependencies-ready is not
qualification. Only complete per-model CUDA compute evidence publishes a marker.
"""
import argparse
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import socket
import tempfile

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import gpu_runtime_probe as probe

CUDA, CPU = 'CUDAExecutionProvider', 'CPUExecutionProvider'
TEXTS = ('This is a local speech test.', 'Esta es una prueba local de voz.')


class DiscardOutput(io.TextIOBase):
    def write(self, text):
        return len(text)


@contextlib.contextmanager
def offline_network():
    """Reject ordinary Python outbound networking, in addition to offline SDK flags."""
    def blocked(*args, **kwargs):
        raise RuntimeError('qualification-network-disabled')
    originals = [(socket, 'create_connection', socket.create_connection),
                 (socket, 'getaddrinfo', socket.getaddrinfo),
                 (socket.socket, 'connect', socket.socket.connect),
                 (socket.socket, 'connect_ex', socket.socket.connect_ex),
                 (socket.socket, 'sendto', socket.socket.sendto)]
    try:
        for owner, name, original in originals:
            setattr(owner, name, blocked)
        yield
    finally:
        for owner, name, original in originals:
            setattr(owner, name, original)


def compute_evidence(events):
    if type(events) is not list or len(events) > 100000:
        raise ValueError('invalid-profile')
    cuda, cpu = 0, 0
    for event in events:
        if type(event) is not dict:
            raise ValueError('invalid-profile-event')
        if event.get('cat') != 'Node':
            continue
        args = event.get('args')
        if type(args) is not dict:
            raise ValueError('invalid-profile-node')
        if not str(event.get('name', '')).endswith('_kernel_time'):
            continue
        op = args.get('op_name')
        if not isinstance(op, str) or not re.fullmatch('[A-Za-z][A-Za-z0-9_]{0,100}', op):
            raise ValueError('invalid-profile-operation')
        if args.get('provider') == CUDA and 'memcpy' not in op.lower():
            cuda += 1
        if args.get('provider') == CPU:
            cpu += 1
    if cuda == 0:
        raise ValueError('no-cuda-compute-evidence')
    return {'cudaComputeNodes': cuda, 'cpuNodes': cpu}


def write_exclusive(path, value):
    probe.safe_path(path)
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        stream.write(probe.canonical(value))


def session(ort, model, out, name, gpu):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.enable_profiling = gpu
    options.profile_file_prefix = str(out / name)
    loaded = ort.InferenceSession(str(model), sess_options=options,
                                  providers=[CUDA, CPU] if gpu else [CPU], enable_fallback=False)
    loaded.disable_fallback()
    if loaded.get_providers() != ([CUDA, CPU] if gpu else [CPU]):
        raise ValueError('wrong-registered-providers')
    return loaded


def finish_profile(loaded, out):
    path = probe.safe_path(Path(loaded.end_profiling()))
    probe.require(path.resolve().is_relative_to(out.resolve()) and path.stat().st_size <= 64 * 1024 * 1024)
    events = json.loads(path.read_text(encoding='utf-8'))
    counts = compute_evidence(events)
    # Aggregate repeated operator/provider events so real graphs remain bounded.
    # Keep a hash of the original local trace; do not persist node/input prose.
    grouped = {}
    for event in events:
        if event.get('cat') == 'Node' and str(event.get('name', '')).endswith('_kernel_time'):
            args = event['args']
            if args.get('provider') in (CUDA, CPU):
                key = (args['provider'], args['op_name'])
                grouped[key] = grouped.get(key, 0) + 1
    safe = [{'cat': 'Node', 'provider': provider, 'op': op, 'count': count}
            for (provider, op), count in sorted(grouped.items())]
    counts['sourceProfileSha256'] = probe.sha256(path)
    probe.require(len(probe.canonical(safe)) <= 256 * 1024)
    return counts, safe


def qualify_models(home, role, out):
    import numpy as np
    import onnxruntime as ort
    import soundfile as sf
    from kokoro_onnx import Kokoro
    results, evidence = {}, {}
    model = home / 'kokoro' / 'kokoro-v1.0.onnx'
    voices = home / 'kokoro' / 'voices-v1.0.bin'
    gpu = session(ort, model, out, 'kokoro', True)
    cpu = session(ort, model, out, 'kokoro-cpu', False)
    engines = [Kokoro.from_session(gpu, str(voices)), Kokoro.from_session(cpu, str(voices))]
    for index, (text, voice, language) in enumerate(zip(TEXTS, ('af_heart', 'em_alex'), ('en-us', 'es'))):
        lengths = []
        for engine_index, engine in enumerate(engines):
            audio, rate = engine.create(text, voice=voice, speed=1.0, lang=language)
            audio = np.asarray(audio)
            probe.require(audio.ndim == 1 and audio.size > 0 and np.isfinite(audio).all()
                          and 8000 <= rate <= 48000 and 0.1 <= audio.size / rate <= 30 and np.max(np.abs(audio)) > 0)
            lengths.append(audio.size / rate)
            if engine_index == 0:
                sf.write(str(out / f'kokoro-{index}.wav'), audio, rate)
        # Loose duration sanity only; this is not a numerical/audio quality parity promise.
        probe.require(0.5 < lengths[0] / lengths[1] < 2)
    results['kokoro'], evidence['kokoro'] = finish_profile(gpu, out)
    if role == 'lid':
        import narration_lid_onnx as lid
        from runtime_device import RuntimeDevice
        directory = lid_directory(home)
        lid.verify_local_assets(directory)
        original = lid.create_onnx_session
        sessions = []
        answers = []
        try:
            for use_gpu in (True, False):
                def make_session(runtime, path, candidate, options=None):
                    loaded = session(runtime, path, out, 'lid', use_gpu)
                    sessions.append(loaded)
                    return loaded, 'cuda' if use_gpu else 'cpu'
                lid.create_onnx_session = make_session
                detector = lid.OnnxDetector(directory, runtime_device=RuntimeDevice(ort_cuda=use_gpu))
                run_answers = []
                for text in (*TEXTS, 'This local test contiene palabras en ambos idiomas.'):
                    answer = detector.detect(text)
                    probe.require(answer['status'] == 'available' and len(answer['tokens']) > 0
                                  and answer['identity']['integrity'] == 'verified-local-assets')
                    run_answers.append(answer['tokens'])
                answers.append(run_answers)
            probe.require(len(sessions) == 2)
            for gpu_tokens, cpu_tokens in zip(*answers):
                probe.require([(t['start'], t['end']) for t in gpu_tokens] == [(t['start'], t['end']) for t in cpu_tokens])
                probe.require(sum(a['label'] == b['label'] for a, b in zip(gpu_tokens, cpu_tokens)) / len(cpu_tokens) >= 0.5)
            results['lid'], evidence['lid'] = finish_profile(sessions[0], out)
        finally:
            lid.create_onnx_session = original
    return results, evidence


def lid_directory(home):
    from narration_lid_onnx import BACKEND, REVISION
    return home / 'lid-onnx' / 'codeswitch-spaeng-lid-lince' / f"{REVISION}-onnx-fp32-{BACKEND['graphSha256'][:12]}"


def assets(home, role):
    paths = {'kokoro': home / 'kokoro' / 'kokoro-v1.0.onnx', 'voices': home / 'kokoro' / 'voices-v1.0.bin'}
    if role == 'lid':
        from narration_lid_onnx import FILES, verify_local_assets
        directory = lid_directory(home)
        verify_local_assets(directory)
        paths.update({name: directory / name for name in FILES})
    stamps = {}
    for key, path in paths.items():
        probe.safe_path(path)
        before = path.stat()
        fingerprint = probe.sha256(path)
        after = path.stat()
        probe.require(before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns and after.st_size > 0)
        stamps[key] = {'bytes': after.st_size, 'mtimeMs': after.st_mtime_ns / 1_000_000, 'sha256': fingerprint}
    return stamps


def validated_output_path(out):
    out = probe.safe_path(out)
    temp_root = probe.safe_path(Path(os.environ['LOCALAPPDATA']) / 'Temp' / 'opencode')
    probe.require('..' not in out.parts and '..' not in temp_root.parts)
    probe.require(temp_root.is_dir() and out.resolve().is_relative_to(temp_root.resolve())
                  and out.resolve() != temp_root.resolve())
    return out


@contextlib.contextmanager
def qualification_tempdir(out):
    """Constrain child-process scratch before third-party imports, restoring callers.

    tempfile caches its directory independently of TEMP/TMP. Both must point to
    validated output so phonemizer's default mkdtemp cannot escape that output.
    """
    out = validated_output_path(out)
    probe.require(out.is_dir())
    previous = {name: os.environ.get(name) for name in ('TEMP', 'TMP')}
    cached = tempfile.tempdir
    try:
        os.environ['TEMP'] = os.environ['TMP'] = str(out)
        tempfile.tempdir = str(out)
        yield
    finally:
        tempfile.tempdir = cached
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def run(home, out):
    root = Path(sys.prefix)
    role = 'lid' if root.name == 'pn-onnx-gpu-venv' else 'kokoro'
    home, out = probe.safe_path(home), validated_output_path(out)
    probe.require('..' not in home.parts and root.parent.resolve() == home.resolve())
    probe.require(not out.exists())
    probe.require(not (root / 'gpu-qualification.json').exists())
    out.mkdir()  # Exclusive new output only; never clean an existing directory.
    with qualification_tempdir(out):
        identity = probe.inspect_environment(root, role)
        marker = root / 'gpu-dependencies.json'
        probe.require(json.loads(marker.read_text(encoding='utf-8')) == identity)
        dependency_hash = probe.sha256(marker)
        before = assets(home, role)
        models, evidence = qualify_models(home, role, out)
        probe.require(before == assets(home, role) and dependency_hash == probe.sha256(marker))
        for name, events in evidence.items():
            path = root / f'{name}-cuda-evidence.json'
            write_exclusive(path, events)
            models[name]['sha256'] = probe.sha256(path)
        report = {'schemaVersion': 1, 'qualified': True, 'identity': identity, 'dependenciesSha256': dependency_hash,
                  'assets': before, 'cpuSanity': True, 'models': models}
        probe.require(len(probe.canonical(report)) <= 256 * 1024)
        write_exclusive(out / 'qualification.json', report)
        write_exclusive(root / 'gpu-qualification.json', report)  # Last operation: no partial success marker.


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args(argv)
    for name in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY',
                 'HF_HUB_DISABLE_IMPLICIT_TOKEN', 'DO_NOT_TRACK'):
        os.environ[name] = '1'
    os.environ['HF_TOKEN'] = os.environ['HUGGING_FACE_HUB_TOKEN'] = ''
    # Third-party output is never used as a report or forwarded as prose.
    try:
        with contextlib.redirect_stdout(DiscardOutput()), contextlib.redirect_stderr(DiscardOutput()), offline_network():
            run(Path(args.home), Path(args.out))
        print('{"qualified":true}')
        return 0
    except Exception:
        print('{"qualified":false,"code":"offline-cuda-qualification-failed"}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
