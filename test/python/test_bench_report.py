"""Fixture-only tests for tools/bench_report.py: no interpreters, models, GPU or network."""
import copy
import csv
import io
import json
import random
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))
import bench_report as report

NARRATION = {'es-40': 40, 'es-300': 300, 'es-700': 700, 'markdown-es': 700}


def evidence(profile):
    return {'diagnostics': [f'{m}-onnx-provider-' + ('cuda' if profile == 'gpu' else 'cpu') for m in ('lid', 'kokoro')],
            'providers': {}, 'valid_device': True}


def cold(profile, sample, rep, wall, first=False, inference=100.0):
    total_worker = wall - 60.0
    return {'kind': 'cold', 'profile': profile, 'sample': sample, 'rep': rep, 'first_ever': first, 'wall_ms': wall,
            'steps': {'interpreter_startup': 50.0, 'import_modules': 200.0, 'plan_load': 5.0, 'dll_preload_probe': 20.0,
                      'lid_load': 300.0, 'lid_inference_resolve': 40.0, 'kokoro_load': 400.0, 'phonemizer_setup': 10.0,
                      'phonemize': 30.0, 'kokoro_inference': inference, 'wav_write': 5.0, 'synthesis_overhead': 10.0,
                      'total_worker': total_worker, 'unattributed': 10.0, 'total_wall': wall},
            'audio': {'samples': 48000, 'sample_rate': 24000, 'chunks': 2, 'seconds': 2.0},
            'peak_working_set_mb': 500.0, **evidence(profile), 'notes': [],
            'crosscheck': {'harness_ms': wall - 10.0, 'gap_ms': 10.0, 'gap_pct': 100 * 10.0 / wall}}


def warm(profile, sample, inference, first_inference):
    def item(index, role, value):
        steps = {'lid_inference_resolve': 10.0, 'phonemize': 5.0, 'kokoro_inference': value, 'wav_write': 2.0,
                 'synthesis_overhead': 3.0}
        return {'index': index, 'role': role, 'steps': steps, 'total_ms': sum(steps.values()), 'samples': 48000,
                'sample_rate': 24000, **evidence(profile)}
    items = [item(0, 'first', first_inference), item(1, 'warmup', inference + 50)] + [item(2 + i, 'timed', inference) for i in range(10)]
    return {'kind': 'warm', 'profile': profile, 'sample': sample, 'rep': 1, 'wall_ms': 9000.0, 'startup_ms': 40.0,
            'wrapper_preload_ms': 0.0, 'load_steps': {'lid_load': 300.0, 'kokoro_load': 400.0}, 'iterations': items,
            'audio': {'samples': 48000, 'sample_rate': 24000, 'seconds': 2.0},
            'gpu_memory_mb': {'before': 1000, 'after': 1800} if profile == 'gpu' else None, 'peak_working_set_mb': 600.0,
            'notes': [], **evidence(profile)}


def fixture():
    samples = [{'id': i, 'lang': 'es', 'kind': 'markdown' if i.startswith('markdown') else 'prose', 'target_chars': n,
                'chars': n, 'words': n // 6, 'plan_blocks': 2, 'narration_chars': n, 'plan_outcome': 'complete'}
               for i, n in NARRATION.items()]
    records = []
    for sample, narration in NARRATION.items():
        for rep in range(1, 6):
            jitter = rep - 3  # symmetric, median stays exact
            records.append(cold('cpu', sample, rep, 1000.0 + 5 * narration + jitter))
            records.append(cold('gpu', sample, rep, 3000.0 + narration + jitter, inference=60.0))
        records.append(warm('cpu', sample, 100.0 + narration / 10, 400.0))
        records.append(warm('gpu', sample, 50.0 + narration / 40, 900.0))
    records.append(cold('gpu', 'es-300', 0, 9000.0, first=True))
    records.append(cold('cpu', 'es-300', 0, 2600.0, first=True))
    return {'schema': 1, 'tool': 'bench_runtime', 'created_utc': '2026-01-01T00:00:00+00:00', 'complete': True,
            'parameters': {'profiles': ['cpu', 'gpu'], 'cold_reps': 5, 'warm_reps': 10, 'warmup': 1, 'seed': 1,
                           'below_recommended_reps': False},
            'environment': {'os': 'Windows-test', 'cpu': 'Test CPU', 'gpu': {'name': 'Test GPU', 'driver': '1.0'},
                            'parent_python': '3.13.0',
                            'profiles': {'cpu': {'env': {'python': '3.13.15', 'onnxruntime': '1.31.0'},
                                                 'providers': {'kokoro': ['CPUExecutionProvider']}},
                                         'gpu': {'env': {'python': '3.13.15', 'onnxruntime': '1.31.0'},
                                                 'providers': {'kokoro': ['CUDAExecutionProvider', 'CPUExecutionProvider']}}}},
            'samples': samples, 'records': records,
            'failures': [{'kind': 'cold', 'profile': 'gpu', 'sample': 'es-40', 'rep': 3, 'reason': 'exit-nonzero', 'exit_code': 2}]}


class MathTests(unittest.TestCase):
    def test_speedup_is_cpu_over_gpu(self):
        self.assertEqual(report.speedup(1000.0, 500.0), 2.0)
        self.assertIsNone(report.speedup(None, 5.0))
        self.assertIsNone(report.speedup(5.0, 0.0))

    def test_linear_fit_recovers_fixed_and_variable_cost(self):
        intercept, slope, r2 = report.linear_fit([40, 300, 700], [1200.0, 2500.0, 4500.0])
        self.assertAlmostEqual(intercept, 1000.0)
        self.assertAlmostEqual(slope, 5.0)
        self.assertAlmostEqual(r2, 1.0)

    def test_fit_needs_three_distinct_points(self):
        self.assertIsNone(report.linear_fit([1, 2], [1.0, 2.0]))
        self.assertIsNone(report.linear_fit([5, 5, 5], [1.0, 2.0, 3.0]))

    def test_variance_flag(self):
        self.assertTrue(report.high_variance({'n': 5, 'mean': 100.0, 'stddev': 40.0}))
        self.assertFalse(report.high_variance({'n': 5, 'mean': 100.0, 'stddev': 5.0}))
        self.assertFalse(report.high_variance({'n': 1, 'mean': 100.0, 'stddev': None}))


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.raw = fixture()
        self.md = report.render_markdown(self.raw)

    def test_cold_total_table_shows_speedup_per_size(self):
        # es-300: cpu median 2500, gpu median 3300 -> 0.76x ; es-40: 1200 vs 3040 -> 0.39x
        row = next(line for line in self.md.splitlines() if line.startswith('| es-300 ') and '2500' in line)
        self.assertIn('3300', row)
        self.assertIn('0.76x', row)
        self.assertIn('0.39x', next(line for line in self.md.splitlines() if line.startswith('| es-40 ') and '1200' in line))

    def test_first_ever_run_is_separate_from_cold_statistics(self):
        self.assertIn('First-ever', self.md)
        self.assertIn('9000', self.md)
        stats = report.aggregate(self.raw)['cold']['gpu']['es-300']['total_wall']
        self.assertEqual(stats['n'], 5)
        self.assertEqual(stats['median'], 3300.0)

    def test_per_step_medians_and_step_speedups(self):
        self.assertIn('kokoro_inference', self.md)
        line = next(l for l in self.md.splitlines() if l.startswith('| kokoro_inference') and '1.67x' in l)
        self.assertIn('100', line)

    def test_warm_tables_and_first_inference_vs_steady_state(self):
        agg = report.aggregate(self.raw)
        steady = agg['warm']['cpu']['es-300']['kokoro_inference']
        self.assertEqual((steady['n'], steady['median']), (10, 130.0))  # first and warm-up excluded
        self.assertEqual(agg['first_inference']['cpu']['es-300']['kokoro_inference'], 400.0)
        self.assertIn('First inference vs steady state', self.md)
        self.assertIn('Warm in-process', self.md)

    def test_rtf_is_processing_seconds_per_audio_second(self):
        rtf = report.aggregate(self.raw)['rtf_cold']['cpu']['es-300']
        self.assertAlmostEqual(rtf, 2.5 / 2.0)
        self.assertIn('RTF', self.md)

    def test_fit_and_crossover_are_stated_with_limits(self):
        self.assertIn('fixed', self.md.lower())
        self.assertIn('1000', self.md)  # cpu intercept
        self.assertIn('500', self.md)  # illustrative crossover (3000-1000)/(5-1)
        self.assertIn('illustrative', self.md.lower())

    def test_high_variance_and_low_n_are_flagged(self):
        raw = fixture()
        for record, wall in zip([r for r in raw['records'] if r['kind'] == 'cold' and r['profile'] == 'gpu' and r['sample'] == 'es-40' and not r['first_ever']],
                                [800.0, 4000.0, 1500.0, 6000.0, 2500.0]):
            record['wall_ms'] = wall
            record['steps']['total_wall'] = wall
        text = report.render_markdown(raw)
        self.assertIn('high variance', text.lower())
        self.assertIn('exit-nonzero', text)
        self.assertIn('Excluded runs', text)

    def test_environment_and_failures_are_reported(self):
        for fact in ('Test CPU', 'Test GPU', 'onnxruntime', 'CUDAExecutionProvider', '1.31.0'):
            self.assertIn(fact, self.md)

    def test_reading_guide_states_numbers_not_recommendations(self):
        guide = self.md.split('## Reading guide')[1].lower()
        self.assertNotIn('recommend', guide)
        self.assertIn('lower than cpu', guide)

    def test_rendering_is_deterministic_and_order_independent(self):
        shuffled = copy.deepcopy(self.raw)
        random.Random(3).shuffle(shuffled['records'])
        self.assertEqual(report.render_markdown(shuffled), self.md)
        self.assertEqual(report.render_csv(shuffled), report.render_csv(self.raw))

    def test_no_sample_text_fields_in_output(self):
        self.assertEqual(report.find_forbidden_in_output(self.md), [])


class MeasurementRegressionTests(unittest.TestCase):
    def test_old_launcher_numeric_memory_is_not_rendered(self):
        raw = fixture()
        for record in raw['records']:
            record['peak_working_set_mb'] = 4321.123
        text = report.render_markdown(raw)
        self.assertNotIn('4321', text)
        self.assertIn('UNAVAILABLE', text)
        self.assertIn('not a workload peak', text)

    def test_production_engine_and_residual_tables_and_small_n(self):
        raw = fixture()
        for kind in ('prod', 'engine'):
            for profile in ('cpu', 'gpu'):
                raw['records'].append({'kind': kind, 'profile': profile, 'sample': 'es-40', 'rep': 1,
                                       'wall_ms': 1234.0, 'pipeline_ms': 1000.0, **evidence(profile),
                                       'devices': {'lid': profile, 'kokoro': profile}})
        raw['records'][0]['steps']['untimed_worker'] = 43.0
        text = report.render_markdown(raw)
        self.assertIn('Python production-worker wall', text)
        self.assertIn('TypeScript engine synthesis pipeline', text)
        self.assertIn('engine parent wall', text)
        self.assertIn('preliminary', text)
        self.assertIn('untimed_worker', text)
        self.assertIn('medians do not necessarily sum', text)
        csv_text = report.render_csv(raw)
        self.assertIn('prod,cpu,es-40', csv_text)
        self.assertIn('engine,gpu,es-40', csv_text)

    def test_invalid_device_run_is_excluded_from_speedup(self):
        raw = fixture()
        for record in raw['records']:
            if record['profile'] == 'gpu':
                record['valid_device'] = False
        agg = report.aggregate(raw)
        self.assertNotIn('gpu', agg['cold'])
        self.assertNotIn('gpu', agg['warm'])

    def test_legacy_provider_advertisement_cannot_replace_missing_run_evidence(self):
        raw = fixture()
        for record in raw['records']:
            record.pop('diagnostics', None)
        agg = report.aggregate(raw)
        self.assertFalse(agg['cold'])
        self.assertFalse(agg['warm'])
        text = report.render_markdown(raw)
        self.assertIn('Records excluded by device validation: 50', text)
        self.assertIn('UNAVAILABLE', text)


class CsvTests(unittest.TestCase):
    def test_shape_and_values(self):
        rows = list(csv.reader(io.StringIO(report.render_csv(fixture()))))
        self.assertEqual(rows[0], ['mode', 'profile', 'sample', 'lang', 'narration_chars', 'step', 'n', 'min_ms', 'median_ms',
                                   'mean_ms', 'p95_ms', 'stddev_ms'])
        self.assertTrue(all(len(row) == 12 for row in rows))
        match = [r for r in rows if r[:3] == ['cold', 'cpu', 'es-300'] and r[5] == 'total_wall']
        self.assertEqual(len(match), 1)
        self.assertEqual((match[0][6], float(match[0][8])), ('5', 2500.0))
        self.assertTrue(any(r[0] == 'warm' and r[5] == 'total_iteration' for r in rows))


class InputGuardTests(unittest.TestCase):
    def write(self, directory, data):
        path = Path(directory) / 'raw.json'
        path.write_text(json.dumps(data), encoding='utf-8')
        return path

    def test_rejects_text_like_fields_wrong_schema_and_incomplete_documents(self):
        with tempfile.TemporaryDirectory() as directory:
            leaked = fixture()
            leaked['samples'][0]['text'] = 'secret'
            with self.assertRaises(ValueError):
                report.load_raw(self.write(directory, leaked))
            plan = fixture()
            plan['records'][0]['plan'] = {}
            with self.assertRaises(ValueError):
                report.load_raw(self.write(directory, plan))
            wrong = fixture()
            wrong['schema'] = 2
            with self.assertRaises(ValueError):
                report.load_raw(self.write(directory, wrong))
            with self.assertRaises(ValueError):
                report.load_raw(self.write(directory, {'schema': 1}))
            self.assertEqual(report.load_raw(self.write(directory, fixture()))['schema'], 1)

    def test_main_writes_markdown_and_csv_from_raw_json(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = self.write(directory, fixture())
            md, table = Path(directory) / 'r.md', Path(directory) / 'r.csv'
            self.assertEqual(report.main(['--raw', str(raw), '--md', str(md), '--csv', str(table)]), 0)
            self.assertIn('# CPU vs GPU runtime benchmark report', md.read_text(encoding='utf-8'))
            self.assertTrue(table.read_text(encoding='utf-8').startswith('mode,profile'))
            self.assertNotIn('\r', md.read_text(encoding='utf-8'))

    def test_empty_results_render_without_crashing(self):
        raw = fixture()
        raw['records'] = []
        self.assertIn('No successful runs', report.render_markdown(raw))


if __name__ == '__main__':
    unittest.main()
