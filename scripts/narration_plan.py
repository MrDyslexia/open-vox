"""Strict PN-I01 JSON validation. Source offsets are UTF16, end-exclusive.

No normalization or substring searching is permitted at this boundary. Python
indices are converted only at scalar boundaries in the unchanged original.
"""

import copy
import re

MAX_SAFE_INTEGER = 2 ** 53 - 1
# Match JavaScript String.trim, not Python's broader Unicode whitespace set.
JS_WHITESPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680' + ''.join(
    chr(code) for code in range(0x2000, 0x200B)) + '\u2028\u2029\u202f\u205f\u3000\ufeff'
REASONS = {'code', 'table', 'html', 'definition', 'raw-url', 'image',
           'image-destination', 'link-destination', 'thematic-break',
           'length-limit', 'protected-unit-too-large'}


class PlanError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise PlanError('Invalid narration wire: ' + message)


def fields(value, required, optional=()):
    require(type(value) is dict, 'expected object')
    require(set(required) <= value.keys() <= set(required) | set(optional), 'fields')


def integer(value, minimum=0, maximum=MAX_SAFE_INTEGER):
    require(type(value) is int and minimum <= value <= maximum, 'unsafe integer')


def string(value, nonempty=False):
    require(type(value) is str, 'expected string')
    require(not any(0xD800 <= ord(c) <= 0xDFFF for c in value), 'unpaired surrogate')
    require(not nonempty or bool(value.strip(JS_WHITESPACE)), 'empty string')


def choice(value, options):
    require(type(value) is str and value in options, 'unsupported enum')


def utf16_prefix(text):
    string(text)
    prefix = [0]
    for char in text:
        prefix.append(prefix[-1] + (2 if ord(char) > 0xFFFF else 1))
    return prefix


def utf16_length(text):
    return utf16_prefix(text)[-1]


def source_indices(original, source):
    fields(source, ('start', 'end'))
    prefix = utf16_prefix(original)
    integer(source['start'], 0, prefix[-1])
    integer(source['end'], source['start'], prefix[-1])
    reverse = {offset: index for index, offset in enumerate(prefix)}
    require(source['start'] in reverse and source['end'] in reverse, 'mid-surrogate offset')
    return reverse[source['start']], reverse[source['end']]


def source_slice(original, source):
    start, end = source_indices(original, source)
    return original[start:end]


def trace_reason(value):
    string(value, True)
    require(value in REASONS or re.fullmatch(r'unsupported-node:[a-zA-Z][a-zA-Z0-9]*', value), 'trace reason')


def validate_policy(policy):
    fields(policy, ('schemaVersion', 'maxNarrationLength', 'markdown', 'announcements', 'resolver'))
    integer(policy['schemaVersion'], 1, 1)
    integer(policy['maxNarrationLength'], 1, 4000)
    actions = {'code': ('announce', 'omit'), 'table': ('announce', 'omit'),
               'image': ('alt', 'omit'), 'link': ('visible-text',), 'rawUrl': ('omit',),
               'html': ('omit-with-content',), 'definition': ('omit',),
               'thematicBreak': ('separate',), 'unknown': ('omit', 'fail')}
    fields(policy['markdown'], actions)
    for key, options in actions.items():
        choice(policy['markdown'][key], options)

    def bilingual(pair):
        fields(pair, ('es', 'en'))
        for value in pair.values():
            string(value, True)

    fields(policy['announcements'], ('code', 'table'))
    for pair in policy['announcements'].values():
        bilingual(pair)
    resolver = policy['resolver']
    fields(resolver, ('acronyms', 'names', 'expressions', 'fallback'))
    choice(resolver['fallback'], ('defaultLanguage',))
    for name in ('acronyms', 'names', 'expressions'):
        require(type(resolver[name]) is dict, 'dictionary')
        for key, value in resolver[name].items():
            string(key, True)
            if name == 'acronyms':
                bilingual(value)
            else:
                choice(value, ('es', 'en'))


def flatten_blocks(blocks, resolved=False):
    texts = []
    for block in blocks:
        segments = block['units'] if resolved else block['segments']
        parts = [s['spokenText'] if resolved else s['text'] for s in segments]
        for index in range(len(parts)):
            if segments[index]['protected']:
                break
            parts[index] = parts[index].lstrip(JS_WHITESPACE)
            if parts[index]:
                break
        for index in range(len(parts) - 1, -1, -1):
            if segments[index]['protected']:
                break
            parts[index] = parts[index].rstrip(JS_WHITESPACE)
            if parts[index]:
                break
        text = ''.join(parts)
        if text:
            texts.append(text)
    return '\n'.join(texts)


def validate_plan(value):
    fields(value, ('schemaVersion', 'policy', 'original', 'offsetUnit', 'rangeConvention',
                   'defaultLanguage', 'languageStatus', 'blocks', 'omissions',
                   'narrationLength', 'outcome', 'truncated'))
    integer(value['schemaVersion'], 1, 1)
    validate_policy(value['policy'])
    string(value['original'])
    choice(value['offsetUnit'], ('utf16',))
    choice(value['rangeConvention'], ('end-exclusive',))
    choice(value['defaultLanguage'], ('es', 'en'))
    choice(value['languageStatus'], ('unresolved',))
    choice(value['outcome'], ('complete', 'truncated', 'unsplittable'))
    require(type(value['truncated']) is bool and value['truncated'] == (value['outcome'] != 'complete'), 'limit outcome')
    integer(value['narrationLength'], 0, value['policy']['maxNarrationLength'])
    require(type(value['blocks']) is list and type(value['omissions']) is list, 'arrays')
    original = value['original']
    previous_start = 0
    for block in value['blocks']:
        fields(block, ('type', 'source', 'boundary', 'depth', 'quoteDepth', 'segments'))
        choice(block['type'], ('paragraph', 'heading', 'listItem', 'code', 'table', 'separator'))
        choice(block['boundary'], ('newline',))
        integer(block['depth'])
        integer(block['quoteDepth'])
        source_indices(original, block['source'])
        span = block['source']
        require(span['end'] > span['start'] >= previous_start, 'block order')
        previous_start = span['start']
        require(type(block['segments']) is list, 'segments')
        previous_end = span['start']
        for segment in block['segments']:
            fields(segment, ('text', 'source', 'protected', 'kind'), ('reason',))
            string(segment['text'])
            require(bool(segment['text']), 'empty segment')
            require(type(segment['protected']) is bool, 'protection')
            choice(segment['kind'], ('text', 'inlineCode', 'imageAlt', 'announcement', 'numbering', 'break'))
            if 'reason' in segment:
                trace_reason(segment['reason'])
            source_indices(original, segment['source'])
            source = segment['source']
            require(previous_end <= source['start'] < source['end'] <= span['end'], 'segment containment/order')
            previous_end = source['end']
            if segment['kind'] in ('inlineCode', 'announcement', 'numbering'):
                require(segment['protected'], 'indivisible segment protection')
    reasons = set()
    for omission in value['omissions']:
        fields(omission, ('source', 'reason'))
        source_indices(original, omission['source'])
        require(omission['source']['end'] > omission['source']['start'], 'empty omission')
        trace_reason(omission['reason'])
        reasons.add(omission['reason'])
    limit, unsplittable = 'length-limit' in reasons, 'protected-unit-too-large' in reasons
    require((value['outcome'] == 'complete' and not limit and not unsplittable)
            or (value['outcome'] == 'truncated' and limit and not unsplittable)
            or (value['outcome'] == 'unsplittable' and unsplittable), 'limit trace')
    require(utf16_length(flatten_blocks(value['blocks'])) == value['narrationLength'], 'spoken length')
    return copy.deepcopy(value)
