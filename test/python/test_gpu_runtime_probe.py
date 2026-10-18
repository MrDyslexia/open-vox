"""Managed preloading policy tests; no installed native runtime is imported."""
import sys
import unittest
import tempfile
import importlib.metadata as metadata
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from unittest.mock import patch
from pip._vendor import packaging
from pip._vendor.packaging import requirements, utils

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import gpu_runtime_probe as probe


class PreloadTests(unittest.TestCase):
    def test_eager_import_exception_is_only_windows_dlinfo(self):
        wheel = {'name': 'dlinfo', 'module': 'dlinfo', 'version': '2.0.0'}
        self.assertFalse(probe.eager_import_applicable(wheel, 'win32'))
        for platform in ('linux', 'darwin'):
            self.assertTrue(probe.eager_import_applicable(wheel, platform))
        self.assertTrue(probe.eager_import_applicable({**wheel, 'name': 'other'}, 'win32'))
        self.assertTrue(probe.eager_import_applicable({**wheel, 'module': 'other'}, 'win32'))

    def test_bundled_lock_has_the_same_seal_and_explicit_namespace_mapping(self):
        lock = probe.load_lock()
        self.assertEqual(len(lock['wheels']), 38)
        self.assertNotIn('onnxruntime', [w['name'] for w in lock['wheels']])
        self.assertTrue(all(w['module'] is None for w in lock['wheels'] if w['name'].startswith('nvidia-')))

    def test_preload_is_explicit_and_keeps_handles_without_stdout(self):
        ort = SimpleNamespace(preload_dlls=Mock())
        handle = object()
        handles = probe.preload(ort, ['managed/cuda', 'managed/cudnn'], add_directory=Mock(return_value=handle))
        self.assertEqual(handles, [handle, handle])
        ort.preload_dlls.assert_called_once_with(directory='')

    def test_warning_or_prose_is_failure_not_json_pollution(self):
        def noisy(**kwargs):
            print('private native path')
        for action in (noisy, Mock(side_effect=OSError('private'))):
            with self.assertRaises(probe.ProbeError):
                probe.preload(SimpleNamespace(preload_dlls=action), [], add_directory=Mock())

    def test_only_kokoro_cpu_distribution_requirement_has_equivalence(self):
        versions = {'onnxruntime-gpu': '1.31.0', 'numpy': '2.5.3'}
        # Tests use the base interpreter's bundled parser; production requires the
        # lock's provenance-checked packaging distribution in the new environment.
        with patch.dict(sys.modules, {'packaging': packaging, 'packaging.requirements': requirements, 'packaging.utils': utils}):
            self.assertTrue(probe.requirement_satisfied('kokoro-onnx', 'onnxruntime>=1.20.1', versions))
            self.assertFalse(probe.requirement_satisfied('other', 'onnxruntime>=1.20.1', versions))
            self.assertFalse(probe.requirement_satisfied('kokoro-onnx', 'onnxruntime>=2', versions))
            self.assertFalse(probe.requirement_satisfied('other', 'missing>=1', versions))
            self.assertFalse(probe.requirement_satisfied('other', 'numpy>=3', versions))


class ManagedProbeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()) / 'opencode')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'kokoro-gpu-venv'
        self.site = self.root / 'Lib' / 'site-packages'
        self.site.mkdir(parents=True)
        (self.root / 'Scripts').mkdir()
        (self.root / 'Scripts' / 'python.exe').write_bytes(b'mock launcher, not executable')
        (self.site / 'sample.py').write_text('# mock module\n', encoding='utf-8')
        (self.site / 'sample-1.0.dist-info').mkdir()
        (self.site / 'sample-1.0.dist-info' / 'METADATA').write_text('Name: sample\nVersion: 1.0\n', encoding='utf-8')
        self.dist = SimpleNamespace(version='1.0', requires=[],
                                    files=[metadata.PackagePath('sample.py'), metadata.PackagePath('sample-1.0.dist-info/METADATA')],
                                    locate_file=lambda item: self.site / str(item))
        self.lock = {'wheels': [{'name': 'sample', 'version': '1.0', 'role': 'common', 'module': 'sample'}]}
        self.origin = self.site / 'sample.py'
        self.mixed = False
        self.extra_distributions = {}
        self.module_origins = {}

    def distribution(self, name):
        if name in self.extra_distributions:
            return self.extra_distributions[name]
        if name == 'sample' or (name == 'onnxruntime' and self.mixed):
            return self.dist
        raise metadata.PackageNotFoundError(name)

    def spec(self, name):
        if name == 'nvidia':
            return SimpleNamespace(origin=None, submodule_search_locations=[str(self.site / 'nvidia')])
        return SimpleNamespace(origin=str(self.module_origins.get(name, self.origin)), submodule_search_locations=None)

    def inspect(self, *, load=False, importer=None):
        with patch.object(sys, 'prefix', str(self.root)), patch.object(sys, 'base_prefix', str(Path(self.temporary.name) / 'base')), \
                patch.object(sys, 'executable', str(self.root / 'Scripts' / 'python.exe')), patch.object(sys, 'version_info', (3, 13, 15)), \
                patch.object(sys, 'platform', 'win32'), patch.object(probe, 'load_lock', return_value=self.lock), \
                patch.object(probe.metadata, 'distribution', side_effect=self.distribution), \
                patch.object(probe.importlib.util, 'find_spec', side_effect=self.spec), \
                patch.object(probe, 'load_native'), \
                patch.object(probe.importlib, 'import_module', side_effect=importer or AssertionError('must not execute managed imports')):
            return probe.inspect_environment(self.root, 'kokoro', load=load)

    def add_dlinfo(self):
        (self.site / 'dlinfo.py').write_text('# Mock Windows-inapplicable module; never execute it.\n', encoding='utf-8')
        (self.site / 'dlinfo-2.0.0.dist-info').mkdir()
        (self.site / 'dlinfo-2.0.0.dist-info' / 'METADATA').write_text('Name: dlinfo\nVersion: 2.0.0\n', encoding='utf-8')
        dist = SimpleNamespace(version='2.0.0', requires=[],
                               files=[metadata.PackagePath('dlinfo.py'), metadata.PackagePath('dlinfo-2.0.0.dist-info/METADATA')],
                               locate_file=lambda item: self.site / str(item))
        self.extra_distributions['dlinfo'] = dist
        self.module_origins['dlinfo'] = self.site / 'dlinfo.py'
        self.lock['wheels'].append({'name': 'dlinfo', 'version': '2.0.0', 'role': 'common', 'module': 'dlinfo'})
        return dist

    def test_windows_readiness_checks_dlinfo_without_executing_its_native_import(self):
        self.add_dlinfo()
        imported = []
        def importer(name):
            imported.append(name)
            if name == 'dlinfo':
                raise AssertionError('Windows must not execute dlinfo native initialization')
            return SimpleNamespace(__file__=str(self.origin), Kokoro=SimpleNamespace(from_session=lambda: None))
        record = self.inspect(load=True, importer=importer)
        self.assertNotIn('dlinfo', imported)
        self.assertIn('sample', imported)
        self.assertEqual(record['packages']['dlinfo'], '2.0.0')
        self.assertIn('Lib/site-packages/dlinfo.py', record['files'])
        self.assertIn('Lib/site-packages/dlinfo-2.0.0.dist-info/METADATA', record['files'])

    def test_windows_import_exception_keeps_dlinfo_pin_and_origin_mandatory(self):
        dist = self.add_dlinfo()
        dist.version = '2.0.1'
        with self.assertRaises(probe.ProbeError):
            self.inspect()
        dist.version = '2.0.0'
        self.module_origins['dlinfo'] = Path(self.temporary.name) / 'foreign-dlinfo.py'
        with self.assertRaises(probe.ProbeError):
            self.inspect()

    def test_windows_dlinfo_pin_is_rechecked_after_other_imports(self):
        dist = self.add_dlinfo()
        def importer(name):
            self.assertNotEqual(name, 'dlinfo')
            dist.version = '2.0.1'
            return SimpleNamespace(__file__=str(self.origin))
        with self.assertRaises(probe.ProbeError):
            self.inspect(load=True, importer=importer)

    def test_identity_and_package_file_stamps_are_bound_without_native_imports(self):
        record = self.inspect()
        self.assertEqual(record['root'], str(self.root))
        self.assertEqual(record['packages'], {'sample': '1.0'})
        self.assertEqual(record['executableSha256'], probe.sha256(self.root / 'Scripts' / 'python.exe'))
        self.assertIn('Lib/site-packages/sample-1.0.dist-info/METADATA', record['files'])

    def test_foreign_module_origin_is_rejected_before_import(self):
        self.origin = Path(self.temporary.name) / 'foreign.py'
        with self.assertRaises(probe.ProbeError):
            self.inspect()

    def test_foreign_distribution_root_is_rejected_before_import(self):
        self.dist.locate_file = lambda item: Path(self.temporary.name) / str(item)
        with self.assertRaises(probe.ProbeError):
            self.inspect()

    def test_mixed_cpu_gpu_distribution_and_wrong_pin_are_rejected(self):
        self.mixed = True
        with self.assertRaises(probe.ProbeError):
            self.inspect()
        self.mixed = False
        self.dist.version = '2.0'
        with self.assertRaises(probe.ProbeError):
            self.inspect()

    def test_unrecorded_or_corrupt_native_dll_is_rejected_before_import(self):
        item = metadata.PackagePath('mock.dll')
        (self.site / 'mock.dll').write_bytes(b'not a native library')
        self.dist.files.append(item)
        for file_hash in (None, SimpleNamespace(mode='sha256', value='incorrect')):
            item.hash = file_hash
            with self.assertRaises(probe.ProbeError):
                self.inspect()


if __name__ == '__main__':
    unittest.main()
