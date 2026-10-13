import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import narration_lid_onnx as backend
from narration_lid_onnx import (BACKEND, CHECKPOINT, FILES, LABELS, REVISION, OnnxDetector,
                                validate_manifest, verify_local_assets)
from narration_resolver import detector_result

REFERENCE = Path(os.environ.get('OPEN_VOX_TEST_ONNX_ASSETS', str(Path(tempfile.gettempdir()) / 'open-vox-reference-assets' / 'assets')))
TEST_PYTHON = os.environ.get('OPEN_VOX_TEST_PYTHON') or sys.executable


class Logits:
    def __init__(self, rows, shape=None, dtype='float32'):
        self.rows, self.dtype = rows, dtype
        self.shape = shape if shape is not None else (1, len(rows), len(rows[0]) if rows else 0)

    def tolist(self):
        return [self.rows]


class Array:
    def __init__(self, values, dtype=None):
        self.values, self.dtype = values, dtype
        self.shape = (len(values), len(values[0])) if values else (0,)


NP = SimpleNamespace(int64='int64', float32='float32', asarray=lambda values, dtype=None: Array(values, dtype))


class FakeTokenizer:
    """Codepoint offsets like the real tokenizer; `piece` characters per token (0 = one per atom)."""

    def __init__(self, piece=1):
        self.piece = piece

    def __call__(self, text, add_special_tokens=True, truncation=False, return_offsets_mapping=False):
        assert truncation is False and add_special_tokens is True
        offsets, index = [], 0
        while index < len(text):
            if text[index].isspace():
                index += 1
                continue
            end = index + 1
            while end < len(text) and not text[end].isspace() and (end - index) % self.piece:
                end += 1
            offsets.append((index, end))
            index = end
        offsets = [(0, 0)] + offsets + [(0, 0)]
        encoded = {'input_ids': list(range(len(offsets)))}
        if return_offsets_mapping:
            encoded.update(token_type_ids=[0] * len(offsets), attention_mask=[1] * len(offsets),
                           offset_mapping=offsets)
        return encoded


class FakeSession:
    def __init__(self, winner='en', rows=None, output_name='logits'):
        self.winner, self.rows, self.runs, self.output_name = winner, rows, [], output_name

    def get_inputs(self):
        return [SimpleNamespace(name=n, type='tensor(int64)') for n in backend.INPUT_NAMES]

    def get_outputs(self):
        return [SimpleNamespace(name=self.output_name)]

    def get_providers(self):
        return ['CPUExecutionProvider']

    def disable_fallback(self):
        pass

    def run(self, names, feeds):
        assert names == ['logits'] and set(feeds) == set(backend.INPUT_NAMES)
        size = len(feeds['input_ids'].values[0])
        self.runs.append(size)
        row = [8.0 if label == self.winner else 0.0 for label in LABELS]
        return [Logits(self.rows or [list(row) for _ in range(size)], None if self.rows is None else (1, size, 9))]


def config():
    return {'id2label': {str(i): label for i, label in enumerate(LABELS)},
            'label2id': {label: i for i, label in enumerate(LABELS)},
            'model_type': 'bert', 'architectures': ['BertForTokenClassification'],
            'max_position_embeddings': 512}


@contextmanager
def assets():
    """Tiny hashed fixtures; no real weights, no dependencies, no network."""
    with tempfile.TemporaryDirectory() as root:
        directory = Path(root) / 'model'
        (directory / 'tokenizer').mkdir(parents=True)
        entries = []
        for name in FILES:
            data = json.dumps(config()).encode() if name == 'tokenizer/config.json' else b'fixture'
            (directory / name).write_bytes(data)
            entries.append(dict(filename=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
        manifest = Path(root) / 'manifest.json'
        value = json.loads(backend.MANIFEST_PATH.read_text(encoding='utf-8'))
        value['files'] = entries
        manifest.write_text(json.dumps(value), encoding='utf-8')
        with patch('narration_lid_onnx.MANIFEST_PATH', manifest):
            yield directory, manifest


def ready(session=None, tokenizer=None):
    detector = OnnxDetector('not-loaded')
    detector._runtime = (NP, tokenizer or FakeTokenizer(), session or FakeSession())
    return detector


def stub_modules(session=None, tokenizer_error=None, session_error=None):
    session = session or FakeSession()

    def create(*args, **kwargs):
        if session_error:
            raise session_error
        return session

    ort = SimpleNamespace(SessionOptions=lambda: SimpleNamespace(), InferenceSession=create)
    def encode(text, add_special_tokens=True):
        data = FakeTokenizer()(text, return_offsets_mapping=True)
        return SimpleNamespace(ids=data['input_ids'], type_ids=data['token_type_ids'],
                               attention_mask=data['attention_mask'], offsets=data['offset_mapping'])

    backend_tokenizer = SimpleNamespace(no_padding=lambda: None, no_truncation=lambda: None,
                                        token_to_id=lambda name: 0, encode=encode)

    def from_file(path):
        if tokenizer_error:
            raise tokenizer_error
        return backend_tokenizer

    return {'numpy': NP, 'onnxruntime': ort, 'tokenizers': SimpleNamespace(Tokenizer=SimpleNamespace(from_file=from_file))}


class ManifestTests(unittest.TestCase):
    def test_bundled_manifest_is_strict_and_records_derivation(self):
        value = validate_manifest(json.loads(backend.MANIFEST_PATH.read_text(encoding='utf-8')))
        self.assertEqual(value['backend'], 'onnx-fp32')
        self.assertEqual(value['derivedFrom'], {'checkpoint': CHECKPOINT, 'revision': REVISION})
        self.assertEqual([e['filename'] for e in value['files']], list(FILES))
        sizes = {e['filename']: e['bytes'] for e in value['files']}
        self.assertEqual(sizes['model.onnx'], 709298327)
        self.assertEqual(value['runtime'], {'numpy': '2.5.3', 'onnxruntime': '1.31', 'tokenizers': '0.23.3'})
        # The derived assets must not claim the Hub pin as their own provenance.
        self.assertNotIn('revision', value)
        self.assertNotIn('modelId', value)
        hashes = {e['filename']: e['sha256'] for e in value['files']}
        self.assertEqual(BACKEND['graphSha256'], hashes['model.onnx'])
        self.assertEqual(BACKEND['tokenizerSha256'], hashes['tokenizer/tokenizer.json'])

    def test_manifest_rejects_unsafe_values(self):
        original = json.loads(backend.MANIFEST_PATH.read_text(encoding='utf-8'))
        mutations = [
            lambda v: v.update(backend='onnx-int8'), lambda v: v.update(schemaVersion=True),
            lambda v: v.update(url='https://evil.test'), lambda v: v['derivedFrom'].update(revision='main'),
            lambda v: v['files'][0].update(filename='../model.onnx'), lambda v: v['files'][0].update(sha256='A' * 64),
            lambda v: v['files'][0].update(bytes=True), lambda v: v['files'][0].update(url='x'),
            lambda v: v['files'].pop(), lambda v: v['runtime'].update(torch='2'),
        ]
        for mutate in mutations:
            changed = json.loads(json.dumps(original))
            mutate(changed)
            with self.subTest(mutation=mutations.index(mutate)), self.assertRaises(ValueError):
                validate_manifest(changed)


class IntegrityTests(unittest.TestCase):
    def detect(self, directory, manifest):
        with patch.dict(sys.modules, {'numpy': None, 'onnxruntime': None, 'tokenizers': None}):
            return OnnxDetector(directory, manifest).detect('word')['diagnostics']

    def test_missing_directory_and_none(self):
        self.assertEqual(OnnxDetector('does-not-exist').detect('word')['diagnostics'], ['missing-local-assets'])
        self.assertEqual(OnnxDetector(None).detect('word')['diagnostics'], ['invalid-local-model-directory'])

    def test_missing_file(self):
        with assets() as (directory, manifest):
            (directory / 'tokenizer' / 'vocab.txt').unlink()
            self.assertEqual(self.detect(directory, manifest), ['missing-local-assets'])

    def test_corrupt_file_never_reaches_dependencies_and_failure_is_cached(self):
        with assets() as (directory, manifest):
            (directory / 'model.onnx').write_bytes(b'corrupt')
            detector = OnnxDetector(directory, manifest)
            with patch.dict(sys.modules, {'numpy': None, 'onnxruntime': None, 'tokenizers': None}), \
                    patch('narration_lid_onnx.verify_local_assets', wraps=verify_local_assets) as verify:
                self.assertEqual(detector.detect('one')['diagnostics'], ['local-model-integrity-failed'])
                self.assertEqual(detector.detect('two')['diagnostics'], ['local-model-integrity-failed'])
                verify.assert_called_once()

    def test_same_size_corruption(self):
        with assets() as (directory, manifest):
            (directory / 'tokenizer' / 'tokenizer.json').write_bytes(b'fixturX')
            self.assertEqual(self.detect(directory, manifest), ['local-model-integrity-failed'])

    def test_extra_files_and_directories(self):
        for extra in ('extra.bin', 'tokenizer/extra.json', 'sub/inner.txt'):
            with self.subTest(extra=extra), assets() as (directory, manifest):
                (directory / extra).parent.mkdir(exist_ok=True)
                (directory / extra).write_text('{}')
                self.assertEqual(self.detect(directory, manifest), ['local-model-integrity-failed'])
        with assets() as (directory, manifest):
            (directory / 'emptydir').mkdir()
            self.assertEqual(self.detect(directory, manifest), ['local-model-integrity-failed'])

    def test_symlinked_asset_is_rejected(self):
        with assets() as (directory, manifest):
            target = directory.parent / 'target.bin'
            target.write_bytes(b'fixture')
            (directory / 'model.onnx').unlink()
            try:
                (directory / 'model.onnx').symlink_to(target)
            except OSError:
                self.skipTest('symlinks unavailable')
            self.assertEqual(self.detect(directory, manifest), ['local-model-integrity-failed'])

    def test_transport_manifest_cannot_replace_bundled_pin(self):
        with assets() as (directory, manifest):
            other = manifest.with_name('other.json')
            value = json.loads(manifest.read_text())
            value['files'][0]['sha256'] = '0' * 64
            other.write_text(json.dumps(value), encoding='utf-8')
            self.assertEqual(self.detect(directory, other), ['local-model-integrity-failed'])

    def test_verify_local_assets_accepts_exact_set(self):
        with assets() as (directory, manifest):
            verify_local_assets(directory, manifest)


class LoadTests(unittest.TestCase):
    def test_missing_dependencies(self):
        for missing in ('numpy', 'onnxruntime', 'tokenizers'):
            with self.subTest(missing=missing), assets() as (directory, manifest):
                modules = dict(stub_modules(), **{missing: None})
                with patch.dict(sys.modules, modules):
                    result = OnnxDetector(directory, manifest).detect('word')
                self.assertEqual(result['diagnostics'], ['missing-detector-dependencies'])
                self.assertEqual(result['status'], 'unavailable')

    def test_bad_config(self):
        for bad in ([], {'id2label': {'0': 'LABEL_0'}}, dict(config(), max_position_embeddings=1024)):
            with assets() as (directory, manifest):
                data = json.dumps(bad).encode()
                path = directory / 'tokenizer' / 'config.json'
                path.write_bytes(data)
                value = json.loads(manifest.read_text())
                entry = next(e for e in value['files'] if e['filename'] == 'tokenizer/config.json')
                entry.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
                manifest.write_text(json.dumps(value))
                with patch.dict(sys.modules, stub_modules()):
                    self.assertEqual(OnnxDetector(directory, manifest).detect('word')['diagnostics'],
                                     ['invalid-local-model-config'])

    def test_load_failures_have_no_exception_text(self):
        for kwargs in ({'session_error': RuntimeError('secret prose')}, {'tokenizer_error': Exception('secret prose')}):
            with assets() as (directory, manifest), patch.dict(sys.modules, stub_modules(**kwargs)):
                result = OnnxDetector(directory, manifest).detect('word')
                self.assertEqual(result['diagnostics'], ['local-model-load-failed'])
                self.assertNotIn('secret', json.dumps(result))

    def test_unexpected_graph_signature_is_rejected(self):
        with assets() as (directory, manifest), patch.dict(sys.modules, stub_modules(FakeSession(output_name='hidden'))):
            self.assertEqual(OnnxDetector(directory, manifest).detect('word')['diagnostics'], ['invalid-loaded-model'])

    def test_loads_once_cpu_only_and_detects(self):
        session = FakeSession()
        with assets() as (directory, manifest), patch.dict(sys.modules, stub_modules(session)), \
                patch('narration_lid_onnx.verify_local_assets', wraps=verify_local_assets) as verify:
            detector = OnnxDetector(directory, manifest)
            self.assertEqual(detector.detect('word')['status'], 'available')
            self.assertEqual(detector.detect('another')['status'], 'available')
            verify.assert_called_once()

    def test_import_is_lazy_and_never_pulls_torch_or_transformers(self):
        code = ('import sys; sys.path.insert(0, %r); import narration_lid_onnx as m; '
                'r = m.OnnxDetector("missing-dir").detect("hola"); '
                'assert r["diagnostics"] == ["missing-local-assets"]; '
                'bad = [n for n in ("torch", "transformers", "onnxruntime", "numpy", "tokenizers") if n in sys.modules]; '
                'print(bad)' % str(SCRIPTS))
        out = subprocess.run([TEST_PYTHON, '-c', code], capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), '[]')

    def test_inference_with_stubs_never_imports_torch(self):
        ready().detect('word')
        self.assertNotIn('torch', sys.modules)
        self.assertNotIn('transformers', sys.modules)


class DetectTests(unittest.TestCase):
    def test_nine_labels_all_scores_and_contract(self):
        text = 'hola open'
        session = FakeSession(rows=[[0.0] * 9] + [[5.0 if i == 7 else 0.0 for i in range(9)],
                                                  [3.0 if i == 2 else 0.0 for i in range(9)]] + [[0.0] * 9])
        result = ready(session, FakeTokenizer(piece=10)).detect(text)
        self.assertEqual(result['status'], 'available')
        self.assertEqual(result['offsetUnit'], 'python-codepoint')
        self.assertEqual(result['scoreSemantics'], 'uncalibrated-softmax')
        self.assertEqual(set(result['identity']), {'checkpoint', 'revision', 'integrity'})
        self.assertEqual([t['label'] for t in result['tokens']], ['spa', 'en'])
        for token in result['tokens']:
            self.assertEqual(set(token['scores']), set(LABELS))
            self.assertAlmostEqual(sum(token['scores'].values()), 1.0, places=9)
            self.assertEqual(token['score'], max(token['scores'].values()))
        self.assertEqual(LABELS, ('O', 'ambiguous', 'en', 'fw', 'mixed', 'ne', 'other', 'spa', 'unk'))

    def test_backend_marker_is_separate_and_resolver_accepts_result(self):
        result = ready().detect('word')
        self.assertEqual(result['backend'], BACKEND)
        self.assertEqual(BACKEND['name'], 'onnx-fp32')
        evidence, diagnostics = detector_result(ready(), 'word')
        self.assertEqual(diagnostics, [])
        self.assertEqual(len(evidence), 4)

    def test_windows_respect_512_budget_and_cover_everything(self):
        text = 'word ' * 150
        session = FakeSession()
        result = ready(session).detect(text)
        self.assertEqual(result['status'], 'available')
        self.assertGreater(result['windows'], 1)
        self.assertTrue(all(size <= 512 for size in session.runs))
        self.assertGreaterEqual(max(session.runs), 500)
        covered = {i for t in result['tokens'] for i in range(t['start'], t['end'])}
        self.assertEqual(covered, {i for i, c in enumerate(text) if not c.isspace()})
        self.assertTrue(any(t['edge'] for t in result['tokens']))
        self.assertEqual(len(result['tokens']), 600)

    def test_single_window_has_no_edge_flags(self):
        result = ready().detect('hola mundo')
        self.assertEqual(result['windows'], 1)
        self.assertFalse(any(t['edge'] for t in result['tokens']))

    def test_windows_never_split_a_whitespace_atom(self):
        atoms = ['abcdefghi'] * 200
        text = ' '.join(atoms)
        result = ready(tokenizer=FakeTokenizer(piece=3)).detect(text)
        self.assertGreater(result['windows'], 1)
        starts = [0]
        for atom in atoms[:-1]:
            starts.append(starts[-1] + len(atom) + 1)
        for start in starts:
            windows = {t['window'] for t in result['tokens'] if start <= t['start'] < start + 9}
            self.assertEqual(len(windows), 1)

    def test_unicode_offsets_are_codepoints(self):
        for text in ('\U0001F600 hola \U0001F680\U0001F680 listo', 'canci\u00f3n ma\u00f1ana', 'e\u0301 cafe\u0301 x'):
            with self.subTest(text=text):
                result = ready().detect(text)
                self.assertEqual(result['status'], 'available')
                rebuilt = ''.join(text[t['start']:t['end']] for t in result['tokens'])
                self.assertEqual(rebuilt, ''.join(text.split()))

    def test_whole_word_evidence(self):
        text = 'getUserName deployment'
        result = ready(tokenizer=FakeTokenizer(piece=4)).detect(text)
        self.assertEqual({(t['start'], t['end']) for t in result['tokens']},
                         {(0, 4), (4, 8), (8, 11), (12, 16), (16, 20), (20, 22)})

    def test_oversize_atom_degrades_explicitly(self):
        text = 'a' * 600 + ' word'
        result = ready().detect(text)
        self.assertEqual(result['status'], 'degraded')
        self.assertEqual(result['diagnostics'], ['unsplittable-token-window'])
        self.assertTrue(all(t['start'] >= 600 for t in result['tokens']))

    def test_input_limit_and_invalid_input_before_loading(self):
        detector = OnnxDetector('unused')
        with patch.object(detector, '_load', side_effect=AssertionError('must not load')):
            self.assertEqual(detector.detect('a' * 4001)['diagnostics'], ['detector-input-limit'])
            self.assertEqual(detector.detect('\U0001F600' * 2001)['diagnostics'], ['detector-input-limit'])
            self.assertEqual(detector.detect('bad \ud800')['diagnostics'], ['invalid-detector-input'])
            self.assertEqual(detector.detect(None)['diagnostics'], ['invalid-detector-input'])

    def test_inference_failures_degrade_without_text(self):
        bad = {
            'shape': Logits([[0.0] * 9] * 6, (1, 6, 2)), 'dtype': Logits([[0.0] * 9] * 3, (1, 3, 9), 'float64'),
            'nan': Logits([[float('nan')] * 9] * 3), 'inf': Logits([[float('inf')] * 9] * 3),
        }
        for name, logits in bad.items():
            session = FakeSession()
            session.run = lambda names, feeds, logits=logits: [logits]
            with self.subTest(name=name):
                result = ready(session).detect('word')
                self.assertEqual(result['diagnostics'], ['local-inference-failed'])
                self.assertEqual(result['tokens'], [])

    def test_session_exception_text_is_not_leaked(self):
        session = FakeSession()

        def explode(names, feeds):
            raise RuntimeError('secret prose')

        session.run = explode
        result = ready(session).detect('word')
        self.assertEqual(result['diagnostics'], ['local-inference-failed'])
        self.assertNotIn('secret', json.dumps(result))

    def test_deterministic(self):
        self.assertEqual(ready().detect('hola mundo'), ready().detect('hola mundo'))


@contextmanager
def staged_reference():
    """Hard-link the reference files into an exact-set directory (no 709 MB copy, no Git)."""
    with tempfile.TemporaryDirectory(dir=REFERENCE.parent) as root:
        directory = Path(root) / 'model'
        (directory / 'tokenizer').mkdir(parents=True)
        try:
            os.link(REFERENCE / 'model.onnx', directory / 'model.onnx')
            for source in (REFERENCE / 'tokenizer').iterdir():
                os.link(source, directory / 'tokenizer' / source.name)
        except OSError:
            raise unittest.SkipTest('hard links unavailable for reference assets')
        yield directory


def runtime_available():
    try:
        import numpy, onnxruntime, tokenizers  # noqa: F401
    except ImportError:
        return False
    return True


@unittest.skipUnless((REFERENCE / 'model.onnx').is_file() and (REFERENCE / 'tokenizer' / 'tokenizer.json').is_file()
                     and runtime_available(), 'reference ONNX assets or runtime are absent')
class RealAssetTests(unittest.TestCase):
    """Regression pin of high-confidence labels observed from the real model; not an accuracy claim."""

    OBSERVED = {
        'Hola local, Open editor y seguimos.': {'local': 'spa', 'Open': 'en', 'y': 'spa', 'seg': 'spa', 'mos': 'spa'},
        'getUserName': {'get': 'en', 'U': 'en', 'ser': 'en', 'N': 'en', 'ame': 'en'},
        'no cambies el deployment': {'el': 'spa', 'deployment': 'en'},
    }

    @classmethod
    def setUpClass(cls):
        with staged_reference() as directory:
            detector = OnnxDetector(directory)
            cls.results = {text: detector.detect(text) for text in cls.OBSERVED}

    def test_real_model_is_available_and_emits_nine_scores(self):
        for text, result in self.results.items():
            with self.subTest(text=text):
                self.assertEqual(result['status'], 'available', result['diagnostics'])
                self.assertEqual(result['identity']['integrity'], 'verified-local-assets')
                self.assertTrue(result['tokens'])
                for token in result['tokens']:
                    self.assertEqual(set(token['scores']), set(LABELS))
                    self.assertAlmostEqual(sum(token['scores'].values()), 1.0, places=6)

    def test_real_model_labels_match_observed_reference(self):
        for text, expected in self.OBSERVED.items():
            with self.subTest(text=text):
                observed = {text[t['start']:t['end']]: t for t in self.results[text]['tokens']}
                for word, label in expected.items():
                    self.assertEqual(observed[word]['label'], label)
                    self.assertGreater(observed[word]['score'], 0.8)


if __name__ == '__main__':
    unittest.main()