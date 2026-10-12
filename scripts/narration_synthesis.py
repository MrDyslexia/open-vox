"""Resolved schema 1 -> language G2P -> fixed-voice bounded raw-phoneme WAV.

No downloads, filtered tokenizer phonemization, streaming or voice switching.
Trace references retain the I02 containing-segment granularity; chunk text ranges
address the derived run, never fabricated original token offsets.
"""
import copy
import json
import math
import os
from pathlib import Path
import re

from narration_lid import CHECKPOINT, REVISION, sanitize_evidence
from narration_plan import flatten_blocks, source_slice, utf16_length, validate_plan

PHONEME_LIMIT = 510
SAMPLE_RATE = 24000
BLOCK_PAUSE_SECONDS = 0.18
MAX_AUDIO_SAMPLES = SAMPLE_RATE * 600


def local_lid_directory(app_home):
    return Path(app_home) / 'lid' / 'codeswitch-spaeng-lid-lince' / REVISION


def load_plan(stream):
    """One strict JSON document. Reject nonfinite numbers and duplicate keys."""
    def pairs(entries):
        result = {}
        for key, value in entries:
            if key in result:
                raise ValueError('duplicate-json-key')
            result[key] = value
        return result
    def nonfinite(_):
        raise ValueError('nonfinite-json')
    return validate_plan(json.load(stream, object_pairs_hook=pairs, parse_constant=nonfinite))


def validate_envelope(value):
    fields = {'resolvedSchemaVersion', 'languageStatus', 'structuralPlan', 'blocks', 'diagnostics',
              'offsetUnit', 'rangeConvention', 'sourceGranularity', 'derivedRangeReference', 'evidenceReference',
              'detectorIdentity', 'scoreSemantics', 'resolvedNarrationLength', 'resolutionOutcome', 'synthesisReady'}
    if (type(value) is not dict or set(value) != fields or type(value.get('resolvedSchemaVersion')) is not int
            or value['resolvedSchemaVersion'] != 1 or value.get('languageStatus') != 'resolved'):
        raise ValueError('invalid-resolved-envelope')
    plan = validate_plan(value.get('structuralPlan'))
    metadata = {'offsetUnit': 'utf16', 'rangeConvention': 'end-exclusive',
                'sourceGranularity': 'containing-original-segment', 'derivedRangeReference': 'segment-text',
                'evidenceReference': 'block-derived-text-python-codepoint', 'scoreSemantics': 'uncalibrated-softmax'}
    if any(value.get(k) != v for k, v in metadata.items()):
        raise ValueError('invalid-resolved-metadata')
    if (value.get('synthesisReady') is not True or value.get('resolutionOutcome') != 'complete'
            or plan['outcome'] == 'unsplittable'):
        raise ValueError('narration-not-ready')
    blocks = value.get('blocks')
    if type(blocks) is not list or len(blocks) != len(plan['blocks']):
        raise ValueError('invalid-resolved-blocks')
    if value['detectorIdentity'] != {'checkpoint': CHECKPOINT, 'revision': REVISION, 'integrity': 'unverified-local-assets'}:
        raise ValueError('invalid-detector-identity')
    if type(value['diagnostics']) is not list:
        raise ValueError('invalid-diagnostics')
    for diagnostic in value['diagnostics']:
        if (type(diagnostic) is not dict or set(diagnostic) != {'blockIndex', 'code'}
                or type(diagnostic['blockIndex']) is not int or not 0 <= diagnostic['blockIndex'] < len(blocks)
                or type(diagnostic['code']) is not str or not re.fullmatch(r'[a-z][a-z0-9-]{0,79}', diagnostic['code'])):
            raise ValueError('invalid-diagnostic')
    for index, (block, structural) in enumerate(zip(blocks, plan['blocks'])):
        if type(block) is not dict or set(block) != {'blockIndex', 'units'} or type(block['blockIndex']) is not int or block['blockIndex'] != index or type(block['units']) is not list:
            raise ValueError('invalid-resolved-block')
        position = 0
        if not all(type(u) is dict for u in block['units']):
            raise ValueError('invalid-resolved-unit')
        block_text = ''.join(s['text'] for s in structural['segments'])
        for segment_index, segment in enumerate(structural['segments']):
            cursor = 0
            while position < len(block['units']) and block['units'][position].get('segmentIndex') == segment_index:
                unit = block['units'][position]
                fields = {'segmentIndex', 'text', 'spokenText', 'language', 'reason', 'protected', 'source', 'derivedRange', 'decisionRange', 'rawEvidence'}
                if (set(unit) != fields or type(unit['segmentIndex']) is not int
                        or type(unit['text']) is not str or not unit['text'] or type(unit['spokenText']) is not str or not unit['spokenText']
                        or unit['language'] not in ('es', 'en') or type(unit['reason']) is not str
                        or not re.fullmatch(r'[a-z][a-z0-9-]{0,79}', unit['reason'])
                        or type(unit['protected']) is not bool or unit['protected'] != segment['protected']
                        or unit['source'] != segment['source']):
                    raise ValueError('invalid-resolved-unit')
                span = unit['derivedRange']
                if type(span) is not dict or set(span) != {'start', 'end'} or span['start'] != cursor:
                    raise ValueError('invalid-derived-range')
                if source_slice(segment['text'], span) != unit['text']:
                    raise ValueError('invalid-derived-text')
                cursor = span['end']
                decision = unit['decisionRange']
                if (type(decision) is not dict or set(decision) != {'start', 'end'}
                        or any(type(decision[k]) is not int for k in decision)
                        or not 0 <= decision['start'] < decision['end'] <= len(block_text)):
                    raise ValueError('invalid-decision-range')
                _, invalid = sanitize_evidence(unit['rawEvidence'], block_text)
                if invalid:
                    raise ValueError('invalid-raw-evidence')
                position += 1
            if cursor != utf16_length(segment['text']):
                raise ValueError('incomplete-derived-segment')
        if position != len(block['units']):
            raise ValueError('unordered-resolved-units')
    length = utf16_length(flatten_blocks(blocks, resolved=True))
    if (type(value.get('resolvedNarrationLength')) is not int or value['resolvedNarrationLength'] != length
            or length > plan['policy']['maxNarrationLength'] or length > 4000):
        raise ValueError('expanded-narration-limit')
    if sum(utf16_length(u['spokenText']) for b in blocks for u in b['units']) > 4000:
        raise ValueError('expanded-working-text-limit')
    return copy.deepcopy(value)


def language_runs(block, base):
    """Neutral spacing/punctuation follows the preceding run, not a word call."""
    runs = []
    for index, unit in enumerate(block['units']):
        language = runs[-1]['language'] if runs and unit['reason'] == 'neutral' else unit['language']
        if not runs or language != runs[-1]['language']:
            runs.append({'language': language, 'text': '', 'protected': [], 'units': []})
        run = runs[-1]
        start = len(run['text'])
        run['text'] += unit['spokenText']
        end = len(run['text'])
        run['units'].append({'unitIndex': index, 'runRange': {'start': start, 'end': end}, 'source': unit['source'],
                             'derivedRange': unit['derivedRange'], 'rawText': unit['text']})
        if unit['protected'] or unit['reason'] in ('protected-technical', 'policy-acronym'):
            key = ('segment', unit['segmentIndex']) if unit['protected'] else ('decision', tuple(unit['decisionRange'].values()))
            if run['protected'] and run['protected'][-1][2] == key and run['protected'][-1][1] == start:
                run['protected'][-1] = (run['protected'][-1][0], end, key)
            else:
                run['protected'].append((start, end, key))
    return runs


def prepare_chunks(envelope, phonemize, vocab):
    resolved = validate_envelope(envelope)
    chunks = []
    for block in resolved['blocks']:
        block_start = len(chunks)
        fragments = []
        for run_index, run in enumerate(language_runs(block, resolved['structuralPlan']['defaultLanguage'])):
            text = run['text']
            # Safe boundaries are lexical spaces/punctuation, never inside a protected unit.
            cuts = [m.end() for m in re.finditer(r'\s+|[.!?;,:](?=\s|$)', text)]
            cuts = [p for p in cuts if 0 < p < len(text) and not any(a < p < b for a, b, _ in run['protected'])]
            pending = [(0, len(text))]
            while pending:
                start, end = pending.pop()
                fragment = text[start:end]
                if not fragment.strip():
                    continue
                raw = phonemize(fragment, run['language'])
                if type(raw) is not str or not raw.strip():
                    raise ValueError('missing-phonemes')
                mappings = [{'index': i, 'from': c, 'to': '"'} for i, c in enumerate(raw) if c in '«»']
                final = raw.replace('«', '"').replace('»', '"')
                if any(c not in vocab for c in final):
                    raise ValueError('unsupported-raw-phoneme')
                if len(final) > PHONEME_LIMIT:
                    available = [p for p in cuts if start < p < end]
                    if not available:
                        raise ValueError('unsplittable-phoneme-unit')
                    middle = min(available, key=lambda p: abs(p - (start + end) / 2))
                    pending.extend([(middle, end), (start, middle)])
                    continue
                fragments.append({'blockIndex': block['blockIndex'], 'runIndex': run_index, 'language': run['language'],
                               'text': fragment, 'rawPhonemes': raw, 'phonemes': final, 'mappings': mappings,
                               'runRange': {'start': start, 'end': end}, 'units': [u for u in run['units']
                                    if u['runRange']['start'] < end and u['runRange']['end'] > start], 'pauseBefore': 0.0})
        chunks.extend(pack_block(fragments, vocab))
        if block_start < len(chunks) and block_start > 0:
            chunks[block_start]['pauseBefore'] = BLOCK_PAUSE_SECONDS
    return chunks


def pack_block(fragments, vocab):
    """G2P boundaries are trace boundaries, not automatic inference boundaries.

    Pack only within one structural block. A source whitespace boundary needs a
    phoneme space when stripped G2P output no longer carries it. Count that space
    before accepting a fragment; preserve both raw and adapted per-run ranges.
    """
    chunks = []
    for fragment in fragments:
        chunk = chunks[-1] if chunks else None
        separator = ''
        if chunk:
            previous = chunk['runs'][-1]
            separated = previous['text'][-1:].isspace() or fragment['text'][:1].isspace()
            if separated and not (chunk['phonemes'][-1:].isspace() or fragment['phonemes'][:1].isspace()):
                separator = ' '
                if separator not in vocab:
                    raise ValueError('unsupported-boundary-phoneme')
        if chunk is None or len(chunk['phonemes']) + len(separator) + len(fragment['phonemes']) > PHONEME_LIMIT:
            chunk = {'blockIndex': fragment['blockIndex'], 'text': '', 'rawPhonemes': '',
                     'phonemes': '', 'mappings': [], 'runs': [], 'pauseBefore': 0.0}
            chunks.append(chunk)
            separator = ''  # A budget boundary already separates the model calls.
        offset = len(chunk['phonemes']) + len(separator)
        run = {**fragment, 'separatorBefore': separator,
               'phonemeRange': {'start': offset, 'end': offset + len(fragment['phonemes'])},
               'rawPhonemeRange': {'start': offset, 'end': offset + len(fragment['rawPhonemes'])}}
        chunk['runs'].append(run)
        chunk['text'] += fragment['text']
        chunk['rawPhonemes'] += separator + fragment['rawPhonemes']
        chunk['phonemes'] += separator + fragment['phonemes']
        chunk['mappings'].extend({**mapping, 'index': offset + mapping['index']} for mapping in fragment['mappings'])
    return chunks


def raw_phonemizer(kokoro, english_language='en-us'):
    """Bypass Tokenizer.phonemize: it silently filters unknown characters."""
    import phonemizer
    from kokoro_onnx.tokenizer import _espeak_lock
    def phonemize(text, language):
        with _espeak_lock:
            return phonemizer.phonemize(text, 'es' if language == 'es' else english_language,
                                       preserve_punctuation=True, with_stress=True).strip()
    return phonemize


def synthesize_envelope(envelope, kokoro, voice, speed, output, phonemize):
    import numpy as np
    import soundfile as sf
    if not isinstance(speed, (int, float)) or not math.isfinite(speed) or not 0.5 <= speed <= 2:
        raise ValueError('invalid-speed')
    chunks = prepare_chunks(envelope, phonemize, kokoro.tokenizer.vocab)
    if not chunks:
        raise ValueError('empty-narration')
    # Reuse one voice style and one already-loaded model for every chunk.
    style = kokoro.get_voice_style(voice)
    parts, count = [], 0
    for chunk in chunks:
        samples, rate = kokoro.create(chunk['phonemes'], voice=style, speed=speed, is_phonemes=True,
                                      sentence_pause=0.0, clause_pause=0.0)
        samples = np.asarray(samples)
        if rate != SAMPLE_RATE or samples.ndim != 1 or not samples.size or not np.isfinite(samples).all():
            raise ValueError('invalid-generated-audio')
        silence = int(chunk['pauseBefore'] * SAMPLE_RATE)
        count += samples.size + silence
        if count > MAX_AUDIO_SAMPLES:
            raise ValueError('generated-audio-limit')
        if silence:
            parts.append(np.zeros(silence, dtype=np.float32))
        parts.append(samples)
    # No final path exists until every bounded inference succeeds. A write failure
    # removes the candidate; cache ownership/kill cleanup remains with the sink.
    try:
        sf.write(output, np.concatenate(parts), SAMPLE_RATE, subtype='PCM_16', format='WAV')
    except Exception:
        try:
            os.unlink(output)
        except OSError:
            pass
        raise
    return {'chunks': chunks, 'sampleRate': SAMPLE_RATE, 'samples': int(count), 'voice': voice}
