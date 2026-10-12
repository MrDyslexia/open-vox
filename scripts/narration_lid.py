"""Local-only contextual token classification; dependencies are lazy.

The approved checkpoint identity is a declaration, not integrity attestation:
managed revision/hash verification belongs to I04. No prose is logged here.
Evidence offsets are Python codepoints in the detector's block text, NOT source.
All nine softmax scores are raw, uncalibrated evidence, not confidence gates.
"""

import copy
import json
import math
from pathlib import Path
import re

from narration_plan import utf16_length

LABELS = ('O', 'ambiguous', 'en', 'fw', 'mixed', 'ne', 'other', 'spa', 'unk')
CHECKPOINT = 'sagorsarker/codeswitch-spaeng-lid-lince'
REVISION = '66d0e899b3fcf70d8727e4521c7a9c3f7a1fa73c'
TOKEN_LIMIT = 512


def sanitize_evidence(value, text):
    """Reject malformed evidence atomically; never stringify untrusted values."""
    def bounded_score(score):
        # Check bounds BEFORE converting huge integers or calling math.isfinite.
        return type(score) in (int, float) and 0 <= score <= 1 and math.isfinite(score)

    if type(value) is not list or len(value) > 16000:
        return [], ['invalid-detector-evidence']
    for entry in value:
        if type(entry) is not dict or set(entry) != {'start', 'end', 'label', 'score', 'scores', 'window', 'edge'}:
            return [], ['invalid-detector-evidence']
        if (type(entry['start']) is not int or type(entry['end']) is not int
                or not 0 <= entry['start'] < entry['end'] <= len(text)
                or type(entry['label']) is not str or entry['label'] not in LABELS
                or type(entry['window']) is not int or not 0 <= entry['window'] <= 4000
                or type(entry['edge']) is not bool or not bounded_score(entry['score'])
                or type(entry['scores']) is not dict or set(entry['scores']) != set(LABELS)
                or not all(bounded_score(score) for score in entry['scores'].values())):
            return [], ['invalid-detector-evidence']
        if entry['score'] != entry['scores'][entry['label']] or entry['score'] != max(entry['scores'].values()):
            return [], ['invalid-detector-evidence']
    return copy.deepcopy(value), []


def token_windows(text, tokenizer, maximum=TOKEN_LIMIT):
    """Non-overlapping maximal whitespace-atom windows, measured by tokenizer.

    Each window receives all contiguous context that fits (special tokens count).
    Never truncate or split an atom. Retokenize the actual window and verify again.
    An atom alone exceeding budget is explicitly skipped, causing missing-evidence
    fallback. Window-edge uncertainty is recorded rather than hidden.
    """
    def count(start, end):
        encoded = tokenizer(text[start:end], add_special_tokens=True, truncation=False)
        ids = encoded['input_ids']
        if type(ids) is not list or not all(type(i) is int for i in ids):
            raise ValueError('invalid tokenizer shape')
        return len(ids)

    boundaries = [0] + [match.end() for match in re.finditer(r'\s+|\S+', text)]
    windows, diagnostics = [], []
    index = 0
    while index < len(boundaries) - 1:
        if count(boundaries[index], boundaries[index + 1]) > maximum:
            diagnostics.append('unsplittable-token-window')
            index += 1
            continue
        low, high = index + 1, len(boundaries) - 1
        while low < high:
            middle = (low + high + 1) // 2
            if count(boundaries[index], boundaries[middle]) <= maximum:
                low = middle
            else:
                high = middle - 1
        start, end = boundaries[index], boundaries[low]
        if count(start, end) > maximum:
            raise ValueError('token window budget changed')
        windows.append((start, end))
        index = low
    return windows, sorted(set(diagnostics))


class LocalDetector:
    def __init__(self, model_directory):
        self.model_directory = model_directory
        self._runtime = None
        self._failure = None

    def _load(self):
        if self._runtime is not None or self._failure is not None:
            return
        try:
            directory = Path(self.model_directory).expanduser()
        except (TypeError, ValueError, RuntimeError):
            self._failure = 'invalid-local-model-directory'
            return
        if not directory.is_dir() or not all((directory / name).is_file() for name in
                ('config.json', 'model.safetensors', 'tokenizer_config.json', 'vocab.txt')):
            self._failure = 'missing-local-assets'
            return
        try:
            config = json.loads((directory / 'config.json').read_text(encoding='utf-8'))
            expected = {str(i): label for i, label in enumerate(LABELS)}
            if (type(config) is not dict or config.get('id2label') != expected
                    or config.get('label2id') != {label: i for i, label in enumerate(LABELS)}
                    or config.get('model_type') != 'bert'
                    or config.get('architectures') != ['BertForTokenClassification']
                    or type(config.get('max_position_embeddings')) is not int
                    or config['max_position_embeddings'] != TOKEN_LIMIT):
                self._failure = 'invalid-local-model-config'
                return
        except (OSError, ValueError, TypeError):
            self._failure = 'invalid-local-model-config'
            return
        try:
            import torch
            from transformers import AutoModelForTokenClassification, AutoTokenizer
        except ImportError:
            self._failure = 'missing-detector-dependencies'
            return
        try:
            # Absolute existing filesystem path only: never pass a hub identifier.
            path = str(directory.resolve())
            tokenizer = AutoTokenizer.from_pretrained(path, local_files_only=True,
                                                       trust_remote_code=False, use_fast=True)
            model = AutoModelForTokenClassification.from_pretrained(
                path, local_files_only=True, trust_remote_code=False, use_safetensors=True)
            if (not tokenizer.is_fast or model.config.num_labels != len(LABELS)
                    or model.config.id2label != {i: label for i, label in enumerate(LABELS)}):
                self._failure = 'invalid-loaded-model'
                return
            model.to('cpu')
            model.eval()
            self._runtime = (torch, tokenizer, model)
        except Exception:
            # Dependency/version/asset failures are operational negatives, not detection.
            # Never emit exception strings: a third-party exception may contain prose.
            self._failure = 'local-model-load-failed'

    def detect(self, text):
        identity = {'checkpoint': CHECKPOINT, 'revision': REVISION, 'integrity': 'unverified-local-assets'}
        result = {'status': 'unavailable', 'diagnostics': [], 'tokens': [], 'identity': identity,
                  'offsetUnit': 'python-codepoint', 'scoreSemantics': 'uncalibrated-softmax'}
        try:
            if utf16_length(text) > 4000:
                result['diagnostics'] = ['detector-input-limit']
                return result
        except ValueError:
            result['diagnostics'] = ['invalid-detector-input']
            return result
        try:
            self._load()
        except (OSError, ValueError, RuntimeError):
            self._failure = 'local-model-load-failed'
        if self._failure:
            result['diagnostics'] = [self._failure]
            return result
        torch, tokenizer, model = self._runtime
        try:
            windows, diagnostics = token_windows(text, tokenizer)
            evidence = []
            for window, (start, end) in enumerate(windows):
                encoded = tokenizer(text[start:end], return_offsets_mapping=True,
                                    return_tensors='pt', truncation=False)
                offsets = encoded.pop('offset_mapping')[0].tolist()
                size = encoded['input_ids'].shape[1]
                if size > TOKEN_LIMIT or len(offsets) != size:
                    raise ValueError('token budget or mapping')
                with torch.no_grad():
                    logits = model(**{key: value.to('cpu') for key, value in encoded.items()}).logits
                    if tuple(logits.shape) != (1, size, len(LABELS)) or not torch.isfinite(logits).all():
                        raise ValueError('invalid logits')
                    scores = torch.softmax(logits, dim=-1)[0].tolist()
                meaningful = [(a, b) for a, b in offsets if a < b]
                left = meaningful[0][0] if meaningful else 0
                right = meaningful[-1][1] if meaningful else 0
                for (a, b), vector in zip(offsets, scores):
                    if a == b:
                        continue  # Special tokens carry no lexical evidence.
                    winner = max(range(len(LABELS)), key=lambda i: vector[i])
                    evidence.append({'start': start + a, 'end': start + b,
                                     'label': LABELS[winner], 'score': vector[winner],
                                     'scores': dict(zip(LABELS, vector)), 'window': window,
                                     'edge': len(windows) > 1 and (a == left or b == right)})
            safe, invalid = sanitize_evidence(evidence, text)
            result.update(status='degraded' if diagnostics or invalid else 'available',
                          tokens=safe, diagnostics=diagnostics + invalid, windows=len(windows))
        except Exception:
            result['diagnostics'] = ['local-inference-failed']
        return result
