"""Mocked G2P/model tests; these do not prove acoustic fidelity or live LID."""
import copy
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from test_narration_plan import plan_for
from narration_resolver import resolve_plan
from narration_synthesis import BLOCK_PAUSE_SECONDS, load_plan, local_lid_directory, prepare_chunks, synthesize_envelope
from narration_lid import REVISION


class SynthesisTests(unittest.TestCase):
    def test_short_mixed_paragraph_uses_one_raw_model_inference(self):
        import numpy as np
        envelope = resolve_plan(plan_for('Hola local, Open editor y seguimos.'))
        g2p_calls, model_calls, style_reads = [], [], []
        style = object()
        def g2p(text, language):
            g2p_calls.append((text, language))
            return 'a'
        def create(text, **kwargs):
            model_calls.append((text, kwargs))
            return np.ones(10, dtype=np.float32), 24000
        model = type('Model', (), {
            'tokenizer': type('Tokenizer', (), {'vocab': {'a': 1, ' ': 2}})(),
            'get_voice_style': lambda self, voice: style_reads.append(voice) or style,
            'create': lambda self, text, **kwargs: create(text, **kwargs),
        })()
        with patch('soundfile.write'):
            result = synthesize_envelope(envelope, model, 'em_alex', 1, 'mock-only.wav', g2p)
        self.assertEqual([language for _, language in g2p_calls], ['es', 'en', 'es'])
        self.assertEqual(len(model_calls), 1)
        self.assertEqual(model_calls[0][0], 'a a a')
        self.assertTrue(model_calls[0][1]['is_phonemes'])
        self.assertIs(model_calls[0][1]['voice'], style)
        self.assertEqual(style_reads, ['em_alex'])
        self.assertEqual(len(result['chunks']), 1)
        self.assertEqual([r['runIndex'] for r in result['chunks'][0]['runs']], [0, 1, 2])

    def test_packing_counts_boundary_space_at_exact_510_and_511(self):
        envelope = resolve_plan(plan_for('Hola Open editor local'))
        for sizes, expected_count in [([250, 257, 0], 1), ([250, 258, 0], 2)]:
            # Keep the ES tail within the third run's raw output: total 510 or 511.
            outputs = iter(['a' * sizes[0], 'a' * sizes[1], '.'])
            chunks = prepare_chunks(envelope, lambda t, l: next(outputs), {'a': 1, ' ': 2, '.': 3})
            self.assertEqual(len(chunks), expected_count)
            self.assertTrue(all(len(c['phonemes']) <= 510 for c in chunks))
            if expected_count == 1:
                self.assertEqual(len(chunks[0]['phonemes']), 510)
            else:
                self.assertEqual([len(c['phonemes']) for c in chunks], [509, 1])
            self.assertEqual(''.join(c['text'] for c in chunks), 'Hola Open editor local')

    def test_packed_raw_adaptation_ranges_preserve_each_run(self):
        envelope = resolve_plan(plan_for('Hola Open editor local'))
        outputs = iter(['«a»', 'a', '«a»'])
        chunks = prepare_chunks(envelope, lambda t, l: next(outputs), {'a': 1, ' ': 2, '"': 3})
        self.assertEqual(len(chunks), 1)
        chunk = chunks[0]
        self.assertEqual(chunk['rawPhonemes'], '«a» a «a»')
        self.assertEqual(chunk['phonemes'], '"a" a "a"')
        self.assertEqual(chunk['mappings'], [{'index': i, 'from': c, 'to': '"'}
                                            for i, c in [(0, '«'), (2, '»'), (6, '«'), (8, '»')]])
        for run, start, end in zip(chunk['runs'], [0, 4, 6], [3, 5, 9]):
            self.assertEqual(run['phonemeRange'], {'start': start, 'end': end})
            self.assertEqual(chunk['phonemes'][start:end], run['phonemes'])
            self.assertEqual(chunk['rawPhonemes'][start:end], run['rawPhonemes'])
            self.assertEqual(run['blockIndex'], 0)
            self.assertTrue(run['units'])

    def test_packing_does_not_invent_space_without_source_whitespace(self):
        envelope = resolve_plan(plan_for('Hola,Open editor,local'))
        chunks = prepare_chunks(envelope, lambda t, l: 'a', {'a': 1})
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0]['phonemes'], 'aaa')
        self.assertEqual([r['language'] for r in chunks[0]['runs']], ['es', 'en', 'es'])

    def test_packing_does_not_duplicate_existing_raw_boundary_space(self):
        envelope = resolve_plan(plan_for('Hola Open editor local'))
        outputs = iter(['a ', 'a ', 'a'])
        chunks = prepare_chunks(envelope, lambda t, l: next(outputs), {'a': 1, ' ': 2})
        self.assertEqual(chunks[0]['phonemes'], 'a a a')
        self.assertEqual([r['separatorBefore'] for r in chunks[0]['runs']], ['', '', ''])

    def test_mixed_runs_pack_within_blocks_but_preserve_structural_pause(self):
        text = 'Hola local, Open editor y seguimos.'
        plan = plan_for(text + '\n\n' + text)
        left = copy.deepcopy(plan['blocks'][0])
        right = copy.deepcopy(left)
        for block, start in [(left, 0), (right, len(text) + 2)]:
            block['source'] = {'start': start, 'end': start + len(text)}
            block['segments'][0].update(text=text, source=block['source'].copy())
        plan['blocks'] = [left, right]
        plan['narrationLength'] = len(text) * 2 + 1
        chunks = prepare_chunks(resolve_plan(plan), lambda t, l: 'a', {'a': 1, ' ': 2})
        self.assertEqual(len(chunks), 2)
        self.assertEqual([c['blockIndex'] for c in chunks], [0, 1])
        self.assertEqual([c['phonemes'] for c in chunks], ['a a a', 'a a a'])
        self.assertEqual([c['pauseBefore'] for c in chunks], [0.0, BLOCK_PAUSE_SECONDS])
        self.assertEqual([[r['runIndex'] for r in c['runs']] for c in chunks], [[0, 1, 2], [0, 1, 2]])

    def test_installed_tokenizer_actual_510_boundary_without_model_inference(self):
        from kokoro_onnx.tokenizer import Tokenizer
        tokenizer = Tokenizer.__new__(Tokenizer)
        tokenizer.vocab = {'a': 1}
        self.assertEqual(len(tokenizer.tokenize('a' * 510)), 510)
        with self.assertRaises(ValueError):
            tokenizer.tokenize('a' * 511)

    def test_helper_failure_is_generic_and_never_echoes_prose(self):
        import kokoro_say
        args = ['kokoro_say.py', '--model', 'mock-model', '--voices', 'mock-voices', '--voice', 'em_alex',
                '--lang', 'es', '--out', 'mock-only.wav', '--plan-json']
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(sys, 'argv', args), patch.object(sys, 'stdin', io.StringIO(json.dumps(plan_for('synthetic')))), \
                patch.object(sys, 'stdout', stdout), patch.object(sys, 'stderr', stderr), \
                patch.object(kokoro_say, 'Kokoro', side_effect=ValueError('do not echo this prose')):
            self.assertEqual(kokoro_say.main(), 2)
        self.assertEqual(stdout.getvalue(), '')
        self.assertEqual(stderr.getvalue(), 'Narration synthesis failed\n')

    def test_failed_final_write_removes_candidate(self):
        import numpy as np
        model = type('Model', (), {
            'tokenizer': type('Tokenizer', (), {'vocab': {'a': 1}})(),
            'get_voice_style': lambda self, voice: object(),
            'create': lambda self, text, **kwargs: (np.ones(10, dtype=np.float32), 24000),
        })()
        with patch('soundfile.write', side_effect=OSError('mock disk failure')), \
                patch('narration_synthesis.os.unlink') as unlink, self.assertRaises(OSError):
            synthesize_envelope(resolve_plan(plan_for('local')), model, 'em_alex', 1, 'mock-only.wav', lambda t, l: 'a')
        unlink.assert_called_once_with('mock-only.wav')

    def test_strict_single_plan_loader_and_reusable_local_revision_path(self):
        plan = plan_for('😀 é API')
        self.assertEqual(load_plan(io.StringIO(json.dumps(plan))), plan)
        for text in [json.dumps(plan) + '{}', '{"schemaVersion":1,"schemaVersion":1}', '{"a":NaN}']:
            with self.subTest(text=text[:20]), self.assertRaises(ValueError):
                load_plan(io.StringIO(text))
        self.assertEqual(local_lid_directory('R'), Path('R') / 'lid' / 'codeswitch-spaeng-lid-lince' / REVISION)

    def test_model_reused_fixed_voice_one_inference_per_chunk_pcm16_and_no_partial_commit(self):
        import numpy as np
        text = ('word ' * 300).rstrip()
        envelope = resolve_plan(plan_for(text))
        class Model:
            tokenizer = type('Tokenizer', (), {'vocab': {c: 1 for c in 'word '}})()
            def __init__(self):
                self.style_reads = 0
                self.calls = []
                self.style = object()
                self.fail_after = None
            def get_voice_style(self, voice):
                self.style_reads += 1
                self.asserted_voice = voice
                return self.style
            def create(self, text, **kwargs):
                self.calls.append((text, kwargs))
                if self.fail_after == len(self.calls):
                    raise ValueError('mock model failure')
                return np.ones(100, dtype=np.float32) * 0.1, 24000
        model = Model()
        with patch('soundfile.write') as write:
            result = synthesize_envelope(envelope, model, 'em_alex', 1.2, 'mock-only.wav', lambda t, l: t)
            self.assertGreater(len(result['chunks']), 1)
            self.assertEqual(model.style_reads, 1)
            self.assertEqual(len(model.calls), len(result['chunks']))
            for text, kwargs in model.calls:
                self.assertLessEqual(len(text), 510)
                self.assertIs(kwargs['voice'], model.style)
                self.assertTrue(kwargs['is_phonemes'])
                self.assertEqual((kwargs['sentence_pause'], kwargs['clause_pause']), (0.0, 0.0))
            write.assert_called_once()
            self.assertEqual(write.call_args.kwargs, {'subtype': 'PCM_16', 'format': 'WAV'})
        model = Model()
        model.fail_after = 2
        with patch('soundfile.write') as write, self.assertRaises(ValueError):
            synthesize_envelope(envelope, model, 'em_alex', 1, 'mock-only.wav', lambda t, l: t)
        write.assert_not_called()

    def test_structural_boundary_pause_is_explicit_without_model_sentence_pause(self):
        plan = plan_for('local\n\nlocal')
        left = copy.deepcopy(plan['blocks'][0])
        right = copy.deepcopy(left)
        for block, a, b in [(left, 0, 5), (right, 7, 12)]:
            block['source'] = {'start': a, 'end': b}
            block['segments'][0].update(text='local', source=block['source'].copy())
        plan['blocks'] = [left, right]
        plan['narrationLength'] = 11
        chunks = prepare_chunks(resolve_plan(plan), lambda t, l: 'a', {'a': 1})
        self.assertEqual([c['pauseBefore'] for c in chunks], [0.0, BLOCK_PAUSE_SECONDS])

    def test_merges_language_runs_preserves_neutral_whitespace_and_source(self):
        envelope = resolve_plan(plan_for('Hola local, Open editor API 😀 é'))
        original = copy.deepcopy(envelope)
        calls = []
        def g2p(text, language):
            calls.append((text, language))
            return 'a'
        chunks = prepare_chunks(envelope, g2p, {'a': 1, ' ': 2})
        self.assertEqual(calls, [('Hola local, ', 'es'), ('Open editor ', 'en'), ('a pe i 😀 é', 'es')])
        self.assertTrue(chunks)
        self.assertEqual(envelope, original)

    def test_safe_long_paragraph_and_exact_510(self):
        for text in ['a' * 510, 'word ' * 300]:
            calls = []
            plan = plan_for(text)
            plan['narrationLength'] = len(text.rstrip())
            chunks = prepare_chunks(resolve_plan(plan), lambda t, l: calls.append(t) or t,
                                    {c: i for i, c in enumerate('aword ')})
            self.assertTrue(chunks)
            self.assertTrue(all(0 < len(c['phonemes']) <= 510 for c in chunks))
            self.assertEqual(''.join(c['text'] for c in chunks), text)
        self.assertEqual(len(prepare_chunks(resolve_plan(plan_for('a' * 510)), lambda t, l: t, {'a': 1})), 1)

    def test_unsplittable_protected_unit_fails(self):
        with self.assertRaises(ValueError):
            prepare_chunks(resolve_plan(plan_for(('command ' * 80).rstrip(), kind='inlineCode')),
                           lambda t, l: t, {c: 1 for c in 'command '})

    def test_expansion_and_structural_readiness_gate(self):
        envelope = resolve_plan(plan_for(('API ' * 900).rstrip()))
        self.assertFalse(envelope['synthesisReady'])
        with self.assertRaises(ValueError):
            prepare_chunks(envelope, lambda t, l: 'a', {'a': 1})

    def test_unknown_raw_vocabulary_and_empty_g2p_fail(self):
        for phonemes in ['a☃', '']:
            with self.subTest(phonemes=phonemes), self.assertRaises(ValueError):
                prepare_chunks(resolve_plan(plan_for('local')), lambda t, l: phonemes, {'a': 1})

    def test_angular_quotes_only_adapt_final_phonemes_with_trace(self):
        envelope = resolve_plan(plan_for('«local»'))
        chunks = prepare_chunks(envelope, lambda t, l: '«a»', {'a': 1, '"': 2})
        self.assertEqual(chunks[0]['rawPhonemes'], '«a»')
        self.assertEqual(chunks[0]['phonemes'], '"a"')
        self.assertEqual(chunks[0]['mappings'], [{'index': 0, 'from': '«', 'to': '"'}, {'index': 2, 'from': '»', 'to': '"'}])
        self.assertEqual(envelope['structuralPlan']['original'], '«local»')

    def test_invalid_envelope_trace_rejected(self):
        envelope = resolve_plan(plan_for('local'))
        envelope['blocks'][0]['units'][0]['source']['end'] = 100
        with self.assertRaises(ValueError):
            prepare_chunks(envelope, lambda t, l: 'a', {'a': 1})


if __name__ == '__main__':
    unittest.main()
