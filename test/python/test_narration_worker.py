import io
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import narration_worker as worker

OWNER, GENERATION = str(uuid4()), str(uuid4())
SCRATCH = Path(tempfile.gettempdir()) / 'opencode'


def request(root, **changes):
    return {'v': 1, 'owner': OWNER, 'generation': GENERATION, 'request': str(uuid4()), 'mode': 'text',
            'input': '¡Sí! 😀', 'output': str(root / (str(uuid4()) + '.wav')), 'voice': 'em_alex',
            'lang': 'es', 'speed': 1, 'toneVoice': '', 'toneWeight': 0, **changes}


def args(root):
    return types.SimpleNamespace(owner=OWNER, generation=GENERATION, output_root=str(root),
                                 model='fixed-model', voices='fixed-voices', lid_backend='torch',
                                 lid_dir=None, app_home='fixed-home', lid_manifest='fixed-manifest')


class ProtocolTests(unittest.TestCase):
    def test_bootstrap_order_imports_reader_then_model_load(self):
        events, protocol = [], io.BytesIO()
        sdk = (Mock(), Mock(), Mock())
        def bootstrap(config):
            self.assertEqual(json.loads(protocol.getvalue())['stage'], 'imports')
            events.append('imports')
            return sdk
        def models(config, progress, bound):
            self.assertIs(bound, sdk)
            events.append('model-load')
            progress('runtime-probe')
            raise RuntimeError('stop before request loop')
        thread = Mock()
        thread.start.side_effect = lambda: events.append('reader')
        with patch.object(worker.threading, 'Thread', return_value=thread), self.assertRaises(RuntimeError):
            worker.serve(args(SCRATCH), io.BytesIO(), protocol, bootstrap=bootstrap, model_factory=models)
        self.assertEqual(events, ['imports', 'reader', 'model-load'])
        thread.start.assert_called_once()

    def test_preimport_keeps_optional_lid_missing_and_direct_kokoro_available(self):
        helper, runtime = types.ModuleType('kokoro_say'), types.ModuleType('runtime_device')
        helper.build_detector, helper.load_kokoro, runtime.probe_runtime = Mock(), Mock(), Mock()
        for backend, home in [('onnx', 'home'), ('torch', 'home'), ('torch', None)]:
            config = args(SCRATCH)
            config.lid_backend, config.app_home = backend, home
            with self.subTest(backend=backend, home=home), patch.dict(sys.modules, {
                    'kokoro_say': helper, 'runtime_device': runtime, 'tokenizers': None,
                    'torch': None, 'transformers': None}):
                self.assertEqual(worker.preimport_sdk(config),
                                 (helper.build_detector, helper.load_kokoro, runtime.probe_runtime))
        helper.build_detector.assert_not_called()
        helper.load_kokoro.assert_not_called()
        runtime.probe_runtime.assert_not_called()

    def test_required_sdk_failure_propagates_before_reader(self):
        with patch.dict(sys.modules, {'kokoro_say': None}), patch.object(worker.threading, 'Thread') as thread:
            with self.assertRaises(ImportError):
                worker.serve(args(SCRATCH), io.BytesIO(), io.BytesIO())
        thread.assert_not_called()

    @unittest.skipUnless(sys.platform == 'win32', 'Windows private-pipe native import regression')
    def test_cpu_sdk_preimport_before_reader_with_stdin_held_open(self):
        python = Path(os.environ.get('LOCALAPPDATA', '')) / 'open-vox/pn-onnx-venv/Scripts/python.exe'
        if not python.is_file():
            self.skipTest('external managed CPU runtime unavailable; no installation attempted')
        scripts = str(Path(worker.__file__).parent)
        code = f'''
import sys, threading, types
sys.path.insert(0, {scripts!r})
import narration_worker as w
entered = threading.Event()
original = w.read_frames
def reader(*args):
    entered.set()
    original(*args)
w.read_frames = reader
def models(args, progress, sdk):
    assert entered.wait(1)
    assert 'numpy' in sys.modules and 'kokoro_onnx' in sys.modules
    assert 'tokenizers' in sys.modules and 'torch' not in sys.modules
    assert all(callable(function) for function in sdk)
    for stage in w.STARTUP_STAGES[1:]:
        progress(stage)
w.serve(types.SimpleNamespace(owner={OWNER!r}, generation={GENERATION!r}, lid_backend='onnx', app_home=None),
        sys.stdin.buffer, sys.stdout.buffer, model_factory=models)
'''
        child = subprocess.Popen([str(python), '-B', '-c', code], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        frames = queue.Queue(maxsize=6)
        diagnostics = bytearray()
        def collect():
            for _ in range(5):
                frames.put(child.stdout.readline(worker.RESPONSE_BYTES + 1))
        def collect_diagnostics():
            # Drain concurrently so a traceback cannot itself block the import thread.
            while True:
                chunk = child.stderr.read1(4096)
                if not chunk:
                    return
                diagnostics.extend(chunk[:max(0, 16384 - len(diagnostics))])
        reader = threading.Thread(target=collect, daemon=True)
        diagnostic_reader = threading.Thread(target=collect_diagnostics, daemon=True)
        start = time.monotonic()
        reader.start()
        diagnostic_reader.start()
        try:
            values = []
            try:
                for _ in range(5):
                    values.append(json.loads(frames.get(timeout=max(.01, 7 - (time.monotonic() - start)))))
            except queue.Empty:
                self.fail(f'CPU SDK import deadline; last stage: {values[-1].get("stage") if values else "none"}\n'
                          + diagnostics.decode('utf-8', errors='replace'))
            self.assertEqual([v.get('stage') for v in values[:-1]], list(worker.STARTUP_STAGES))
            self.assertEqual(values[-1]['type'], 'ready')
            self.assertIsNone(child.poll(), 'stdin must remain open until ready')
            child.stdin.close()
            self.assertEqual(child.wait(timeout=5), 0)
            print(f'CPU SDK imports + held pipe ready/EOF: {time.monotonic() - start:.3f}s')
        finally:
            if child.poll() is None:
                child.kill()  # Only this test-owned child; never a PID search or process tree.
            child.wait(timeout=2)
            reader.join(2)
            diagnostic_reader.join(2)
            child.stdout.close()
            child.stderr.close()
            if not child.stdin.closed:
                child.stdin.close()

    def test_blocked_reader_drops_consumed_frame_reference(self):
        blocked, release = threading.Event(), threading.Event()
        class BlockingReader:
            def __init__(self):
                self.first = True
            def readline(self, limit):
                if self.first:
                    self.first = False
                    return b'{"input":"synthetic accented texto: si, caf\\u00e9"}\n'
                blocked.set()
                if not release.wait(5):
                    raise TimeoutError('test reader not released')
                return b''
        inbox, stop = queue.Queue(maxsize=1), Mock()
        thread = threading.Thread(target=worker.read_frames, args=(BlockingReader(), inbox, stop))
        thread.start()
        try:
            self.assertTrue(blocked.wait(5))
            consumed = inbox.get_nowait()
            frame = sys._current_frames()[thread.ident]
            while frame and frame.f_code is not worker.read_frames.__code__:
                frame = frame.f_back
            self.assertIsNotNone(frame)
            self.assertFalse(any(value is consumed for value in frame.f_locals.values()),
                             'reader retains the consumed plaintext frame while blocked')
        finally:
            release.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())

    def test_strict_json_bounds_duplicates_unicode_and_nonfinite(self):
        value = request(Path('unused'))
        self.assertEqual(worker.strict_json((json.dumps(value, ensure_ascii=False) + '\n').encode()), value)
        for raw in [b'{"v":1,"v":1}\n', b'{"input":{"x":1,"x":2}}\n', b'{"x":NaN}\n',
                    b'\xff\n', b'{}', b'x' * (worker.REQUEST_BYTES + 1)]:
            with self.subTest(raw=raw[:50]), self.assertRaises((ValueError, UnicodeError)):
                worker.strict_json(raw)

    def test_request_allowlist_and_types(self):
        valid = request(Path('unused'))
        self.assertEqual(worker.validate_request(valid, OWNER, GENERATION), valid)
        for change in [{'v': True}, {'v': 2}, {'owner': str(uuid4())}, {'generation': str(uuid4())},
                       {'request': 'wrong'}, {'voice': '../voice'}, {'lang': 'fr'}, {'speed': True},
                       {'speed': float('inf')}, {'toneWeight': -1}, {'mode': 'code'}, {'input': ''},
                       {'output': False}, {'input': []}, {'extra': 'not-allowed'}, {'mode': 'plan', 'input': 'text'}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                worker.validate_request({**valid, **change}, OWNER, GENERATION)

    def test_reader_eof_and_overflow_use_only_private_termination(self):
        for raw, code in [(b'', 0), (b'no-newline', 2), (b'x' * (worker.REQUEST_BYTES + 1), 2),
                          (b'{}\n{}\n', 2)]:
            stop, inbox = Mock(), queue.Queue(maxsize=1)
            worker.read_frames(io.BytesIO(raw), inbox, terminate=stop)
            stop.assert_called_once_with(code)

    def test_synthetic_child_exits_on_private_pipe_eof_without_model_imports(self):
        scripts = str(Path(worker.__file__).parent)
        code = (f'import sys, queue; sys.path.insert(0, {scripts!r}); '
                'import narration_worker as w; w.read_frames(sys.stdin.buffer, queue.Queue(maxsize=1))')
        child = subprocess.Popen([sys.executable, '-B', '-c', code], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            stdout, stderr = child.communicate(input=b'{}\n', timeout=5)
            self.assertEqual(child.returncode, 0)
            self.assertEqual(stdout, b'')
            self.assertEqual(stderr, b'')
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=5)

    def test_model_free_startup_progress_ready_and_owned_eof_close(self):
        config = args(SCRATCH)
        code = (f'import sys, types; sys.path.insert(0, {str(Path(worker.__file__).parent)!r}); '
                'import narration_worker as w; '
                'w.Models=lambda args, progress, sdk: [progress(stage) for stage in w.STARTUP_STAGES[1:]]; '
                f'w.serve(types.SimpleNamespace(**{vars(config)!r}), sys.stdin.buffer, sys.stdout.buffer, bootstrap=lambda args: None)')
        child = subprocess.Popen([sys.executable, '-B', '-c', code], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        frames = queue.Queue(maxsize=6)
        def read():
            for _ in range(5):
                frames.put(child.stdout.readline(worker.RESPONSE_BYTES + 1))
        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        try:
            values = [json.loads(frames.get(timeout=5)) for _ in range(5)]
            self.assertEqual([v.get('stage') for v in values[:-1]], list(worker.STARTUP_STAGES))
            self.assertEqual(values[-1]['type'], 'ready')
            self.assertTrue(all(v['owner'] == OWNER and v['generation'] == GENERATION for v in values))
            child.stdin.close()
            self.assertEqual(child.wait(timeout=5), 0)
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
            reader.join(5)
            child.stdout.close()
            child.stderr.close()
            if not child.stdin.closed:
                child.stdin.close()
        self.assertFalse(reader.is_alive())

    def test_progress_scope_order_and_payload_allowlist(self):
        protocol = io.BytesIO()
        report = worker.progress_reporter(protocol, OWNER, GENERATION)
        for stage in worker.STARTUP_STAGES:
            report(stage)
        with self.assertRaises(ValueError):
            report('imports')
        with self.assertRaises(ValueError):
            report('arbitrary-prose')
        frames = [json.loads(line) for line in protocol.getvalue().splitlines()]
        self.assertEqual(len(frames), 4)
        self.assertTrue(all(set(v) == {'v', 'owner', 'generation', 'type', 'request', 'stage'} for v in frames))
        self.assertTrue(all(v['request'] is None for v in frames))
        private_request = str(uuid4())
        report = worker.progress_reporter(protocol, OWNER, GENERATION, private_request)
        for stage in worker.REQUEST_STAGES:
            report(stage)
        with self.assertRaises(ValueError):
            report('imports')
        self.assertTrue(all(len(line) < worker.RESPONSE_BYTES for line in protocol.getvalue().splitlines()))

    def test_output_guards_no_foreign_overwrite_or_escape(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = Path(directory)
            good = root / (str(uuid4()) + '.wav')
            good.write_bytes(b'')
            with worker.candidate_file(str(good), str(root)) as stream:
                stream.write(b'owned')
            self.assertEqual(good.read_bytes(), b'owned')
            for path in [good, root / 'foreign.wav', root / '..' / (str(uuid4()) + '.wav'),
                         root / 'missing' / (str(uuid4()) + '.wav')]:
                with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                    with worker.candidate_file(str(path), str(root)):
                        self.fail('unsafe path accepted')
            self.assertEqual(good.read_bytes(), b'owned')

    def test_symlinks_and_hardlinks_are_rejected_where_supported(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = Path(directory)
            target = root / (str(uuid4()) + '.wav'); target.write_bytes(b'')
            link = root / (str(uuid4()) + '.wav')
            try:
                link.hardlink_to(target)
            except OSError:
                self.skipTest('hard links unavailable')
            with self.assertRaises(ValueError):
                with worker.candidate_file(str(link), str(root)):
                    self.fail('hard link accepted')
            link.unlink()
            try:
                link.symlink_to(target)
            except OSError:
                return  # Windows symlink privilege is optional; hard-link assertion still ran.
            with self.assertRaises(ValueError):
                with worker.candidate_file(str(link), str(root)):
                    self.fail('symlink accepted')


class ModelTests(unittest.TestCase):
    def test_lazy_native_runtime_and_instance_call_counters_do_not_count_construction_as_load(self):
        counters = dict(lidLoads=0, tokenizerLoads=0, lidRuns=None, kokoroCreates=0, kokoroRuns=0)
        class Session:
            def run(self, *args):
                return 'synthetic-result'
        class Detector:
            __module__ = 'narration_lid_onnx'
            def __init__(self):
                self._runtime = None
            def _load(self):
                if self._runtime is None:
                    self._runtime = ('numpy', 'tokenizer', Session())
            def detect(self, text):
                self._load()
                return self._runtime[2].run(None, {'synthetic': 1})
        native = Detector()
        detector = worker.DetectorCounter(native, counters)
        self.assertEqual(counters['lidLoads'], 0)
        self.assertIsNone(counters['lidRuns'])
        for text in ['Synthetic café', 'Different English']:
            self.assertEqual(detector.detect(text), 'synthetic-result')
        self.assertEqual(counters['lidLoads'], 1)
        self.assertEqual(counters['tokenizerLoads'], 1)
        self.assertEqual(counters['lidRuns'], 2)
        self.assertEqual(set(vars(detector)), {'target', 'counters', 'load'})
        class Kokoro:
            def create(self, text):
                return 'finite-audio'
        kokoro = worker.CallCounter(Kokoro(), 'create', counters, 'kokoroCreates')
        self.assertEqual(kokoro.create('synthetic'), 'finite-audio')
        self.assertEqual(counters['kokoroCreates'], 1)
        self.assertEqual(set(vars(kokoro)), {'target', 'method', 'counters', 'key'})

    def test_counter_delegates_failed_native_calls_without_retaining_arguments(self):
        class Session:
            def run(self, value):
                raise ValueError('synthetic-failure')
        counters = {'kokoroRuns': 0}
        proxy = worker.CallCounter(Session(), 'run', counters, 'kokoroRuns')
        with self.assertRaises(ValueError):
            proxy.run('synthetic')
        self.assertEqual(counters['kokoroRuns'], 1)
        self.assertNotIn('value', vars(proxy))

    def test_two_different_requests_load_models_once_and_retain_no_request_state(self):
        kokoro = Mock()
        kokoro.get_voices.return_value = ['em_alex', 'af_heart']
        kokoro.create.return_value = ([0.1], 24000)
        detector = types.SimpleNamespace(device_diagnostics=['lid-onnx-provider-cpu'])
        helper = types.ModuleType('kokoro_say')
        helper.build_detector = Mock(return_value=detector)
        helper.load_kokoro = Mock(return_value=(kokoro, 'kokoro-onnx-provider-cpu'))
        helper.validate_tone_voice = Mock()
        runtime = types.ModuleType('runtime_device'); runtime.probe_runtime = Mock(return_value='candidate')
        sf = types.ModuleType('soundfile'); sf.write = Mock(side_effect=lambda out, *a, **kw: out.write(b'RIFF-fake'))
        synthesis = types.ModuleType('narration_synthesis')
        synthesis.load_plan = Mock(side_effect=lambda stream: json.load(stream))
        synthesis.raw_phonemizer = Mock(return_value='phonemizer')
        synthesis.synthesize_envelope = Mock(side_effect=lambda resolved, k, v, s, out, *a, **kw: out.write(b'RIFF-plan'))
        resolver = types.ModuleType('narration_resolver')
        resolver.resolve_plan = Mock(return_value={'diagnostics': []})
        modules = {'kokoro_say': helper, 'runtime_device': runtime, 'soundfile': sf,
                   'narration_synthesis': synthesis, 'narration_resolver': resolver}
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory, patch.dict(sys.modules, modules):
            root = Path(directory); config = args(root); startup = []
            models = worker.Models(config, startup.append,
                                   (helper.build_detector, helper.load_kokoro, runtime.probe_runtime))
            self.assertEqual(startup, list(worker.STARTUP_STAGES[1:]))
            keys = set(vars(models))
            a = request(root)
            b = request(root, mode='plan', input={'outcome': 'complete', 'private': 'different'},
                        voice='af_heart', speed=1.2, lang='en-gb')
            for r in [a, b]:
                stages = []
                result = worker.process_request(models, r, config, stages.append)
                self.assertEqual(stages, ['synthesis'] if r['mode'] == 'text' else ['lid-resolve', 'synthesis'])
                self.assertEqual(result['request'], r['request']); self.assertEqual(result['code'], 0)
                self.assertTrue(Path(r['output']).read_bytes().startswith(b'RIFF'))
            helper.load_kokoro.assert_called_once_with('fixed-model', 'fixed-voices', 'candidate')
            helper.build_detector.assert_called_once()
            runtime.probe_runtime.assert_called_once()
            self.assertEqual(set(vars(models)), keys)
            self.assertEqual(keys, {'detector', 'kokoro', 'kokoro_device', 'counters'})
            self.assertEqual(models.counters['kokoroLoads'], 1)
            self.assertIsNone(models.counters['lidLoads'])
            self.assertEqual(kokoro.create.call_count, 1)
            self.assertEqual(synthesis.synthesize_envelope.call_count, 1)
            self.assertEqual(synthesis.raw_phonemizer.call_args.args, (kokoro, 'en-gb'))


if __name__ == '__main__':
    unittest.main()
