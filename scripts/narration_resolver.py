"""Resolve PN-I01 without changing its structural snapshot or source trace.

Resolved schema 1 is a separate envelope, NOT an I01 NarrationPlan. Each routed
unit retains its containing original segment's coarse source range; derivedRange
addresses UTF16 segment-text offsets. Even Markdown entities/escapes never yield
invented exact original-token offsets. Evidence offsets address block-derived
text in Python codepoints. I03 must explicitly adapt this format.

No phonemes, voice selection, sink, downloads or full-source runtime writes here.
"""

import copy
import json
import re
import sys
import unicodedata

from narration_lid import CHECKPOINT, REVISION, sanitize_evidence
from narration_plan import flatten_blocks, utf16_length, utf16_prefix, validate_plan


def word_char(char):
    return char.isalnum() or char in '_$' or unicodedata.category(char).startswith('M')


def lexical_ranges(text):
    """Include combining marks and underscores, preserve all intervening units."""
    index = 0
    while index < len(text):
        if text[index].isalpha():
            end = index + 1
            while end < len(text) and word_char(text[end]):
                end += 1
            yield index, end
            index = end
        else:
            index += 1


def identifier_words(text):
    # Digits, versions, all-uppercase guesses and non-ASCII code are not identifiers
    # eligible for rewriting. No I01 explicit identifier override exists.
    if not re.fullmatch(r'[A-Za-z]+(?:_[A-Za-z]+)*', text):
        return None
    split = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1 \2', text)
    split = re.sub(r'([a-z])([A-Z])', r'\1 \2', split).replace('_', ' ')
    if split == text:
        return None
    return ' '.join(part.lower() for part in split.split())


def technical(text):
    # Parentheses alone are prose delimiters, not evidence of a command. Inline
    # code remains conservative below; attached call syntax is protected here.
    # Dollar syntax must be reserved before lexical_ranges skips its prefix.
    return bool(re.search(r'[\d/\\:@=<>+*|&%${}\[\]]|^[-~.]|--|[\w][.-][\w]|[\w$]\(|\)[\w$]', text))


LEADING_PROSE = '("\'\u00ab\u201c\u2018\u00bf\u00a1'
TRAILING_PROSE = ':;,!?.\u2026)"\'\u201d\u00bb\u2019'


def core_range(atom, offset=0):
    """Absolute (start, end) of an atom without prose punctuation on its edges.

    Only sentence/quote/parenthesis marks are stripped. Technical syntax
    characters ([ ] { } < > $ / \\ @ = + * | & % - ~) are never edge-stripped. A
    closing parenthesis is kept when it balances an opening one inside the core
    so call syntax such as foo(bar) stays one indivisible unit.
    """
    start, end = 0, len(atom)
    while start < end and atom[start] in LEADING_PROSE:
        start += 1
    while end > start and atom[end - 1] in TRAILING_PROSE:
        core = atom[start:end]
        if atom[end - 1] == ')' and core.count(')') <= core.count('('):
            break
        end -= 1
    return offset + start, offset + end


def language_evidence(start, end, evidence):
    selected = [entry for entry in evidence if entry['start'] < end and entry['end'] > start]
    if not selected:
        return None, 'fallback-missing', []
    # Out-of-word evidence cannot be invented as exact token evidence.
    coverage = set()
    for entry in selected:
        if entry['start'] < start or entry['end'] > end:
            return None, 'fallback-coverage', selected
        coverage.update(range(entry['start'], entry['end']))
    if len(coverage) != end - start:
        return None, 'fallback-coverage', selected
    labels = {entry['label'] for entry in selected}
    if not labels <= {'en', 'spa'}:
        return None, 'fallback-nonbinary', selected
    if len(labels) != 1:
        return None, 'fallback-conflict', selected
    reason = 'detected-unanimous-window-edge' if any(entry['edge'] for entry in selected) else 'detected-unanimous'
    return ('en' if 'en' in labels else 'es'), reason, selected


def detector_result(detector, text):
    if detector is None:
        return [], ['detector-not-configured']
    try:
        result = detector.detect(text) if hasattr(detector, 'detect') else detector(text)
    except Exception:
        return [], ['detector-invocation-failed']
    if (type(result) is not dict or type(result.get('status')) is not str
            or result['status'] not in ('available', 'degraded', 'unavailable')
            or type(result.get('diagnostics')) is not list
            or len(result['diagnostics']) > 32
            or not all(type(d) is str and re.fullmatch(r'[a-z][a-z0-9-]{0,79}', d)
                       for d in result['diagnostics'])):
        return [], ['invalid-detector-result']
    safe, invalid = sanitize_evidence(result.get('tokens'), text)
    if result['status'] == 'unavailable':
        return [], result['diagnostics'] + invalid + ['detector-unavailable']
    return safe, result['diagnostics'] + invalid


def block_decisions(block, policy, base, evidence):
    text = ''.join(segment['text'] for segment in block['segments'])
    decisions = []
    protected_ranges = []
    position = 0
    for segment in block['segments']:
        end = position + len(segment['text'])
        if segment['protected']:
            protected_ranges.append((position, end))
        if segment['kind'] in ('announcement', 'numbering', 'break'):
            decisions.append((position, end, base, 'structural', None, []))
        elif segment['protected'] and (segment['kind'] != 'inlineCode'
                or technical(segment['text']) or not re.fullmatch(r'[A-Za-z]+(?:_[A-Za-z]+)*', segment['text'])):
            decisions.append((position, end, base, 'protected-technical', None, []))
        elif 'reason' in segment:
            decisions.append((position, end, base, 'neutral', None, []))
        position = end
    # Complex non-whitespace technical units are indivisible before policy matching.
    for match in re.finditer(r'\S+', text):
        start, end = core_range(match.group(), match.start())
        if start < end and technical(text[start:end]) and not overlaps(start, end, decisions):
            decisions.append((start, end, base, 'protected-technical', None, []))
    for dictionary, reason in (('acronyms', 'policy-acronym'), ('names', 'policy-name'),
                               ('expressions', 'policy-expression')):
        entries = policy[dictionary]
        candidates = []
        for key in entries:
            for match in re.finditer(re.escape(key), text):
                a, b = match.span()
                if ((a == 0 or not word_char(text[a - 1]))
                        and (b == len(text) or not word_char(text[b]))):
                    candidates.append((a, b, key))
        for a, b, key in sorted(candidates, key=lambda item: (-(item[1] - item[0]), item[0], item[2])):
            if overlaps(a, b, decisions):
                continue
            # Eligibility for an individual code identifier never removes its
            # boundary. Policy matches may be contained within one protected
            # unit, but cannot enter, leave or bridge protected units.
            if any(start < b and end > a and not (start <= a and b <= end)
                   for start, end in protected_ranges):
                continue
            lang = base if dictionary == 'acronyms' else entries[key]
            spoken = entries[key][base] if dictionary == 'acronyms' else None
            raw = [entry for entry in evidence if entry['start'] < b and entry['end'] > a]
            decisions.append((a, b, lang, reason, spoken, raw))
    for a, b in lexical_ranges(text):
        if overlaps(a, b, decisions):
            continue
        lang, reason, raw = language_evidence(a, b, evidence)
        spoken = identifier_words(text[a:b]) if lang == 'en' else None
        if spoken:
            reason = 'english-identifier'
        decisions.append((a, b, lang or base, reason, spoken, raw))
    return sorted(decisions)


def overlaps(start, end, decisions):
    return any(a < end and b > start for a, b, *_ in decisions)


def resolve_plan(plan, detector=None):
    snapshot = validate_plan(plan)
    base = snapshot['defaultLanguage']
    result = {'resolvedSchemaVersion': 1, 'languageStatus': 'resolved',
              'structuralPlan': snapshot, 'blocks': [], 'diagnostics': [],
              'offsetUnit': 'utf16', 'rangeConvention': 'end-exclusive',
              'sourceGranularity': 'containing-original-segment',
              'derivedRangeReference': 'segment-text',
              'evidenceReference': 'block-derived-text-python-codepoint',
              'detectorIdentity': {'checkpoint': CHECKPOINT, 'revision': REVISION,
                                   'integrity': 'unverified-local-assets'},
              'scoreSemantics': 'uncalibrated-softmax'}
    for block_index, block in enumerate(snapshot['blocks']):
        text = ''.join(segment['text'] for segment in block['segments'])
        evidence, diagnostics = detector_result(detector, text) if text.strip() else ([], [])
        result['diagnostics'].extend({'blockIndex': block_index, 'code': code} for code in sorted(set(diagnostics)))
        decisions = block_decisions(block, snapshot['policy']['resolver'], base, evidence)
        resolved = {'blockIndex': block_index, 'units': []}
        position = 0
        for segment_index, segment in enumerate(block['segments']):
            end = position + len(segment['text'])
            cuts = {position, end}
            for a, b, *_ in decisions:
                if a < end and b > position:
                    cuts.update((max(position, a), min(end, b)))
            points = sorted(cuts)
            prefix = utf16_prefix(segment['text'])
            for a, b in zip(points, points[1:]):
                decision = next((d for d in decisions if d[0] <= a < b <= d[1]), None)
                lang, reason, spoken, raw = decision[2:] if decision else (base, 'neutral', None, [])
                fragment = text[a:b]
                # Rewrites cannot straddle structural segments: there is no precise
                # original trace for distributing an expansion across multiple inputs.
                if spoken is not None and (a != decision[0] or b != decision[1]):
                    spoken, reason = None, 'fallback-cross-segment-rewrite'
                resolved['units'].append({'segmentIndex': segment_index,
                    'text': fragment, 'spokenText': spoken if spoken is not None else fragment,
                    'language': lang, 'reason': reason, 'protected': segment['protected'],
                    'source': copy.deepcopy(segment['source']),
                    'derivedRange': {'start': prefix[a - position], 'end': prefix[b - position]},
                    'decisionRange': {'start': decision[0], 'end': decision[1]} if decision else {'start': a, 'end': b},
                    'rawEvidence': copy.deepcopy(raw)})
            position = end
        result['blocks'].append(resolved)
    length = utf16_length(flatten_blocks(result['blocks'], resolved=True))
    result['resolvedNarrationLength'] = length
    result['resolutionOutcome'] = 'expansion-limit' if length > snapshot['policy']['maxNarrationLength'] else 'complete'
    result['synthesisReady'] = result['resolutionOutcome'] == 'complete' and snapshot['outcome'] != 'unsplittable'
    return result


def main():
    """JSON stdin/stdout only; errors never reproduce original prose."""
    import argparse
    from narration_lid import LocalDetector
    parser = argparse.ArgumentParser(description='Resolve an inactive PN-I01 narration plan')
    parser.add_argument('--model-directory', help='Existing local model only; never downloaded')
    arguments = parser.parse_args()
    detector = LocalDetector(arguments.model_directory) if arguments.model_directory else None
    try:
        result = resolve_plan(json.load(sys.stdin), detector)
        json.dump(result, sys.stdout, ensure_ascii=True, allow_nan=False)
        sys.stdout.write('\n')
    except (ValueError, TypeError, RecursionError):
        sys.stderr.write('Invalid narration input\n')
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
