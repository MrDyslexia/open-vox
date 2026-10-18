"""Qualification evidence tests; synthetic events only, never real assets."""
import sys
import unittest
import socket
import json
import tempfile
import contextlib
import io
import os
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))
import qualify_gpu as qualify


class EvidenceTests(unittest.TestCase):
    def test_temp_scope_restores_absent_environment_keys_and_empty_cache_on_failure(self):
        approved = Path(os.environ['LOCALAPPDATA']) / 'Temp' / 'opencode'
        with tempfile.TemporaryDirectory(dir=approved) as directory:
            out = Path(directory)
            with patch.dict(os.environ), patch.object(tempfile, 'tempdir', None):
                os.environ.pop('TEMP', None)
                os.environ.pop('TMP', None)
                with self.assertRaisesRegex(RuntimeError, 'mock failure'):
                    with qualify.qualification_tempdir(out):
                        self.assertEqual(tempfile.gettempdir(), str(out))
                        raise RuntimeError('mock failure')
                self.assertNotIn('TEMP', os.environ)
                self.assertNotIn('TMP', os.environ)
                self.assertIsNone(tempfile.tempdir)

    def test_invalid_or_redirected_output_is_rejected_before_imports_or_temp_changes(self):
        approved = Path(os.environ['LOCALAPPDATA']) / 'Temp' / 'opencode'
        with tempfile.TemporaryDirectory(dir=approved) as directory:
            home = Path(directory) / 'home'
            root = home / 'kokoro-gpu-venv'
            before, cached = dict(os.environ), tempfile.tempdir
            paths = [Path('relative-output'), approved, approved.parent / 'outside-output',
                     Path(directory) / 'unused' / '..' / 'output']
            with patch.object(sys, 'prefix', str(root)), patch.object(qualify.probe, 'inspect_environment') as inspect:
                for out in paths:
                    with self.subTest(path=out), self.assertRaises(qualify.probe.ProbeError):
                        qualify.run(home, out)
                with patch.object(qualify.probe, 'safe_path', side_effect=qualify.probe.ProbeError('mock junction')):
                    with self.assertRaises(qualify.probe.ProbeError):
                        qualify.run(home, Path(directory) / 'redirected-output')
                inspect.assert_not_called()
            self.assertEqual(dict(os.environ), before)
            self.assertIs(tempfile.tempdir, cached)

    def test_child_temp_environment_and_cached_tempdir_are_scoped_before_third_party_work(self):
        approved = Path(os.environ['LOCALAPPDATA']) / 'Temp' / 'opencode'
        for fail in (False, True):
            with self.subTest(failure=fail), tempfile.TemporaryDirectory(dir=approved) as directory:
                base = Path(directory)
                home, out = base / 'home', base / 'output'
                root = home / 'kokoro-gpu-venv'
                root.mkdir(parents=True)
                (root / 'gpu-dependencies.json').write_text('{"mock":true}', encoding='utf-8')
                ambient = str(base / 'ambient-temp')
                phases = []
                def boundary(phase):
                    phases.append(phase)
                    self.assertEqual(os.environ['TEMP'], str(out))
                    self.assertEqual(os.environ['TMP'], str(out))
                    self.assertEqual(tempfile.gettempdir(), str(out))
                    # Exercise the same default mkdtemp API phonemizer uses, but
                    # only after proving it cannot write outside approved output.
                    self.assertEqual(Path(tempfile.mkdtemp()).parent, out)
                def inspect(*args):
                    boundary('dependency-imports')
                    return {'mock': True}
                def models(*args):
                    boundary('model-imports')
                    if fail:
                        raise RuntimeError('mock inference failure')
                    return ({'kokoro': {'cudaComputeNodes': 1, 'cpuNodes': 0}},
                            {'kokoro': [{'cat': 'Node', 'provider': 'CUDAExecutionProvider', 'op': 'Conv', 'count': 1}]})
                with patch.dict(os.environ, {'TEMP': ambient, 'TMP': ambient}), patch.object(tempfile, 'tempdir', ambient), \
                        patch.object(sys, 'prefix', str(root)), patch.object(qualify.probe, 'inspect_environment', side_effect=inspect), \
                        patch.object(qualify, 'assets', return_value={}), patch.object(qualify, 'qualify_models', side_effect=models):
                    before = dict(os.environ)
                    if fail:
                        with self.assertRaises(RuntimeError):
                            qualify.run(home, out)
                    else:
                        qualify.run(home, out)
                    self.assertEqual(dict(os.environ), before)
                    self.assertEqual(tempfile.tempdir, ambient)
                self.assertEqual(phases, ['dependency-imports', 'model-imports'])
                self.assertEqual((root / 'gpu-qualification.json').exists(), not fail)

    def test_realistic_repeated_profile_events_are_aggregated_with_raw_trace_hash(self):
        with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()) / 'opencode') as directory:
            out = Path(directory)
            path = out / 'synthetic-profile.json'
            event = {'cat': 'Node', 'name': 'matmul_kernel_time', 'args': {'provider': 'CUDAExecutionProvider', 'op_name': 'MatMul'}}
            path.write_text(json.dumps([event] * 4000), encoding='utf-8')
            counts, safe = qualify.finish_profile(SimpleNamespace(end_profiling=lambda: str(path)), out)
            self.assertEqual(counts['cudaComputeNodes'], 4000)
            self.assertEqual(counts['sourceProfileSha256'], qualify.probe.sha256(path))
            self.assertEqual(safe, [{'cat': 'Node', 'provider': 'CUDAExecutionProvider', 'op': 'MatMul', 'count': 4000}])
            self.assertLess(len(json.dumps(safe)), 1024)

    def test_failed_main_is_nonzero_and_never_leaks_exception_prose_or_success(self):
        output = io.StringIO()
        with patch.object(qualify, 'run', side_effect=RuntimeError('private path and input')), contextlib.redirect_stdout(output):
            self.assertEqual(qualify.main(['--home', 'unused', '--out', 'unused']), 1)
        self.assertEqual(json.loads(output.getvalue()), {'qualified': False, 'code': 'offline-cuda-qualification-failed'})

    def test_offline_guard_blocks_python_networking_and_restores_it(self):
        original = socket.getaddrinfo
        with qualify.offline_network():
            with self.assertRaises(RuntimeError):
                socket.getaddrinfo('must-not-resolve.invalid', 443)
        self.assertIs(socket.getaddrinfo, original)

    def test_mock_qualification_publishes_only_after_all_evidence_and_preserves_failures(self):
        temp_root = Path(tempfile.gettempdir()) / 'opencode'
        with tempfile.TemporaryDirectory(dir=temp_root) as temporary:
            home = Path(temporary) / 'home'
            root = home / 'kokoro-gpu-venv'
            root.mkdir(parents=True)
            marker = root / 'gpu-dependencies.json'
            marker.write_text('{"mock":true}', encoding='utf-8')
            identity = {'mock': True}
            events = [{'cat': 'Node', 'provider': 'CUDAExecutionProvider', 'op': 'Conv', 'count': 1}]
            models = {'kokoro': {'cudaComputeNodes': 1, 'cpuNodes': 0, 'sourceProfileSha256': 'a' * 64}}
            with patch.object(sys, 'prefix', str(root)), patch.object(qualify.probe, 'inspect_environment', return_value=identity), \
                    patch.object(qualify, 'assets', return_value={'mock': {'sha256': 'a' * 64}}), \
                    patch.object(qualify, 'qualify_models', side_effect=RuntimeError('private')):
                with self.assertRaises(RuntimeError):
                    qualify.run(home, Path(temporary) / 'failed-output')
                self.assertFalse((root / 'gpu-qualification.json').exists())
                self.assertTrue((Path(temporary) / 'failed-output').is_dir())
            with patch.object(sys, 'prefix', str(root)), patch.object(qualify.probe, 'inspect_environment', return_value=identity), \
                    patch.object(qualify, 'assets', return_value={'mock': {'sha256': 'a' * 64}}), \
                    patch.object(qualify, 'qualify_models', return_value=(models, {'kokoro': events})):
                qualify.run(home, Path(temporary) / 'success-output')
                record = json.loads((root / 'gpu-qualification.json').read_text(encoding='utf-8'))
                self.assertTrue(record['qualified'])
                self.assertEqual(record['models']['kokoro']['sha256'], qualify.probe.sha256(root / 'kokoro-cuda-evidence.json'))
                with self.assertRaises(qualify.probe.ProbeError):
                    qualify.run(home, Path(temporary) / 'repeat-output')

    def test_provider_advertisement_or_memory_copy_is_not_compute(self):
        for events in ([], [{'cat': 'Session', 'args': {'provider': 'CUDAExecutionProvider'}}],
                       [{'cat': 'Node', 'name': 'Memcpy_kernel_time', 'args': {'provider': 'CUDAExecutionProvider', 'op_name': 'MemcpyFromHost'}}]):
            with self.assertRaises(ValueError):
                qualify.compute_evidence(events)

    def test_cuda_compute_and_cpu_shape_operations_reported_separately(self):
        events = [
            {'cat': 'Node', 'name': 'matmul_kernel_time', 'args': {'provider': 'CUDAExecutionProvider', 'op_name': 'MatMul'}},
            {'cat': 'Node', 'name': 'shape_kernel_time', 'args': {'provider': 'CPUExecutionProvider', 'op_name': 'Shape'}},
        ]
        self.assertEqual(qualify.compute_evidence(events), {'cudaComputeNodes': 1, 'cpuNodes': 1})

    def test_malformed_or_unbounded_events_fail_closed(self):
        for events in ({}, [None], [{'cat': 'Node', 'name': 'x_kernel_time', 'args': None}]):
            with self.assertRaises(ValueError):
                qualify.compute_evidence(events)


if __name__ == '__main__':
    unittest.main()
