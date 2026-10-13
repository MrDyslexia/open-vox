"""Inactive standalone ONNX FP32 backend for the token-level language detector.

Same public contract as narration_lid.LocalDetector, but inference needs only
onnxruntime + tokenizers + numpy (imported lazily); torch/transformers are never
imported. The windowing, evidence validation, labels and result shape are reused
from narration_lid so both backends stay behaviorally identical.

Pinned local bytes are verified once before loading. No prose is logged and no
exception text is returned. Evidence offsets are Python codepoints in the
detector's block text, NOT source. Scores are raw, uncalibrated softmax values.
Nothing in the plugin, CLI or setup selects this module.
"""

import hashlib
import json
import math
import os
from pathlib import Path
import re

from narration_lid import CHECKPOINT, LABELS, REVISION, TOKEN_LIMIT, sanitize_evidence, token_windows
from narration_plan import utf16_length

MANIFEST_PATH = Path(__file__).resolve().parents[1] / 'resources' / 'lid-model-onnx-fp32.json'
FILES = ('model.onnx', 'tokenizer/config.json', 'tokenizer/special_tokens_map.json',
         'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json', 'tokenizer/vocab.txt')
DIRECTORIES = {'tokenizer'}
INPUT_NAMES = ('input_ids', 'attention_mask', 'token_type_ids')
OUTPUT_NAME = 'logits'
RUNTIME_KEYS = {'numpy', 'onnxruntime', 'tokenizers'}
# Backend identity lives beside, never inside, the schema-1 `identity` dict that
# consumers compare exactly. Hashes must equal the bundled manifest (tested).
BACKEND = {'name': 'onnx-fp32',
           'graphSha256': 'a322d9809cd37c9002c70bb182953b59646d730d51aa93a6dc4ea4eca7283f86',
           'tokenizerSha256': 'f5c46e5898b5fa17c8541b336dd904a1021568c2a25356436ae2b1b5fd9409f7'}


def validate_manifest(value):
    if (type(value) is not dict
            or set(value) != {'schemaVersion', 'backend', 'derivedFrom', 'runtime', 'files'}
            or type(value['schemaVersion']) is not int or value['schemaVersion'] != 1
            or value['backend'] != BACKEND['name']
            or value['derivedFrom'] != {'checkpoint': CHECKPOINT, 'revision': REVISION}
            or type(value['runtime']) is not dict or set(value['runtime']) != RUNTIME_KEYS
            or not all(type(v) is str and re.fullmatch(r'\d+(\.\d+){1,2}', v) for v in value['runtime'].values())
            or type(value['files']) is not list or len(value['files']) != len(FILES)):
        raise ValueError('invalid pinned manifest')
    for name, entry in zip(FILES, value['files']):
        if (type(entry) is not dict or set(entry) != {'filename', 'bytes', 'sha256'}
                or entry['filename'] != name or type(entry['bytes']) is not int or entry['bytes'] <= 0
                or type(entry['sha256']) is not str or not re.fullmatch('[a-f0-9]{64}', entry['sha256'])):
            raise ValueError('invalid pinned file')
    return value


def listing(directory):
    """Every entry below directory as relative posix names; symlinks are refused."""
    found = set()
    for entry in os.scandir(directory):
        if entry.is_symlink():
            raise ValueError('redirected model entry')
        if entry.is_dir(follow_symlinks=False):
            for child in listing(entry.path):
                found.add(f'{entry.name}/{child}')
            found.add(entry.name + '/')
        else:
            found.add(entry.name)
    return found


def verify_local_assets(directory, manifest_path=None):
    """An optional transport path cannot override the bundled pin. No SDK/network."""
    bundled = validate_manifest(json.loads(MANIFEST_PATH.read_text(encoding='utf-8')))
    supplied = validate_manifest(json.loads(Path(manifest_path or MANIFEST_PATH).read_text(encoding='utf-8')))
    if supplied != bundled:
        raise ValueError('wrong pinned manifest')
    if directory.is_symlink() or any(parent.is_symlink() for parent in directory.parents):
        raise ValueError('redirected model directory')
    # Extra files or directories could change what the loaders select.
    if listing(directory) != set(FILES) | {name + '/' for name in DIRECTORIES}:
        raise ValueError('unexpected local model files')
    for entry in supplied['files']:
        path = directory / entry['filename']
        if path.is_symlink() or not path.is_file():
            raise ValueError('unsafe local model file')
        digest, size = hashlib.sha256(), 0
        with path.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
                size += len(block)
        if size != entry['bytes'] or digest.hexdigest() != entry['sha256']:
            raise ValueError('local model integrity')


class TokenizerAdapter:
    """Callable subset of the Transformers tokenizer used by token_windows/detect."""

    def __init__(self, backend):
        self.backend = backend
        backend.no_padding()
        backend.no_truncation()

    def __call__(self, text, add_special_tokens=True, truncation=False, return_offsets_mapping=False):
        if truncation is not False or type(add_special_tokens) is not bool or type(text) is not str:
            raise ValueError('unsupported tokenizer option')
        encoding = self.backend.encode(text, add_special_tokens=add_special_tokens)
        result = {'input_ids': list(encoding.ids)}
        if return_offsets_mapping:
            result.update(token_type_ids=list(encoding.type_ids), attention_mask=list(encoding.attention_mask),
                          offset_mapping=[tuple(pair) for pair in encoding.offsets])
        return result


def softmax(row):
    if len(row) != len(LABELS) or not all(math.isfinite(value) for value in row):
        raise ValueError('invalid logits')
    top = max(row)
    exponents = [math.exp(value - top) for value in row]
    total = math.fsum(exponents)
    return [value / total for value in exponents]


class OnnxDetector:
    def __init__(self, model_directory, manifest_path=None):
        self.model_directory = model_directory
        self.manifest_path = manifest_path
        self._runtime = None
        self._failure = None
        self._verified = False

    def _load(self):
        if self._runtime is not None or self._failure is not None:
            return
        try:
            directory = Path(self.model_directory).expanduser()
        except (TypeError, ValueError, RuntimeError):
            self._failure = 'invalid-local-model-directory'
            return
        if not directory.is_dir() or not all((directory / name).is_file() for name in FILES):
            self._failure = 'missing-local-assets'
            return
        try:
            verify_local_assets(directory, self.manifest_path)
        except (OSError, ValueError, TypeError):
            self._failure = 'local-model-integrity-failed'
            return
        try:
            config = json.loads((directory / 'tokenizer' / 'config.json').read_text(encoding='utf-8'))
            if (type(config) is not dict
                    or config.get('id2label') != {str(i): label for i, label in enumerate(LABELS)}
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
            import numpy
            import onnxruntime
            from tokenizers import Tokenizer
        except ImportError:
            self._failure = 'missing-detector-dependencies'
            return
        try:
            tokenizer = TokenizerAdapter(Tokenizer.from_file(str((directory / 'tokenizer' / 'tokenizer.json').resolve())))
            options = onnxruntime.SessionOptions()
            options.intra_op_num_threads = 2
            options.inter_op_num_threads = 1
            session = onnxruntime.InferenceSession(str((directory / 'model.onnx').resolve()), sess_options=options,
                                                   providers=['CPUExecutionProvider'])
            session.disable_fallback()
            if (tokenizer.backend.token_to_id('[PAD]') != 0
                    or tuple(i.name for i in session.get_inputs()) != INPUT_NAMES
                    or any(i.type != 'tensor(int64)' for i in session.get_inputs())
                    or [o.name for o in session.get_outputs()] != [OUTPUT_NAME]
                    or list(session.get_providers()) != ['CPUExecutionProvider']):
                self._failure = 'invalid-loaded-model'
                return
            self._runtime = (numpy, tokenizer, session)
            self._verified = True
        except Exception:
            # Never emit exception strings: a third-party exception may contain prose.
            self._failure = 'local-model-load-failed'

    def detect(self, text):
        identity = {'checkpoint': CHECKPOINT, 'revision': REVISION, 'integrity': 'unverified-local-assets'}
        result = {'status': 'unavailable', 'diagnostics': [], 'tokens': [], 'identity': identity,
                  'offsetUnit': 'python-codepoint', 'scoreSemantics': 'uncalibrated-softmax',
                  'backend': dict(BACKEND)}
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
        numpy, tokenizer, session = self._runtime
        try:
            windows, diagnostics = token_windows(text, tokenizer)
            evidence = []
            for window, (start, end) in enumerate(windows):
                encoded = tokenizer(text[start:end], add_special_tokens=True, truncation=False,
                                    return_offsets_mapping=True)
                offsets = encoded['offset_mapping']
                size = len(encoded['input_ids'])
                if size > TOKEN_LIMIT or len(offsets) != size:
                    raise ValueError('token budget or mapping')
                feeds = {name: numpy.asarray([encoded[name]], dtype=numpy.int64) for name in INPUT_NAMES}
                logits = session.run([OUTPUT_NAME], feeds)[0]
                if tuple(logits.shape) != (1, size, len(LABELS)) or logits.dtype != numpy.float32:
                    raise ValueError('invalid logits')
                scores = [softmax(row) for row in logits.tolist()[0]]
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
            if self._verified:
                identity['integrity'] = 'verified-local-assets'
            result.update(status='degraded' if diagnostics or invalid else 'available',
                          tokens=safe, diagnostics=diagnostics + invalid, windows=len(windows))
        except Exception:
            result['diagnostics'] = ['local-inference-failed']
        return result
