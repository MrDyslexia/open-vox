import copy
import re
import unittest

from test_narration_plan import plan_for
from test_narration_lid import token
from narration_resolver import resolve_plan


class Detector:
    def __init__(self, tokens):
        self.tokens, self.contexts = tokens, []

    def detect(self, text):
        self.contexts.append(text)
        return {'status': 'available', 'tokens': self.tokens, 'diagnostics': []}


def units(result):
    return [unit for block in result['blocks'] for unit in block['units']]


class ResolverTests(unittest.TestCase):
    def test_acronym_and_known_policy_precedence(self):
        plan = plan_for('API GitHub TypeScript Docker Open editor local')
        result = resolve_plan(plan)
        spoken = ''.join(unit['spokenText'] for unit in units(result))
        self.assertEqual(spoken, 'a pe i GitHub TypeScript Docker Open editor local')
        self.assertEqual([unit['language'] for unit in units(result) if unit['reason'] == 'policy-expression'], ['en'])
        for unit in units(result):
            if unit['text'] == 'local':
                self.assertEqual(unit['language'], 'es')

    def test_identifiers_require_unanimous_complete_evidence(self):
        text = 'getUserName'
        for evidence, expected in [([token(0, 3), token(3, 7), token(7, 11)], 'get user name'),
                                   ([token(0, 3), token(4, 11)], text),
                                   ([token(0, 3), token(3, 11, 'spa')], text),
                                   ([token(0, 11, 'ne')], text), ([], text)]:
            with self.subTest(expected=expected):
                result = resolve_plan(plan_for(text), Detector(evidence))
                self.assertEqual(''.join(u['spokenText'] for u in units(result)), expected)

    def test_context_and_neutral_units(self):
        detector = Detector([token(0, 6), token(7, 12, 'spa')])
        plan = plan_for('editor local, 😀 e\u0301')
        original = copy.deepcopy(plan)
        result = resolve_plan(plan, detector)
        self.assertEqual(plan, original)
        self.assertEqual(result['structuralPlan'], original)
        self.assertEqual(detector.contexts, [plan['original']])
        self.assertEqual(''.join(u['text'] for u in units(result)), plan['original'])
        self.assertTrue(any(u['reason'] == 'neutral' for u in units(result)))

    def test_technical_protection(self):
        for text in ['run getUserName --force', 'v1.2.3', 'C:\\getUserName\\file',
                     '/getUserName/file', 'https://getUserName.dev', 'getUserName>=2', '1,23']:
            with self.subTest(text=text):
                result = resolve_plan(plan_for(text, kind='inlineCode'), Detector([token(0, len(text))]))
                self.assertEqual(''.join(u['spokenText'] for u in units(result)), text)
                self.assertTrue(all(u['reason'] == 'protected-technical' for u in units(result)))

    def test_dictionary_boundaries_and_longest_expression(self):
        plan = plan_for('GitHubber Open editor control')
        plan['policy']['resolver']['expressions']['Open'] = 'es'
        result = resolve_plan(plan)
        decisions = [(u['text'], u['reason'], u['language']) for u in units(result)]
        self.assertIn(('GitHubber', 'fallback-missing', 'es'), decisions)
        self.assertIn(('Open editor', 'policy-expression', 'en'), decisions)
        self.assertIn(('control', 'fallback-missing', 'es'), decisions)

    def test_malformed_detector_degrades(self):
        for raw in [None, {'status': 'available', 'tokens': [None]},
                    {'status': 'available', 'tokens': [], 'diagnostics': {'bad': 'value'}},
                    {'status': 'available', 'tokens': [], 'diagnostics': [10 ** 10000]}]:
            result = resolve_plan(plan_for('local'), lambda text: raw)
            self.assertTrue(result['diagnostics'])
            self.assertEqual(units(result)[0]['language'], 'es')

    def test_english_base_acronyms_and_nonbinary(self):
        for label in ['O', 'ambiguous', 'fw', 'mixed', 'ne', 'other', 'unk']:
            result = resolve_plan(plan_for('local', 'en'), Detector([token(0, 5, label)]))
            self.assertEqual(units(result)[0]['language'], 'en')
            self.assertEqual(units(result)[0]['reason'], 'fallback-nonbinary')
        result = resolve_plan(plan_for('API HTTP', 'en'), Detector([token(0, 3, 'spa'), token(4, 8, 'spa')]))
        self.assertEqual(''.join(u['spokenText'] for u in units(result)), 'ay pee eye aitch tee tee pee')

    def test_overlap_conflict_and_combining_coverage(self):
        for text, evidence, reason in [('local', [token(0, 5), token(0, 5, 'spa')], 'fallback-conflict'),
                                        ('e\u0301', [token(0, 1)], 'fallback-coverage'),
                                        ('e\u0301', [token(0, 2)], 'detected-unanimous')]:
            result = resolve_plan(plan_for(text), Detector(evidence))
            self.assertEqual(units(result)[0]['reason'], reason)

    def test_derived_not_invented_original_offsets(self):
        plan = plan_for('😀 API &amp; local')
        plan['blocks'][0]['segments'][0]['text'] = '😀 API & local'
        plan['narrationLength'] = 14
        result = resolve_plan(plan)
        self.assertEqual(result['sourceGranularity'], 'containing-original-segment')
        for unit in units(result):
            self.assertEqual(unit['source'], {'start': 0, 'end': 18})
        api = next(u for u in units(result) if u['text'] == 'API')
        self.assertEqual(api['derivedRange'], {'start': 3, 'end': 6})
        self.assertEqual(result['structuralPlan']['original'], '😀 API &amp; local')

    def test_expression_cross_segments_but_not_blocks_or_protection(self):
        plan = plan_for('Open editor')
        plan['blocks'][0]['segments'] = [
            {'text': text, 'source': {'start': a, 'end': b}, 'kind': 'text', 'protected': False}
            for text, a, b in [('Open', 0, 4), (' ', 4, 5), ('editor', 5, 11)]]
        result = resolve_plan(plan)
        self.assertTrue(all(u['reason'] == 'policy-expression' for u in units(result)))
        plan['blocks'][0]['segments'][1]['protected'] = True
        result = resolve_plan(plan)
        self.assertFalse(any(u['reason'] == 'policy-expression' for u in units(result)))
        plan = plan_for('Open\neditor')
        first = plan['blocks'][0]
        second = copy.deepcopy(first)
        first['source'] = {'start': 0, 'end': 4}
        first['segments'][0].update(text='Open', source=first['source'].copy())
        second['source'] = {'start': 5, 'end': 11}
        second['segments'][0].update(text='editor', source=second['source'].copy())
        plan['blocks'] = [first, second]
        result = resolve_plan(plan)
        self.assertFalse(any(u['reason'] == 'policy-expression' for u in units(result)))

    def test_standalone_inline_identifiers_and_no_uppercase_guess(self):
        for text in ['getUserName', 'get_user_name']:
            result = resolve_plan(plan_for(text, kind='inlineCode'), Detector([token(0, len(text))]))
            self.assertEqual(''.join(u['spokenText'] for u in units(result)), 'get user name')
        result = resolve_plan(plan_for('NASA'))
        self.assertEqual(units(result)[0]['spokenText'], 'NASA')
        self.assertEqual(units(result)[0]['reason'], 'fallback-missing')

    def test_cap_outcome_and_expansion_limit(self):
        plan = plan_for('API')
        plan['policy']['maxNarrationLength'] = 3
        result = resolve_plan(plan)
        self.assertEqual(result['resolutionOutcome'], 'expansion-limit')
        self.assertFalse(result['synthesisReady'])
        self.assertEqual(result['structuralPlan']['outcome'], 'complete')
        plan = plan_for('local')
        plan['outcome'], plan['truncated'] = 'truncated', True
        plan['omissions'] = [{'source': {'start': 0, 'end': 5}, 'reason': 'length-limit'}]
        result = resolve_plan(plan)
        self.assertEqual(result['structuralPlan']['omissions'], plan['omissions'])
        self.assertEqual(result['structuralPlan']['outcome'], 'truncated')

    def test_unavailable_never_claims_detection(self):
        raw = {'status': 'unavailable', 'tokens': [token(0, 5)], 'diagnostics': ['missing-local-assets']}
        result = resolve_plan(plan_for('local'), lambda _: raw)
        self.assertEqual(units(result)[0]['reason'], 'fallback-missing')
        self.assertEqual(units(result)[0]['rawEvidence'], [])
        self.assertTrue(any(d['code'] == 'detector-unavailable' for d in result['diagnostics']))

    def test_literal_expression_regex_and_acronym_overlap(self):
        plan = plan_for('API editor Open editor')
        plan['policy']['resolver']['expressions'].update({'API editor': 'en', 'Open.*': 'en'})
        result = resolve_plan(plan)
        decisions = {u['text']: u['reason'] for u in units(result) if u['text'].strip()}
        self.assertEqual(decisions['API'], 'policy-acronym')
        self.assertEqual(decisions['editor'], 'fallback-missing')
        self.assertEqual(decisions['Open editor'], 'policy-expression')

    def test_nearby_shared_words_not_extended_english(self):
        result = resolve_plan(plan_for('editor local control'), Detector([token(0, 6)]))
        decision = {u['text']: u['language'] for u in units(result) if u['text'].strip()}
        self.assertEqual(decision, {'editor': 'en', 'local': 'es', 'control': 'es'})

    def test_expression_cannot_cross_eligible_inline_code_boundaries(self):
        cases = [
            ('Open `editor`', [('Open', 0, 4, False), (' ', 4, 5, False), ('editor', 5, 13, True)]),
            ('`Open` editor', [('Open', 0, 6, True), (' ', 6, 7, False), ('editor', 7, 13, False)]),
            ('`Open` `editor`', [('Open', 0, 6, True), (' ', 6, 7, False), ('editor', 7, 15, True)]),
        ]
        for original, pieces in cases:
            plan = plan_for(original)
            plan['narrationLength'] = 11
            plan['blocks'][0]['segments'] = [
                {'text': text, 'source': {'start': a, 'end': b}, 'protected': protected,
                 'kind': 'inlineCode' if protected else 'text'} for text, a, b, protected in pieces]
            before = copy.deepcopy(plan)
            with self.subTest(original=original):
                result = resolve_plan(plan, Detector([]))
                self.assertFalse(any(u['reason'] == 'policy-expression' for u in units(result)))
                self.assertTrue(all(u['language'] == 'es' for u in units(result)))
                self.assertEqual(result['structuralPlan'], before)
                self.assertEqual(plan, before)
                for unit in units(result):
                    segment = plan['blocks'][0]['segments'][unit['segmentIndex']]
                    self.assertEqual(unit['source'], segment['source'])
                detected = resolve_plan(plan, Detector([token(5, 11)]))
                editor = next(u for u in units(detected) if u['text'] == 'editor')
                self.assertEqual(editor['language'], 'en')
                self.assertFalse(any(u['reason'] == 'policy-expression' for u in units(detected)))
        ordinary = resolve_plan(plan_for('Open editor'), Detector([]))
        self.assertEqual(units(ordinary)[0]['reason'], 'policy-expression')

    def test_parenthetical_acronyms_preserve_delimiters_in_both_languages(self):
        for language, api, http in [('es', 'a pe i', 'hache te te pe'),
                                    ('en', 'ay pee eye', 'aitch tee tee pee')]:
            for name, spelling in [('API', api), ('HTTP', http)]:
                plan = plan_for('(' + name + ')', language)
                with self.subTest(language=language, name=name):
                    result = resolve_plan(plan, Detector([]))
                    self.assertEqual(''.join(u['spokenText'] for u in units(result)), '(' + spelling + ')')
                    self.assertEqual(''.join(u['text'] for u in units(result)), '(' + name + ')')
                    self.assertEqual([u['text'] for u in units(result) if u['reason'] == 'neutral'], ['(', ')'])
                    self.assertEqual(result['structuralPlan'], plan)

    def test_function_calls_and_inline_commands_remain_indivisible(self):
        for text in ['foo(API)', 'foo(HTTP)', 'foo (API)', 'run foo(API) --force', '(API)']:
            for kind in (['text', 'inlineCode'] if text in ['foo(API)', 'foo(HTTP)'] else ['inlineCode']):
                with self.subTest(text=text, kind=kind):
                    result = resolve_plan(plan_for(text, kind=kind), Detector([]))
                    self.assertEqual(''.join(u['spokenText'] for u in units(result)), text)
                    self.assertTrue(all(u['reason'] == 'protected-technical' for u in units(result)))

    def test_variable_syntax_protects_identifiers_before_english_rewrite(self):
        for text in ['$getUserName', '${getUserName}', '$env:getUserName', '${env:getUserName}',
                     '$Env:PATH', '%getUserName%']:
            start = text.find('getUserName')
            evidence = [token(start, start + 11)] if start >= 0 else []
            for kind in ['text', 'inlineCode']:
                with self.subTest(text=text, kind=kind):
                    plan = plan_for(text, kind=kind)
                    result = resolve_plan(plan, Detector(evidence))
                    self.assertEqual(''.join(u['spokenText'] for u in units(result)), text)
                    self.assertTrue(all(u['reason'] == 'protected-technical' for u in units(result)))
                    self.assertEqual(result['structuralPlan'], plan)
        plain = plan_for('getUserName')
        self.assertEqual(units(resolve_plan(plain, Detector([token(0, 11)])))[0]['spokenText'], 'get user name')
        self.assertEqual(units(resolve_plan(plain, Detector([])))[0]['spokenText'], 'getUserName')

    def test_edge_prose_punctuation_does_not_protect_words(self):
        text = 'Para dar PN por aceptado (I05.5), escuchá esto en OpenCode: textos'
        spans = [('Para', 'spa'), ('dar', 'spa'), ('PN', 'spa'), ('por', 'spa'), ('aceptado', 'spa'),
                 ('escuchá', 'spa'), ('esto', 'spa'), ('en', 'spa'), ('Open', 'en'), ('C', 'en'),
                 ('ode', 'en'), ('textos', 'spa')]
        evidence, cursor = [], 0
        for word, label in spans:
            start = text.index(word, cursor)
            evidence.append(token(start, start + len(word), label))
            cursor = start + len(word)
        result = resolve_plan(plan_for(text), Detector(evidence))
        by_text = {u['text']: u for u in units(result)}
        self.assertEqual((by_text['OpenCode']['language'], by_text['OpenCode']['reason'],
                          by_text['OpenCode']['spokenText']), ('en', 'english-identifier', 'open code'))
        colon = next(u for u in units(result) if u['text'].startswith(':'))
        self.assertEqual((colon['reason'], colon['language']), ('neutral', 'es'))
        self.assertEqual(by_text['I05.5']['reason'], 'protected-technical')
        comma = next(u for u in units(result) if u['text'].startswith('),'))
        self.assertEqual(comma['reason'], 'neutral')
        self.assertEqual(''.join(u['text'] for u in units(result)), text)

    def test_trailing_and_wrapping_prose_marks_are_outside_the_word(self):
        cases = [('deployment:', 'deployment', ':'), ('API:', 'API', ':'), ('deployment?', 'deployment', '?'),
                 ('deployment!', 'deployment', '!'), ('deployment,', 'deployment', ','),
                 ('deployment;', 'deployment', ';'), ('deployment?!', 'deployment', '?!'),
                 ('OpenCode:)', 'OpenCode', ':)'), ('deployment…', 'deployment', '…'),
                 ('(deployment)', 'deployment', None), ('"deployment"', 'deployment', None),
                 ('«deployment»', 'deployment', None), ('¿deployment?', 'deployment', None),
                 ('“deployment”', 'deployment', None), ('(deployment):', 'deployment', None)]
        for atom, word, tail in cases:
            with self.subTest(atom=atom):
                result = resolve_plan(plan_for(atom), Detector([]))
                self.assertFalse(any(u['reason'] == 'protected-technical' for u in units(result)))
                target = next(u for u in units(result) if u['text'] == word)
                self.assertEqual(target['reason'], 'policy-acronym' if word == 'API' else 'fallback-missing')
                self.assertTrue(all(u['reason'] == 'neutral' for u in units(result) if u['text'] != word))
                self.assertEqual(''.join(u['text'] for u in units(result)), atom)
                if tail:
                    self.assertIn(tail, [u['text'] for u in units(result)])

    def test_pure_prose_punctuation_atoms_are_neutral(self):
        for text in ['a : b', 'a ... b', '¿ a', 'a …']:
            with self.subTest(text=text):
                result = resolve_plan(plan_for(text), Detector([]))
                self.assertFalse(any(u['reason'] == 'protected-technical' for u in units(result)))

    def test_technical_cores_stay_protected_with_or_without_edge_marks(self):
        atoms = ['https://x.com/a', 'src/a/b.ts', '/etc/hosts', '--flag', '-x', 'foo.bar', '.gitignore', '~/x',
                 'foo-1', 'foo(bar)', 'foo()', '$VAR', 'x=1', 'v1.2.3', 'arr[0]', '{}', '<tag>',
                 'C:\\path', '10:30', 'key:value', 'file.txt']
        for atom in atoms:
            for suffix in ['', '.', ',', ':', ';', '?!', '…', ')']:
                for prefix in ['', '"']:
                    wrapped = prefix + atom + suffix
                    if suffix == ')' and atom.count('(') >= atom.count(')') and '(' in atom:
                        continue
                    with self.subTest(atom=wrapped):
                        result = resolve_plan(plan_for(wrapped), Detector([token(0, len(wrapped))]))
                        protected = ''.join(u['text'] for u in units(result) if u['reason'] == 'protected-technical')
                        self.assertEqual(protected, atom)
                        self.assertEqual(''.join(u['text'] for u in units(result)), wrapped)
        result = resolve_plan(plan_for('(https://x.com/a), ok'), Detector([]))
        self.assertEqual([u['text'] for u in units(result) if u['reason'] == 'protected-technical'],
                         ['https://x.com/a'])

    @staticmethod
    def tagged(text, english):
        """Stub detector evidence: every letter run is `en` if listed, else `spa`."""
        return [token(m.start(), m.end(), 'en' if m.group().lower() in english else 'spa')
                for m in re.finditer(r'[^\W\d_]+', text)]

    def test_hyphenated_prose_compounds_are_routed_per_word(self):
        english = {'back', 'end', 'real', 'time', 'e', 'mail', 'well', 'known', 'state', 'of', 'the', 'art'}
        cases = [
            ('Necesitamos un back-end más real-time para el e-mail well-known.', 'es',
             {'back': 'en', 'end': 'en', 'real': 'en', 'time': 'en', 'mail': 'en', 'well': 'en', 'known': 'en',
              'Necesitamos': 'es', 'más': 'es'}),
            ('We need a state-of-the-art back-end (real-time), e-mail: well-known.', 'en',
             {'state': 'en', 'of': 'en', 'the': 'en', 'art': 'en', 'back': 'en', 'real': 'en'}),
            ('Un anti-patrón bien-conocido.', 'es', {'anti': 'es', 'patrón': 'es', 'bien': 'es', 'conocido': 'es'}),
        ]
        for text, language, expected in cases:
            with self.subTest(text=text):
                result = resolve_plan(plan_for(text, language), Detector(self.tagged(text, english)))
                found = units(result)
                self.assertFalse(any(u['reason'] == 'protected-technical' for u in found))
                self.assertEqual(''.join(u['text'] for u in found), text)
                by_text = {u['text']: u for u in found}
                for word, lang in expected.items():
                    self.assertEqual(by_text[word]['language'], lang, word)
                    self.assertEqual(by_text[word]['reason'], 'detected-unanimous', word)


    def test_slash_alternatives_are_routed_per_word(self):
        english = {'and', 'or', 'open', 'code', 'opencode', 'claude', 'on', 'off'}
        cases = [('Usamos y/o OpenCode/Claude aquí.', {'y': 'es', 'o': 'es', 'OpenCode': 'en', 'Claude': 'en'}),
                 ('Use and/or on/off here.', {'and': 'en', 'or': 'en', 'on': 'en', 'off': 'en'})]
        for text, expected in cases:
            with self.subTest(text=text):
                language = 'es' if text.startswith('Usamos') else 'en'
                result = resolve_plan(plan_for(text, language), Detector(self.tagged(text, english)))
                found = units(result)
                self.assertFalse(any(u['reason'] == 'protected-technical' for u in found))
                self.assertEqual(''.join(u['text'] for u in found), text)
                by_text = {u['text']: u for u in found}
                for word, lang in expected.items():
                    self.assertEqual(by_text[word]['language'], lang, word)
                    self.assertTrue(by_text[word]['reason'].startswith('detected-unanimous')
                                    or by_text[word]['reason'] == 'english-identifier', word)


    def test_compound_negative_matrix_stays_protected(self):
        atoms = ['--flag', '-x', 'a--b', 'foo-1', 'v2-beta', 'foo_bar-baz', 'a-b.c', 'anti-patrón.x',
                 'a-b-c-d-e-f', '-foo-bar', 'foo-bar-', 'src/app', 'usr/bin', 'docs/readme', 'read/write',
                 '/etc/hosts', './x', '~/x', 'a/b/c', 'and/or/not', 'http://x.com/a', 'C:\\x', 'foo/bar.txt',
                 'y/o/e', 'key:value', '10:30', '2026-10-13', 'and/', '/or', 'and//or', 'averyveryveryverylong/x',
                 'a/1', 'and/or.txt']
        for atom in atoms:
            for wrap in [('', ''), ('', '.'), ('', ','), ('', ':'), ('(', ')'), ('"', '".')]:
                text = wrap[0] + atom + wrap[1]
                with self.subTest(text=text):
                    result = resolve_plan(plan_for(text), Detector([token(0, len(text))]))
                    protected = ''.join(u['text'] for u in units(result) if u['reason'] == 'protected-technical')
                    self.assertEqual(protected, atom)

                    self.assertEqual(''.join(u['text'] for u in units(result)), text)

    def test_abbreviations_stay_protected(self):
        for atom in ('e.g.', 'U.S.', 'i.e.', 'e.g.,'):
            with self.subTest(atom=atom):
                result = resolve_plan(plan_for('ver ' + atom + ' ok'), Detector([]))
                self.assertTrue(any(u['reason'] == 'protected-technical' for u in units(result)))

    def test_kebab_identifier_is_prose_only_outside_protected_code(self):
        english = {'my', 'component'}
        text = 'my-component'
        prose = units(resolve_plan(plan_for(text, 'es'), Detector(self.tagged(text, english))))
        self.assertFalse(any(u['reason'] == 'protected-technical' for u in prose))
        self.assertEqual([u['language'] for u in prose if u['text'] in english], ['en', 'en'])
        code = units(resolve_plan(plan_for(text, 'es', kind='inlineCode'), Detector(self.tagged(text, english))))
        self.assertEqual([(u['text'], u['reason'], u['language']) for u in code],
                         [(text, 'protected-technical', 'es')])
        for plain in ('and/or', 'OpenCode/Claude', 'e-mail'):
            with self.subTest(plain=plain):
                code = units(resolve_plan(plan_for(plain, 'es', kind='inlineCode'), Detector([token(0, len(plain))])))
                self.assertEqual([u['reason'] for u in code], ['protected-technical'])


if __name__ == '__main__':
    unittest.main()
