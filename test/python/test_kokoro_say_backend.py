import io
import json
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import MagicMock, patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS))

from test_narration_plan import plan_for
from test_narration_lid_onnx import (FakeSession, assets, runtime_available, staged_reference, stub_modules,
                                     REFERENCE)
from narration_resolver import resolve_plan
import narration_lid_onnx

STUBS = {'soundfile': types.ModuleType('soundfile'), 'kokoro_onnx': types.ModuleType('kokoro_onnx')}
STUBS['kokoro_onnx'].Kokoro = MagicMock(name='Kokoro')
with patch.dict(sys.modules, STUBS):
    import kokoro_say

ABSOLUTE = str(Path(tempfile.gettempdir()).resolve() / 'lid-model')
BASE = ['--model', 'm', '--voices', 'v', '--voice', 'em_alex', '--lang', 'es', '--out', 'o.wav', '--plan-json']


def run_main(argv, stdin=''):
    out, err = io.StringIO(), io.StringIO()
    with patch.object(sys, 'stdin', io.StringIO(stdin)), patch.object(sys, 'stdout', out), redirect_stderr(err):
        try:
            code = kokoro_say.main(argv)
        except SystemExit as exit_:
            code = exit_.code
    return code, out.getvalue(), err.getvalue()


def units(result):
    return [unit for block in result['blocks'] for unit in block['units']]


def fake_kokoro(voices=('em_alex', 'am_onyx')):
    """A Kokoro factory whose instance reports a bounded voice pack for donor validation."""
    instance = MagicMock(name='KokoroInstance')
    instance.get_voices.return_value = list(voices)
    return MagicMock(name='Kokoro', return_value=instance)


class ArgumentTests(unittest.TestCase):
    def test_defaults_to_torch_with_no_lid_dir(self):
        args = kokoro_say.parse_args(BASE + ['--app-home', 'H'])
        self.assertEqual(args.lid_backend, 'torch')
        self.assertIsNone(args.lid_dir)
        kokoro_say.validate_lid_args(args)

    def test_onnx_requires_absolute_dir(self):
        args = kokoro_say.parse_args(BASE + ['--lid-backend', 'onnx', '--lid-dir', ABSOLUTE])
        kokoro_say.validate_lid_args(args)
        for bad in (['--lid-backend', 'onnx'], ['--lid-backend', 'onnx', '--lid-dir', 'relative/model'],
                    ['--lid-backend', 'onnx', '--lid-dir', ''], ['--lid-dir', ABSOLUTE],
                    ['--lid-backend', 'torch', '--lid-dir', ABSOLUTE], ['--lid-backend', 'int8'],
                    ['--lid-backend', 'ONNX', '--lid-dir', ABSOLUTE]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                kokoro_say.validate_lid_args(kokoro_say.parse_args(BASE + bad))

    def test_lid_backend_requires_plan_mode(self):
        args = kokoro_say.parse_args(['--model', 'm', '--voices', 'v', '--voice', 'x', '--lang', 'es', '--out', 'o',
                                      '--lid-backend', 'onnx', '--lid-dir', ABSOLUTE])
        with self.assertRaises(ValueError):
            kokoro_say.validate_lid_args(args)

    def test_main_rejects_with_generic_exit_2_and_no_leaked_values_before_reading_stdin(self):
        secret = 'secret-value-xyz'
        for bad in (['--lid-dir', ABSOLUTE], ['--lid-backend', 'onnx', '--lid-dir', 'rel-' + secret],
                    ['--lid-backend', secret], ['--lid-backend', 'onnx']):
            with self.subTest(bad=bad):
                code, out, err = run_main(BASE + bad, stdin='must not be read')
                self.assertEqual(code, 2)
                self.assertEqual(out, '')
                self.assertNotIn(secret, err)
                self.assertNotIn('must not', err)


class ToneArgumentTests(unittest.TestCase):
    def test_defaults_disable_the_blend(self):
        args = kokoro_say.parse_args(BASE)
        self.assertEqual(args.tone_voice, '')
        self.assertEqual(args.tone_weight, 0.0)
        kokoro_say.validate_tone_args(args)

    def test_parses_a_donor_and_a_weight(self):
        args = kokoro_say.parse_args(BASE + ['--tone-voice', 'am_onyx', '--tone-weight', '0.75'])
        self.assertEqual(args.tone_voice, 'am_onyx')
        self.assertAlmostEqual(args.tone_weight, 0.75)
        kokoro_say.validate_tone_args(args)

    def test_accepts_the_inclusive_weight_bounds(self):
        for weight in ('0', '0.0', '0.5', '1', '1.0'):
            with self.subTest(weight=weight):
                kokoro_say.validate_tone_args(kokoro_say.parse_args(BASE + ['--tone-weight=' + weight]))

    def test_rejects_a_weight_outside_the_range_or_not_finite(self):
        # The `=` form is required for negative values: argparse reads a leading `-` as an option,
        # exactly as it already does for --speed.
        for weight in ('-0.1', '1.1', '2', '-1', 'nan', 'inf', '-inf'):
            with self.subTest(weight=weight):
                args = kokoro_say.parse_args(BASE + ['--tone-weight=' + weight])
                with self.assertRaises(ValueError) as caught:
                    kokoro_say.validate_tone_args(args)
                self.assertEqual(str(caught.exception), 'invalid-tone-weight')

    def test_rejects_a_donor_absent_from_the_loaded_pack(self):
        kokoro = fake_kokoro().return_value
        with self.assertRaises(ValueError) as caught:
            kokoro_say.validate_tone_voice(kokoro, 'zz_nobody')
        self.assertEqual(str(caught.exception), 'unknown-tone-voice')

    def test_accepts_a_cross_language_donor_present_in_the_pack(self):
        kokoro = fake_kokoro().return_value
        kokoro_say.validate_tone_voice(kokoro, 'am_onyx')

    def test_an_empty_donor_never_consults_the_pack(self):
        kokoro = fake_kokoro().return_value
        kokoro_say.validate_tone_voice(kokoro, '')
        kokoro.get_voices.assert_not_called()

    def test_main_rejects_a_bad_weight_generically_before_reading_stdin(self):
        secret = 'secret-value-xyz'
        for bad in (['--tone-weight=1.5'], ['--tone-weight=nan'],
                    ['--tone-weight=-0.5', '--tone-voice', secret]):
            with self.subTest(bad=bad):
                code, out, err = run_main(BASE + bad, stdin='must not be read')
                self.assertEqual(code, 2)
                self.assertEqual(out, '')
                self.assertNotIn(secret, err)
                self.assertNotIn('must not', err)
                self.assertEqual(err, 'Narration synthesis failed\n')


class LazyImportTests(unittest.TestCase):
    CODE = (
        "import sys, types\n"
        "from unittest.mock import MagicMock\n"
        "sys.path.insert(0, %r)\n"
        "sf = types.ModuleType('soundfile'); ko = types.ModuleType('kokoro_onnx'); ko.Kokoro = MagicMock()\n"
        "sys.modules.update(soundfile=sf, kokoro_onnx=ko)\n"
        "import kokoro_say\n"
        "detector = kokoro_say.build_detector(%r, %r, %r, None)\n"
        "print(type(detector).__name__ if detector else None)\n"
        "print(sorted(n for n in ('torch', 'transformers', 'narration_lid_onnx', 'onnxruntime') if n in sys.modules))\n"
    )

    def child(self, backend, lid_dir, app_home):
        out = subprocess.run([sys.executable, '-B', '-c', self.CODE % (str(SCRIPTS), backend, lid_dir, app_home)],
                             capture_output=True, text=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        return out.stdout.strip().splitlines()

    def test_torch_path_never_imports_the_onnx_module(self):
        kind, modules = self.child('torch', None, 'H')
        self.assertEqual(kind, 'LocalDetector')
        self.assertNotIn('narration_lid_onnx', modules)
        self.assertNotIn('onnxruntime', modules)

    def test_onnx_path_never_imports_torch_or_transformers(self):
        kind, modules = self.child('onnx', ABSOLUTE, None)
        self.assertEqual(kind, 'OnnxDetector')
        for name in ('torch', 'transformers', 'onnxruntime'):
            self.assertNotIn(name, modules)

    def test_torch_without_app_home_has_no_detector(self):
        self.assertEqual(self.child('torch', None, None)[0], 'None')


class EndToEndStubTests(unittest.TestCase):
    def test_build_detector_selects_backend(self):
        self.assertIsInstance(kokoro_say.build_detector('onnx', ABSOLUTE, None, None), narration_lid_onnx.OnnxDetector)
        self.assertEqual(Path(kokoro_say.build_detector('onnx', ABSOLUTE, 'ignored', None).model_directory), Path(ABSOLUTE))
        from narration_lid import LocalDetector
        self.assertIsInstance(kokoro_say.build_detector('torch', None, 'H', None), LocalDetector)

    def test_resolve_plan_with_stub_onnx_detector_through_the_kokoro_say_path(self):
        session = FakeSession(winner='en')
        plan = plan_for('Hola getUserName local')
        with assets() as (directory, manifest), patch.dict(sys.modules, stub_modules(session)):
            detector = kokoro_say.build_detector('onnx', str(directory), None, str(manifest))
            result = resolve_plan(plan, detector)
        self.assertTrue(session.runs, 'the ONNX session must have been used')
        self.assertEqual(result['diagnostics'], [])
        self.assertTrue(result['synthesisReady'])
        self.assertTrue(any(unit['rawEvidence'] for unit in units(result)))
        # Strict schema-1 contract is untouched: no backend field leaks into the resolved plan.
        self.assertEqual(result['detectorIdentity']['integrity'], 'unverified-local-assets')
        self.assertNotIn('backend', json.dumps(result))

    def test_main_runs_the_full_plan_path_with_the_onnx_detector(self):
        session = FakeSession(winner='en')
        plan = plan_for('Hola getUserName local')
        seen = {}

        def synth(resolved, kokoro, voice, speed, out, phonemizer, tone_voice='', tone_weight=0.0):
            seen.update(resolved=resolved, voice=voice, out=out, tone_voice=tone_voice, tone_weight=tone_weight)

        with assets() as (directory, manifest), patch.dict(sys.modules, stub_modules(session)), \
                patch.object(kokoro_say, 'Kokoro', fake_kokoro()), \
                patch('narration_synthesis.synthesize_envelope', synth), \
                patch('narration_synthesis.raw_phonemizer', lambda *a: None):
            code, out, err = run_main(BASE + ['--app-home', 'IGNORED', '--lid-manifest', str(manifest),
                                              '--lid-backend', 'onnx', '--lid-dir', str(directory)], json.dumps(plan))
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out), {'diagnostics': []})
        self.assertTrue(session.runs)
        self.assertEqual(seen['voice'], 'em_alex')
        self.assertEqual(seen['resolved']['resolvedSchemaVersion'], 1)
        self.assertEqual((seen['tone_voice'], seen['tone_weight']), ('', 0.0))

    def test_main_threads_the_tone_blend_into_the_plan_call(self):
        session = FakeSession(winner='en')
        plan = plan_for('Hola getUserName local')
        seen = {}

        def synth(resolved, kokoro, voice, speed, out, phonemizer, tone_voice='', tone_weight=0.0):
            seen.update(voice=voice, tone_voice=tone_voice, tone_weight=tone_weight)

        with assets() as (directory, manifest), patch.dict(sys.modules, stub_modules(session)), \
                patch.object(kokoro_say, 'Kokoro', fake_kokoro()), \
                patch('narration_synthesis.synthesize_envelope', synth), \
                patch('narration_synthesis.raw_phonemizer', lambda *a: None):
            code, out, err = run_main(BASE + ['--lid-manifest', str(manifest), '--lid-backend', 'onnx',
                                              '--lid-dir', str(directory), '--tone-voice', 'am_onyx',
                                              '--tone-weight', '0.75'], json.dumps(plan))
        self.assertEqual(code, 0, err)
        # The timbre voice is untouched by the donor, so --lang keeps following it.
        self.assertEqual(seen['voice'], 'em_alex')
        self.assertEqual(seen['tone_voice'], 'am_onyx')
        self.assertAlmostEqual(seen['tone_weight'], 0.75)

    def test_main_rejects_an_unknown_donor_generically_after_loading_the_pack(self):
        plan = plan_for('Hola local')
        with assets() as (directory, manifest), patch.dict(sys.modules, stub_modules(FakeSession(winner='en'))), \
                patch.object(kokoro_say, 'Kokoro', fake_kokoro()), \
                patch('narration_synthesis.synthesize_envelope') as synth, \
                patch('narration_synthesis.raw_phonemizer', lambda *a: None):
            code, out, err = run_main(BASE + ['--lid-manifest', str(manifest), '--lid-backend', 'onnx',
                                              '--lid-dir', str(directory), '--tone-voice', 'zz_nobody',
                                              '--tone-weight', '0.75'],
                                      json.dumps(plan))
        self.assertEqual(code, 2)
        self.assertEqual(out, '')
        self.assertEqual(err, 'Narration synthesis failed\n')
        self.assertNotIn('zz_nobody', err)
        synth.assert_not_called()

    def test_main_skips_unknown_donor_lookup_when_weight_is_zero(self):
        plan = plan_for('Hola local')
        factory = fake_kokoro()
        with assets() as (directory, manifest), patch.dict(sys.modules, stub_modules(FakeSession(winner='en'))), \
                patch.object(kokoro_say, 'Kokoro', factory), \
                patch('narration_synthesis.synthesize_envelope') as synth, \
                patch('narration_synthesis.raw_phonemizer', lambda *a: None):
            code, out, err = run_main(BASE + ['--lid-manifest', str(manifest), '--lid-backend', 'onnx',
                                              '--lid-dir', str(directory), '--tone-voice', 'zz_nobody',
                                              '--tone-weight', '0'], json.dumps(plan))
        self.assertEqual(code, 0, err)
        self.assertEqual(err, '')
        self.assertEqual(json.loads(out), {'diagnostics': []})
        factory.return_value.get_voices.assert_not_called()
        synth.assert_called_once()
        self.assertEqual(synth.call_args.kwargs, {'tone_voice': 'zz_nobody', 'tone_weight': 0.0})

    def test_main_failure_stays_generic(self):
        plan = plan_for('Hola local')
        with patch.object(kokoro_say, 'Kokoro', MagicMock(side_effect=RuntimeError('secret prose'))), \
                patch.dict(sys.modules, stub_modules()):
            code, out, err = run_main(BASE + ['--lid-backend', 'onnx', '--lid-dir', ABSOLUTE], json.dumps(plan))
        self.assertEqual(code, 2)
        self.assertEqual(out, '')
        self.assertEqual(err, 'Narration synthesis failed\n')

    def test_missing_onnx_assets_become_a_bounded_diagnostic_not_a_failure(self):
        plan = plan_for('Hola local')
        with tempfile.TemporaryDirectory() as root, patch.object(kokoro_say, 'Kokoro', fake_kokoro()), \
                patch('narration_synthesis.synthesize_envelope', lambda *a, **k: None), \
                patch('narration_synthesis.raw_phonemizer', lambda *a: None):
            code, out, err = run_main(BASE + ['--lid-backend', 'onnx', '--lid-dir', str(Path(root) / 'absent')],
                                      json.dumps(plan))
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out), {'diagnostics': ['detector-unavailable', 'missing-local-assets']})


@unittest.skipUnless((REFERENCE / 'model.onnx').is_file() and (REFERENCE / 'tokenizer' / 'tokenizer.json').is_file()
                     and runtime_available(), 'reference ONNX assets or runtime are absent')
class RealAssetEndToEndTests(unittest.TestCase):
    def test_resolve_plan_with_the_real_onnx_detector_through_build_detector(self):
        plan = plan_for('no cambies el deployment')
        with staged_reference() as directory:
            detector = kokoro_say.build_detector('onnx', str(directory), None, str(narration_lid_onnx.MANIFEST_PATH))
            result = resolve_plan(plan, detector)
        self.assertEqual(result['diagnostics'], [])
        self.assertTrue(result['synthesisReady'])
        self.assertTrue(any(unit['rawEvidence'] for unit in units(result)))
        self.assertTrue(any(unit['language'] == 'en' for unit in units(result)))
        self.assertEqual(result['detectorIdentity']['integrity'], 'unverified-local-assets')


if __name__ == '__main__':
    unittest.main()
