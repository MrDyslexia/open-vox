import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
from contextlib import nullcontext
import json

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from narration_lid import LABELS, LocalDetector, sanitize_evidence, token_windows


class Tensor:
    def __init__(self, values, shape=None):
        self.values = values
        self.shape = shape or (1, len(values[0]))

    def __getitem__(self, index):
        return Tensor(self.values[index])

    def tolist(self):
        return self.values

    def to(self, device):
        assert device == 'cpu'
        return self


class FakeTokenizer:
    is_fast = True

    def __init__(self):
        self.calls = []

    def __call__(self, text, **kwargs):
        assert kwargs.get('truncation') is False
        self.calls.append((text, kwargs))
        offsets = [(i, i + 1) for i, c in enumerate(text) if not c.isspace()]
        offsets = [(0, 0)] + offsets + [(0, 0)]
        ids = list(range(len(offsets)))
        if kwargs.get('return_tensors') == 'pt':
            return {'input_ids': Tensor([ids]), 'offset_mapping': Tensor([offsets])}
        return {'input_ids': ids}


class FakeModel:
    config = SimpleNamespace(num_labels=9, id2label=dict(enumerate(LABELS)))

    def __init__(self):
        self.sizes, self.eval_called, self.device = [], False, None

    def eval(self):
        self.eval_called = True

    def to(self, device):
        self.device = device

    def __call__(self, input_ids):
        size = input_ids.shape[1]
        assert size <= 512
        self.sizes.append(size)
        scores = [[float(label == 'en') for label in LABELS] for _ in range(size)]
        return SimpleNamespace(logits=Tensor([scores], (1, size, 9)))


TORCH = SimpleNamespace(no_grad=nullcontext, isfinite=lambda value: SimpleNamespace(all=lambda: True),
                        softmax=lambda value, dim: value)


def model_config():
    return {'id2label': {str(i): label for i, label in enumerate(LABELS)},
            'label2id': {label: i for i, label in enumerate(LABELS)},
            'model_type': 'bert', 'architectures': ['BertForTokenClassification'],
            'max_position_embeddings': 512}


def token(start, end, label='en', **extras):
    scores = {key: float(key == label) for key in LABELS}
    return dict(start=start, end=end, label=label, score=1.0, scores=scores,
                window=0, edge=False, **extras)


class LidTests(unittest.TestCase):
    def test_invalid_evidence_safe(self):
        cases = [None, 'bad', [None], [token(0, 3, score_override=2)],
                 [dict(token(0, 3), score=10 ** 10000)],
                 [dict(token(0, 3), score=float('nan'))],
                 [dict(token(0, 3), scores={'en': 1})], [token(0, 10)],
                 [dict(token(0, 3), label='LABEL_0')]]
        for case in cases:
            with self.subTest(case=type(case).__name__):
                safe, diagnostics = sanitize_evidence(case, 'word')
                self.assertEqual(safe, [])
                self.assertTrue(diagnostics)

    def test_missing_assets_no_import_or_network(self):
        with patch.dict(sys.modules, {'torch': None, 'transformers': None}):
            result = LocalDetector('does-not-exist').detect('synthetic text')
        self.assertEqual(result['status'], 'unavailable')
        self.assertIn('missing-local-assets', result['diagnostics'])
        self.assertEqual(LocalDetector(None).detect('word')['diagnostics'], ['invalid-local-model-directory'])

    def test_valid_evidence_detached(self):
        raw = [token(0, 4)]
        safe, diagnostics = sanitize_evidence(raw, 'word')
        self.assertEqual(diagnostics, [])
        safe[0]['scores']['en'] = 0
        self.assertEqual(raw[0]['scores']['en'], 1)

    def test_windows_full_coverage_actual_budget_and_edges(self):
        text = 'word ' * 150
        tokenizer, model = FakeTokenizer(), FakeModel()
        detector = LocalDetector('not-loaded')
        detector._runtime = (TORCH, tokenizer, model)
        result = detector.detect(text)
        self.assertEqual(result['status'], 'available')
        self.assertGreater(result['windows'], 1)
        self.assertTrue(all(size <= 512 for size in model.sizes))
        coverage = set(i for item in result['tokens'] for i in range(item['start'], item['end']))
        self.assertEqual(coverage, {i for i, c in enumerate(text) if not c.isspace()})
        self.assertTrue(any(item['edge'] for item in result['tokens']))
        self.assertEqual(len(result['tokens']), 600)

    def test_unsplittable_window_is_explicit(self):
        text = 'a' * 600 + ' word'
        windows, diagnostics = token_windows(text, FakeTokenizer())
        self.assertEqual(diagnostics, ['unsplittable-token-window'])
        self.assertTrue(all(start >= 600 for start, _ in windows))
        detector = LocalDetector('unused')
        detector._runtime = (TORCH, FakeTokenizer(), FakeModel())
        result = detector.detect(text)
        self.assertEqual(result['status'], 'degraded')
        self.assertEqual(result['diagnostics'], diagnostics)
        self.assertTrue(all(entry['start'] >= 600 for entry in result['tokens']))

    def test_input_bound_before_loading(self):
        detector = LocalDetector('unused')
        with patch.object(detector, '_load', side_effect=AssertionError('must not load')):
            self.assertEqual(detector.detect('a' * 4001)['diagnostics'], ['detector-input-limit'])

    def test_missing_dependencies_and_malformed_model(self):
        with patch('narration_lid.Path.is_dir', return_value=True), patch('narration_lid.Path.is_file', return_value=True):
            with patch('narration_lid.Path.read_text', return_value=json.dumps(model_config())):
                with patch.dict(sys.modules, {'torch': None, 'transformers': None}):
                    self.assertEqual(LocalDetector('local').detect('word')['diagnostics'], ['missing-detector-dependencies'])
            for config in [None, [], {'id2label': {'0': 'LABEL_0'}}, dict(model_config(), max_position_embeddings=1024)]:
                with patch('narration_lid.Path.read_text', return_value=json.dumps(config)):
                    self.assertEqual(LocalDetector('local').detect('word')['diagnostics'], ['invalid-local-model-config'])

    def test_loader_local_only_cpu_eval_safetensors(self):
        tokenizer, model = FakeTokenizer(), FakeModel()
        calls = []

        def load_tokenizer(path, **kwargs):
            calls.append(('tokenizer', path, kwargs))
            return tokenizer

        def load_model(path, **kwargs):
            calls.append(('model', path, kwargs))
            return model

        transformers = SimpleNamespace(AutoTokenizer=SimpleNamespace(from_pretrained=load_tokenizer),
                                       AutoModelForTokenClassification=SimpleNamespace(from_pretrained=load_model))
        with patch('narration_lid.Path.is_dir', return_value=True), patch('narration_lid.Path.is_file', return_value=True), \
                patch('narration_lid.Path.read_text', return_value=json.dumps(model_config())), \
                patch.dict(sys.modules, {'torch': TORCH, 'transformers': transformers}):
            result = LocalDetector('local').detect('word')
        self.assertEqual(result['status'], 'available')
        self.assertTrue(model.eval_called)
        self.assertEqual(model.device, 'cpu')
        for kind, path, kwargs in calls:
            self.assertTrue(Path(path).is_absolute())
            self.assertTrue(kwargs['local_files_only'])
            self.assertFalse(kwargs['trust_remote_code'])
            if kind == 'model':
                self.assertTrue(kwargs['use_safetensors'])

    def test_bad_tokenizer_shape_and_bad_logits_degrade(self):
        with self.assertRaises(ValueError):
            token_windows('word', lambda *args, **kwargs: {'input_ids': 'invalid'})
        detector = LocalDetector('unused')
        model = lambda **kwargs: SimpleNamespace(logits=Tensor([], (1, 6, 2)))
        detector._runtime = (TORCH, FakeTokenizer(), model)
        self.assertEqual(detector.detect('word')['diagnostics'], ['local-inference-failed'])


if __name__ == '__main__':
    unittest.main()
