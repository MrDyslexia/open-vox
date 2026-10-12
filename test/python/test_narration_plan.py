import copy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from narration_plan import PlanError, source_slice, validate_plan


def plan_for(text, language='es', kind='text'):
    length = len(text.encode('utf-16-le')) // 2
    source = {'start': 0, 'end': length}
    policy = json.loads((ROOT / 'resources/narration-policies.json').read_text(encoding='utf-8'))
    return {'schemaVersion': 1, 'policy': policy, 'original': text,
            'offsetUnit': 'utf16', 'rangeConvention': 'end-exclusive',
            'defaultLanguage': language, 'languageStatus': 'unresolved',
            'blocks': [{'type': 'paragraph', 'source': source, 'boundary': 'newline',
                        'depth': 0, 'quoteDepth': 0, 'segments': [
                            {'text': text, 'source': source.copy(), 'protected': kind == 'inlineCode', 'kind': kind}]}],
            'omissions': [], 'narrationLength': length, 'outcome': 'complete', 'truncated': False}


class PlanTests(unittest.TestCase):
    def test_unicode_source_conversion(self):
        self.assertEqual(source_slice('😀e\u0301😀', {'start': 2, 'end': 4}), 'e\u0301')

    def test_detached_snapshot(self):
        original = plan_for('Hola 😀')
        result = validate_plan(original)
        result['blocks'][0]['segments'][0]['text'] = 'mutated'
        self.assertEqual(original['blocks'][0]['segments'][0]['text'], 'Hola 😀')

    def test_invalid_wire(self):
        for key, value in [('schemaVersion', True), ('original', []), ('languageStatus', 'resolved'),
                           ('narrationLength', 100), ('offsetUnit', 'codepoint'), ('truncated', True)]:
            with self.subTest(key=key), self.assertRaises(PlanError):
                plan = plan_for('Hola')
                plan[key] = value
                validate_plan(plan)

    def test_surrogate_and_range_rejection(self):
        for source in [{'start': 1, 'end': 2}, {'start': -1, 'end': 2},
                       {'start': 0, 'end': 10}, {'start': True, 'end': 2}]:
            with self.subTest(source=source), self.assertRaises(PlanError):
                source_slice('😀', source)

    def test_malformed_nested_metadata(self):
        for key, value in [('source', []), ('depth', '1'), ('segments', 'bad')]:
            with self.subTest(key=key), self.assertRaises(PlanError):
                plan = plan_for('Hola')
                plan['blocks'][0][key] = value
                validate_plan(plan)

    def test_policy_and_limit_trace(self):
        plan = plan_for('Hola')
        plan['outcome'], plan['truncated'] = 'truncated', True
        with self.assertRaises(PlanError):
            validate_plan(plan)
        plan['omissions'] = [{'source': {'start': 0, 'end': 4}, 'reason': 'length-limit'}]
        self.assertEqual(validate_plan(plan)['outcome'], 'truncated')
        plan['policy']['resolver']['identifiers'] = 'en'
        with self.assertRaises(PlanError):
            validate_plan(plan)

    def test_unicode_string_shape_and_js_whitespace(self):
        for bad in [None, '\ud800', '\udfff']:
            with self.subTest(bad=type(bad).__name__), self.assertRaises(PlanError):
                source_slice(bad, {'start': 0, 'end': 0})
        for text, expected in [('\ufeffHola\ufeff', 4), ('\x85Hola\x85', 6), ('\u00a0Hola\u00a0', 4)]:
            plan = plan_for(text)
            plan['narrationLength'] = expected
            self.assertEqual(validate_plan(plan)['narrationLength'], expected)

    def test_order_containment_and_unknown_metadata(self):
        for change in ['outside', 'order', 'unknown', 'bool-depth', 'invalid-reason']:
            plan = plan_for('hello')
            if change == 'outside':
                plan['blocks'][0]['segments'][0]['source']['end'] = 6
            elif change == 'order':
                plan['blocks'][0]['segments'].append(copy.deepcopy(plan['blocks'][0]['segments'][0]))
            elif change == 'unknown':
                plan['unexpected'] = 'metadata'
            elif change == 'bool-depth':
                plan['blocks'][0]['depth'] = True
            else:
                plan['blocks'][0]['segments'][0]['reason'] = ['html']
            with self.subTest(change=change), self.assertRaises(PlanError):
                validate_plan(plan)

    def test_protected_whitespace_and_bounds(self):
        self.assertEqual(validate_plan(plan_for('  API  ', kind='inlineCode'))['narrationLength'], 7)
        plan = plan_for('a' * 4001)
        with self.assertRaises(PlanError):
            validate_plan(plan)


if __name__ == '__main__':
    unittest.main()
