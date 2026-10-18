"""Mock-only tests for tools/bench_runtime.py: no interpreters, models, GPU, network or audio."""
import contextlib
import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))
import bench_runtime as bench

APPROVED = Path(os.environ.get('LOCALAPPDATA', tempfile.gettempdir())) / 'Temp' / 'opencode'
PROD_WRAPPER = ("import sys,runpy,pathlib;script=sys.argv[1];sys.argv=sys.argv[1:];sys.path.insert(0,str(pathlib.Path(script).parent));"
                "import gpu_runtime_probe as p;p.prepare_worker();p.preload_for_worker(None);runpy.run_path(script,run_name='__main__')")


class FakeClock:
    def __init__(self):
        self.now = 1_000_000_000

    def __call__(self):
        return self.now

    def advance(self, ms):
        self.now += int(ms * 1_000_000)


class FakeKokoro:
    def __init__(self, clock):
        self.clock = clock
        self.tokenizer = SimpleNamespace(vocab={'a': 1})
        self.calls = 0

    def create(self, *args, **kwargs):
        self.calls += 1
        self.clock.advance(30)
        return [0.0] * 2400, 24000


def make_seams(clock, with_load=True, kokoro=None):
    kokoro = kokoro or FakeKokoro(clock)
    order = []
    soundfile = SimpleNamespace(write=lambda *a, **k: (clock.advance(5), order.append('raw-write')))
    original_write = soundfile.write

    class Detector:
        device_diagnostics = ['lid-onnx-provider-cpu']

        def _load(self):
            order.append('lid-load')
            clock.advance(100)

    class DetectorNoLoad:
        device_diagnostics = ['lid-onnx-provider-cpu']

    def step(name, ms, result=None):
        def run(*args, **kwargs):
            order.append(name)
            clock.advance(ms)
            return result
        return run

    def synthesize(resolved, kokoro_, voice, speed, out, phonemize, tone_voice='', tone_weight=0.0):
        for _ in range(2):
            phonemize('hola', 'es')
            kokoro_.create('x', voice=voice)
        clock.advance(7)  # chunk preparation and concatenation
        seams.soundfile.write(out, [0.0], 24000)
        return {'chunks': [1, 2], 'sampleRate': 24000, 'samples': 4800, 'voice': voice}

    seams = SimpleNamespace(
        parse_args=None, soundfile=soundfile, original_write=original_write, order=order, kokoro=kokoro,
        import_modules=step('imports', 50),
        load_plan=step('plan', 10, {'outcome': 'complete', 'blocks': []}),
        probe_runtime=step('probe', 20, 'candidate'),
        build_detector=lambda *a, **k: (order.append('build'), clock.advance(5), Detector() if with_load else DetectorNoLoad())[2],
        resolve_plan=step('resolve', 40, {'diagnostics': [{'code': 'x-code'}]}),
        load_kokoro=lambda *a, **k: (order.append('kokoro-load'), clock.advance(200), (kokoro, 'kokoro-onnx-provider-cpu'))[2],
        raw_phonemizer=lambda *a, **k: (order.append('phonemizer'), clock.advance(3),
                                         (lambda text, lang: (order.append('phonemize'), clock.advance(2), 'h')[2]))[2],
        synthesize_envelope=synthesize,
        collect_env=lambda detector, kokoro_: {'python': '3.13.0', 'onnxruntime': '1.31.0'},
        providers=lambda detector, kokoro_: {'kokoro': ['CPUExecutionProvider'], 'lid': ['CPUExecutionProvider']},
        gpu_memory=lambda: None,
    )
    return seams


def worker_args(**over):
    base = dict(voice='em_blocktype', speed=1.0, out='x.wav', model='m', voices='v', lang='es', app_home='h',
                lid_manifest='man', lid_backend='onnx', lid_dir='d', tone_voice='', tone_weight=0.0)
    base.update(over)
    return SimpleNamespace(**base)


class StatisticsTests(unittest.TestCase):
    def test_empty_single_and_pair(self):
        empty = bench.summarize([])
        self.assertEqual(empty['n'], 0)
        self.assertIsNone(empty['median'])
        one = bench.summarize([5.0])
        self.assertEqual((one['n'], one['min'], one['median'], one['mean'], one['p95']), (1, 5.0, 5.0, 5.0, 5.0))
        self.assertIsNone(one['stddev'])
        two = bench.summarize([1.0, 3.0])
        self.assertEqual((two['median'], two['mean']), (2.0, 2.0))
        self.assertAlmostEqual(two['stddev'], 2 ** 0.5)

    def test_known_series(self):
        stats = bench.summarize([float(v) for v in range(1, 11)])
        self.assertEqual((stats['min'], stats['median'], stats['mean']), (1.0, 5.5, 5.5))
        self.assertAlmostEqual(stats['p95'], 9.55)
        self.assertAlmostEqual(stats['stddev'], 3.0276503541)

    def test_ignores_none_values(self):
        self.assertEqual(bench.summarize([None, 2.0, None])['n'], 1)


class TimerTests(unittest.TestCase):
    def test_steps_keep_order_and_accumulate(self):
        clock = FakeClock()
        timer = bench.StepTimer(clock)
        with timer.step('a'):
            clock.advance(10)
        with timer.step('b'):
            clock.advance(5)
        with timer.step('a'):
            clock.advance(2.5)
        self.assertEqual(list(timer.steps), ['a', 'b'])
        self.assertAlmostEqual(timer.steps['a'], 12.5)

    def test_step_is_recorded_when_body_raises(self):
        clock = FakeClock()
        timer = bench.StepTimer(clock)
        with self.assertRaises(RuntimeError):
            with timer.step('boom'):
                clock.advance(4)
                raise RuntimeError('x')
        self.assertAlmostEqual(timer.steps['boom'], 4)


class SynthesisSeamTests(unittest.TestCase):
    def test_phonemize_inference_write_and_overhead_are_separated_and_patches_restored(self):
        clock = FakeClock()
        seams = make_seams(clock)
        original_create = seams.kokoro.create
        original_write = seams.soundfile.write
        base = seams.raw_phonemizer(seams.kokoro, 'en-us')
        info, steps, notes = bench.timed_synthesis(seams, clock, {}, seams.kokoro, base, 'v', 1.0, 'o.wav')
        self.assertAlmostEqual(steps['phonemize'], 4)
        self.assertAlmostEqual(steps['kokoro_inference'], 60)
        self.assertAlmostEqual(steps['wav_write'], 5)
        self.assertAlmostEqual(steps['synthesis_overhead'], 7)
        self.assertEqual(notes, [])
        self.assertEqual(info['samples'], 4800)
        self.assertEqual(seams.kokoro.create.__func__, original_create.__func__)
        self.assertNotIn('create', vars(seams.kokoro))
        self.assertIs(seams.soundfile.write, original_write)

    def test_inseparable_inference_is_merged_and_stated(self):
        clock = FakeClock()

        class Frozen(FakeKokoro):
            __slots__ = ()

        class Locked:
            __slots__ = ('tokenizer', 'clock')

            def __init__(self):
                self.tokenizer = SimpleNamespace(vocab={})
                self.clock = clock

            def create(self, *a, **k):
                clock.advance(30)
                return [0.0], 24000

        seams = make_seams(clock, kokoro=Locked())
        base = seams.raw_phonemizer(seams.kokoro, 'en-us')
        _, steps, notes = bench.timed_synthesis(seams, clock, {}, seams.kokoro, base, 'v', 1.0, 'o.wav')
        self.assertNotIn('kokoro_inference', steps)
        self.assertIn('kokoro_inference_merged_into_synthesis_overhead', notes)
        self.assertAlmostEqual(steps['synthesis_overhead'], 67)


class PipelineTests(unittest.TestCase):
    def test_cold_step_order_total_and_no_text(self):
        clock = FakeClock()
        seams = make_seams(clock)
        payload = bench.run_cold_pipeline(seams, worker_args(), stdin=None, clock=clock, wrapper_preload_ms=12.0)
        self.assertEqual(seams.order[:8], ['imports', 'plan', 'probe', 'build', 'lid-load', 'resolve', 'kokoro-load',
                                           'phonemizer'])
        self.assertEqual(list(payload['steps']), [
            'import_modules', 'plan_load', 'dll_preload_probe', 'lid_load', 'lid_inference_resolve', 'kokoro_load',
            'phonemizer_setup', 'phonemize', 'kokoro_inference', 'wav_write', 'synthesis_overhead'])
        self.assertAlmostEqual(payload['steps']['dll_preload_probe'], 32.0)  # wrapper preload + probe_runtime
        self.assertAlmostEqual(payload['steps']['lid_load'], 105)
        self.assertAlmostEqual(payload['steps']['lid_inference_resolve'], 40)
        self.assertEqual(payload['audio'], {'samples': 4800, 'sample_rate': 24000, 'chunks': 2})
        self.assertEqual(payload['diagnostics'], ['kokoro-onnx-provider-cpu', 'lid-onnx-provider-cpu', 'x-code'])
        self.assertEqual(payload['wrapper_preload_ms'], 12.0)
        parts = sum(v for k, v in payload['steps'].items() if k != 'dll_preload_probe') + 20
        self.assertLessEqual(parts, payload['total_worker_ms'] + 1e-6)
        self.assertEqual(bench.find_forbidden(payload), [])

    def test_detector_without_load_seam_is_merged_honestly(self):
        clock = FakeClock()
        seams = make_seams(clock, with_load=False)
        payload = bench.run_cold_pipeline(seams, worker_args(), stdin=None, clock=clock, wrapper_preload_ms=0)
        self.assertIn('lid_load_merged_into_lid_inference_resolve', payload['notes'])
        self.assertAlmostEqual(payload['steps']['lid_load'], 5)

    def test_warm_roles_and_single_load(self):
        clock = FakeClock()
        seams = make_seams(clock)
        payload = bench.run_warm_pipeline(seams, worker_args(), stdin=None, clock=clock, wrapper_preload_ms=0,
                                          iterations=3, warmup=2)
        roles = [item['role'] for item in payload['iterations']]
        self.assertEqual(roles, ['first', 'warmup', 'warmup', 'timed', 'timed', 'timed'])
        self.assertEqual(seams.order.count('kokoro-load'), 1)
        self.assertEqual(seams.order.count('lid-load'), 1)
        self.assertEqual(seams.order.count('resolve'), 6)
        item = payload['iterations'][-1]
        self.assertEqual(list(item['steps']), ['lid_inference_resolve', 'phonemize', 'kokoro_inference', 'wav_write',
                                                'synthesis_overhead'])
        self.assertAlmostEqual(item['total_ms'], 40 + 4 + 60 + 5 + 7, places=3)

    def test_warm_with_zero_warmup_still_separates_first_inference(self):
        clock = FakeClock()
        payload = bench.run_warm_pipeline(make_seams(clock), worker_args(), None, clock, 0, iterations=2, warmup=0)
        self.assertEqual([i['role'] for i in payload['iterations']], ['first', 'timed', 'timed'])


class ScheduleTests(unittest.TestCase):
    def schedule(self, seed=7, **over):
        kw = dict(profiles=['cpu', 'gpu'], cell_ids=['es-40', 'en-40', 'es-120'], cold_reps=3, prod_reps=1,
                  warm=True, seed=seed, first_cell='es-120')
        kw.update(over)
        return bench.build_schedule(**kw)

    def test_deterministic_for_same_seed_and_different_for_other_seed(self):
        self.assertEqual(self.schedule(), self.schedule())
        self.assertNotEqual(self.schedule(seed=7), self.schedule(seed=8))

    def test_counts_first_ever_and_interleaving(self):
        jobs = self.schedule()
        cold = [j for j in jobs if j['kind'] == 'cold' and not j['first_ever']]
        self.assertEqual(len(cold), 2 * 3 * 3)
        firsts = [j for j in jobs if j['first_ever']]
        self.assertEqual(sorted(j['profile'] for j in firsts), ['cpu', 'gpu'])
        self.assertTrue(all(j['cell'] == 'es-120' for j in firsts))
        self.assertTrue(all(jobs[i]['first_ever'] for i in range(2)))
        # profiles of the same cell and repetition are adjacent, so drift hits both
        for index in range(2, 2 + len(cold), 2):
            pair = jobs[index:index + 2]
            self.assertEqual({j['cell'] for j in pair}, {pair[0]['cell']})
            self.assertEqual({j['rep'] for j in pair}, {pair[0]['rep']})
            self.assertEqual({j['profile'] for j in pair}, {'cpu', 'gpu'})
        self.assertEqual(len([j for j in jobs if j['kind'] == 'warm']), 6)
        self.assertEqual(len([j for j in jobs if j['kind'] == 'prod']), 6)

    def test_single_profile_and_no_warm(self):
        jobs = self.schedule(profiles=['gpu'], warm=False, prod_reps=0)
        self.assertEqual({j['profile'] for j in jobs}, {'gpu'})
        self.assertEqual({j['kind'] for j in jobs}, {'cold'})


class CommandTests(unittest.TestCase):
    paths = dict(home=Path('C:/h/open-vox'), repo=Path('C:/repo'), model=Path('C:/h/m.onnx'), voices=Path('C:/h/v.bin'),
                 lid_dir=Path('C:/h/lid'), lid_manifest=Path('C:/repo/resources/lid.json'))

    def cell(self):
        return {'id': 'es-40', 'lang': 'es'}

    def test_gpu_worker_uses_isolated_utf8_wrapper_and_explicit_interpreter(self):
        argv = bench.worker_command('gpu', Path('C:/py/gpu/python.exe'), self.cell(), 'cold', self.paths, 'o.wav', 'm.json',
                                    voice='em_blocktype', speed=1.0)
        self.assertEqual(argv[:6], ['C:\\py\\gpu\\python.exe', '-I', '-B', '-X', 'utf8', '-c'])
        wrapper = argv[6]
        self.assertIn('p.prepare_worker();p.preload_for_worker(None)', wrapper)
        self.assertIn('runpy.run_path(script', wrapper)
        self.assertIn(repr(str(Path('C:/repo/scripts'))), wrapper)
        self.assertTrue(argv[7].endswith('bench_runtime.py'))
        self.assertIn('--worker', argv)
        self.assertEqual(argv[argv.index('--mode') + 1], 'cold')
        self.assertEqual(argv[argv.index('--lid-backend') + 1], 'onnx')
        self.assertEqual(argv[argv.index('--lang') + 1], 'es')
        self.assertIn('--plan-json', argv)

    def test_cpu_worker_is_plain_python_script(self):
        argv = bench.worker_command('cpu', Path('C:/py/cpu/python.exe'), self.cell(), 'cold', self.paths, 'o.wav', 'm.json',
                                    voice='em_blocktype', speed=1.0)
        self.assertEqual(argv[0], 'C:\\py\\cpu\\python.exe')
        self.assertTrue(argv[1].endswith('bench_runtime.py'))
        for flag in ('-I', '-B', '-X', '-c'):
            self.assertNotIn(flag, argv[:2])

    def test_english_voice_maps_to_en_us(self):
        argv = bench.worker_command('cpu', Path('p'), {'id': 'en-40', 'lang': 'en'}, 'cold', self.paths, 'o.wav', 'm.json',
                                    voice='af_heart', speed=1.0)
        self.assertEqual(argv[argv.index('--lang') + 1], 'en-us')

    def test_production_command_is_the_unmodified_script_with_the_exact_wrapper(self):
        gpu = bench.production_command('gpu', Path('C:/py/gpu/python.exe'), self.cell(), self.paths, 'o.wav',
                                       voice='em_blocktype', speed=1.0)
        self.assertEqual(gpu[1:6], ['-I', '-B', '-X', 'utf8', '-c'])
        self.assertEqual(gpu[6], PROD_WRAPPER)
        self.assertTrue(gpu[7].endswith('kokoro_say.py'))
        cpu = bench.production_command('cpu', Path('C:/py/cpu/python.exe'), self.cell(), self.paths, 'o.wav',
                                       voice='em_blocktype', speed=1.0)
        self.assertTrue(cpu[1].endswith('kokoro_say.py'))

    def test_bench_wrapper_only_adds_timing_and_scripts_path(self):
        wrapper = bench.bench_wrapper('C:\\repo\\scripts')
        self.assertIn('init_globals=', wrapper)
        for fragment in ('p.prepare_worker();p.preload_for_worker(None)', "run_name='__main__'", 'script=sys.argv[1]'):
            self.assertIn(fragment, wrapper)
        self.assertIn(fragment, PROD_WRAPPER)


class SafetyTests(unittest.TestCase):
    def setUp(self):
        APPROVED.mkdir(parents=True, exist_ok=True)

    def test_rejects_relative_dotdot_outside_root_root_itself_and_existing(self):
        with tempfile.TemporaryDirectory(dir=APPROVED) as directory:
            root = Path(directory)
            for bad in (Path('relative'), root / '..' / 'escape', root.parent / 'elsewhere', root, root / 'a' / '..' / 'b'):
                with self.assertRaises(ValueError, msg=str(bad)):
                    bench.validated_output_path(bad, root)
            (root / 'exists').mkdir()
            with self.assertRaises(ValueError):
                bench.validated_output_path(root / 'exists', root)
            self.assertEqual(bench.validated_output_path(root / 'fresh', root), root / 'fresh')

    def test_rejects_symlink_or_junction_in_chain(self):
        with tempfile.TemporaryDirectory(dir=APPROVED) as directory:
            root = Path(directory)
            (root / 'link').mkdir()
            with patch.object(bench, 'is_link', side_effect=lambda p: Path(p) == root / 'link'):
                with self.assertRaises(ValueError):
                    bench.validated_output_path(root / 'link' / 'run', root)

    def test_child_environment_redirects_temp_and_leaves_parent_untouched(self):
        before = dict(os.environ)
        env = bench.child_env(Path('C:/scratch/tmp'), base={'PATH': 'x', 'TEMP': 'old'})
        self.assertEqual(env['TEMP'], 'C:\\scratch\\tmp')
        self.assertEqual(env['TMP'], 'C:\\scratch\\tmp')
        self.assertEqual(env['PYTHONUTF8'], '1')
        self.assertEqual(env['HF_HUB_OFFLINE'], '1')
        self.assertEqual(env['PATH'], 'x')
        self.assertEqual(dict(os.environ), before)


class TextAndMatrixTests(unittest.TestCase):
    def test_text_is_deterministic_accented_and_near_target(self):
        for lang in ('es', 'en'):
            for size in (40, 120, 300, 700, 1500):
                text = bench.generate_text(lang, size, seed=3)
                self.assertEqual(text, bench.generate_text(lang, size, seed=3))
                self.assertLessEqual(len(text), size)
                self.assertGreaterEqual(len(text), size * 0.8 if size > 40 else 20)
        joined = ' '.join(bench.generate_text('es', 1500, seed=3) for _ in range(1))
        self.assertTrue(any(word in joined for word in ('canción', 'año', 'está', 'configuración')))

    def test_matrix_has_each_cell_and_one_markdown_sample(self):
        cells = bench.build_matrix(['es', 'en'], [40, 120], seed=1)
        ids = [c['id'] for c in cells]
        self.assertEqual(ids, ['es-40', 'es-120', 'en-40', 'en-120', 'markdown-es'])
        markdown = cells[-1]
        self.assertTrue(any(mark in markdown['text'] for mark in ('# ', '```', '**')))
        self.assertEqual(markdown['kind'], 'markdown')


class NoTextTests(unittest.TestCase):
    def test_forbidden_fields_and_long_strings_are_found(self):
        self.assertEqual(bench.find_forbidden({'a': [{'b': 1}]}), [])
        self.assertTrue(bench.find_forbidden({'text': 'x'}))
        self.assertTrue(bench.find_forbidden({'x': [{'original': 'y'}]}))
        self.assertTrue(bench.find_forbidden({'plan': {}}))
        self.assertTrue(bench.find_forbidden({'ok': 'z' * 500}))
        with self.assertRaises(ValueError):
            bench.assert_no_text({'nested': {'content': 'x'}})


def fake_plan_builder(text, lang):
    return {'blocks': [{}] * 2, 'narrationLength': len(text) - 1, 'outcome': 'complete', 'original': text}


class FakeRunner:
    """Replaces subprocess execution: writes the metrics a worker would write."""

    def __init__(self, fail_exit=None, drop_metrics=False, timeout=False):
        self.calls = []
        self.fail_exit = fail_exit or set()
        self.drop_metrics = drop_metrics
        self.timeout = timeout

    def __call__(self, argv, stdin, env, timeout, cwd=None):
        self.calls.append(SimpleNamespace(argv=list(argv), stdin=stdin, env=env))
        if self.timeout:
            return bench.ProcResult(None, float(timeout) * 1000, b'', None, timed_out=True)
        engine = argv[:2] == ['bun', '-e']
        gpu = env.get('OPEN_VOX_BENCH_PROFILE') == 'cuda13' if engine else 'gpu' in argv[0]
        codes = [f'{m}-onnx-provider-' + ('cuda' if gpu else 'cpu') for m in ('kokoro', 'lid')]
        providers = {m: ['CUDAExecutionProvider', 'CPUExecutionProvider'] if gpu else ['CPUExecutionProvider']
                     for m in ('kokoro', 'lid')}
        steps = {name: 10.0 for name in bench.WORKER_STEPS}
        steps['dll_preload_probe'] = 30.0 if gpu else 5.0
        steps['kokoro_inference'] = 100.0 if gpu else 200.0
        mode = 'engine' if engine else argv[argv.index('--mode') + 1] if '--mode' in argv else 'prod'
        if mode == 'cold' and not self.drop_metrics:
            out = Path(argv[argv.index('--metrics-out') + 1])
            total = sum(steps.values()) + 3
            out.write_text(json.dumps({
                'schema': 1, 'mode': 'cold', 'startup_ms': 50.0, 'wrapper_preload_ms': 25.0 if gpu else 0.0, 'steps': steps,
                'total_worker_ms': total, 'audio': {'samples': 48000, 'sample_rate': 24000, 'chunks': 2},
                'diagnostics': codes, 'providers': providers,
                'env': {'python': '3.13.15', 'onnxruntime': '1.31.0', 'distribution': 'onnxruntime-gpu' if gpu else 'onnxruntime'},
                'notes': []}), encoding='utf-8')
            wall = 50.0 + 25.0 * gpu + total + 8.0
        elif mode == 'warm' and not self.drop_metrics:
            out = Path(argv[argv.index('--metrics-out') + 1])
            count = int(argv[argv.index('--iterations') + 1]) + int(argv[argv.index('--warmup') + 1]) + 1
            roles = ['first'] + ['warmup'] * int(argv[argv.index('--warmup') + 1]) + ['timed'] * int(argv[argv.index('--iterations') + 1])
            items = [{'index': i, 'role': roles[i], 'steps': {'lid_inference_resolve': 5.0, 'phonemize': 2.0,
                                                               'kokoro_inference': 50.0 if gpu else 90.0, 'wav_write': 1.0,
                                                               'synthesis_overhead': 1.0},
                      'total_ms': 59.0 if gpu else 99.0, 'samples': 48000, 'sample_rate': 24000,
                      'diagnostics': codes, 'providers': providers} for i in range(count)]
            out.write_text(json.dumps({'schema': 1, 'mode': 'warm', 'startup_ms': 40.0, 'wrapper_preload_ms': 0.0,
                                       'load_steps': {'lid_load': 100.0, 'kokoro_load': 300.0}, 'iterations': items,
                                       'gpu_memory_mb': {'before': 100, 'after': 900} if gpu else None, 'providers': {},
                                       'env': {'python': '3.13.15'}, 'notes': []}), encoding='utf-8')
            wall = 5000.0
        else:
            wall = 4000.0
        output = {'diagnostics': codes, 'providers': providers}
        if engine:
            output.update(pipeline_ms=3500.0, devices={m: 'gpu' if gpu else 'cpu' for m in ('lid', 'kokoro')})
        return bench.ProcResult(self.fail_exit_for(argv), wall, json.dumps(output).encode(), 321.5)

    def fail_exit_for(self, argv):
        return 2 if any(token in ' '.join(argv) for token in self.fail_exit) else 0


class RunBenchmarkTests(unittest.TestCase):
    def setUp(self):
        APPROVED.mkdir(parents=True, exist_ok=True)

    def options(self, out, *extra):
        return bench.parse_args(['--out', str(out), '--sizes', '40,120', '--langs', 'es,en', '--cold-reps', '2',
                                 '--warm-reps', '3', '--warmup', '1', '--prod-reps', '1', '--seed', '5', *extra])

    def run_bench(self, runner, *extra):
        with tempfile.TemporaryDirectory(dir=APPROVED) as directory:
            root = Path(directory)
            out = root / 'run'
            before = dict(os.environ)
            with contextlib.redirect_stdout(io.StringIO()):
                raw = bench.run_benchmark(self.options(out, *extra), runner=runner, plan_builder=fake_plan_builder,
                                          root=root, preflight=lambda paths: None, gather_env=lambda: {'os': 'test'})
            self.assertEqual(dict(os.environ), before)
            leftovers = sorted(p.name for p in out.rglob('*') if p.is_file())
            return raw, leftovers

    def test_records_steps_crosscheck_and_cleanup(self):
        runner = FakeRunner()
        raw, leftovers = self.run_bench(runner)
        self.assertEqual(raw['schema'], 1)
        cold = [r for r in raw['records'] if r['kind'] == 'cold']
        self.assertEqual(len(cold), 2 * 5 * 2 + 2)  # 5 cells (4 prose + markdown), 2 profiles, 2 reps, + first-ever
        record = cold[-1]
        self.assertAlmostEqual(record['steps']['interpreter_startup'], 50.0)
        self.assertEqual(list(record['steps'])[:2], ['interpreter_startup', 'import_modules'])
        self.assertEqual(list(record['steps'])[-3:], ['total_worker', 'unattributed', 'total_wall'])
        harness = record['crosscheck']['harness_ms']
        self.assertAlmostEqual(record['crosscheck']['gap_ms'], record['steps']['total_wall'] - harness)
        self.assertAlmostEqual(record['audio']['seconds'], 2.0)
        self.assertIsNone(record['peak_working_set_mb'])
        self.assertEqual(sorted(r['profile'] for r in cold if r['first_ever']), ['cpu', 'gpu'])
        self.assertEqual(len([r for r in raw['records'] if r['kind'] == 'warm']), 2 * 5)
        self.assertEqual(len([r for r in raw['records'] if r['kind'] == 'prod']), 2 * 5)
        self.assertEqual(leftovers, ['results.json'])  # wav, metrics and plans removed
        self.assertEqual(raw['failures'], [])
        self.assertEqual(set(raw['environment']['profiles']), {'cpu', 'gpu'})

    def test_no_text_in_raw_or_runner_arguments_and_samples_have_counts_only(self):
        runner = FakeRunner()
        raw, _ = self.run_bench(runner)
        dumped = json.dumps(raw, ensure_ascii=False)
        for cell in bench.build_matrix(['es', 'en'], [40, 120], seed=5):
            self.assertNotIn(cell['text'][:25], dumped)
        self.assertEqual(bench.find_forbidden(raw), [])
        sample = raw['samples'][0]
        self.assertEqual(set(sample), {'id', 'lang', 'kind', 'target_chars', 'chars', 'words', 'plan_blocks',
                                       'narration_chars', 'plan_outcome'})
        for call in runner.calls:
            self.assertFalse(any('canci' in a for a in call.argv))
            self.assertTrue(call.env['TEMP'].startswith(str(APPROVED)))

    def test_nonzero_exit_missing_metrics_and_timeout_are_excluded_and_reported(self):
        raw, _ = self.run_bench(FakeRunner(fail_exit={'pn-onnx-gpu'}))
        self.assertTrue(raw['failures'])
        self.assertTrue(all(f['profile'] == 'gpu' for f in raw['failures']))
        self.assertTrue(all(f['reason'] == 'exit-nonzero' for f in raw['failures']))
        self.assertFalse([r for r in raw['records'] if r['profile'] == 'gpu' and r['kind'] == 'cold'])
        raw, _ = self.run_bench(FakeRunner(drop_metrics=True))
        self.assertIn('missing-metrics', {f['reason'] for f in raw['failures'] if f['kind'] == 'cold'})
        raw, _ = self.run_bench(FakeRunner(timeout=True))
        self.assertEqual({f['reason'] for f in raw['failures']}, {'timeout'})

    def test_keep_flag_preserves_bounded_artifacts(self):
        with tempfile.TemporaryDirectory(dir=APPROVED) as directory:
            root = Path(directory)
            out = root / 'run'
            runner = FakeRunner()
            with contextlib.redirect_stdout(io.StringIO()):
                bench.run_benchmark(self.options(out, '--keep'), runner=runner, plan_builder=fake_plan_builder, root=root,
                                    preflight=lambda paths: None, gather_env=lambda: {})
            self.assertTrue((out / 'plans' / 'es-40.json').exists())
            self.assertTrue((out / 'results.json').exists())


class CliTests(unittest.TestCase):
    def test_dry_run_prints_matrix_and_commands_and_spawns_nothing(self):
        buffer = io.StringIO()
        APPROVED.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=APPROVED) as directory:
            out = Path(directory) / 'never-created'
            with patch.object(subprocess, 'Popen', side_effect=AssertionError('spawned')), \
                    patch.object(subprocess, 'run', side_effect=AssertionError('spawned')), \
                    contextlib.redirect_stdout(buffer):
                code = bench.main(['--dry-run', '--out', str(out), '--sizes', '40,120', '--cold-reps', '5'])
            self.assertEqual(code, 0)
            self.assertFalse(out.exists())
        text = buffer.getvalue()
        self.assertIn('es-40', text)
        self.assertIn('markdown-es', text)
        self.assertIn('pn-onnx-gpu-venv', text)
        self.assertIn('-X utf8', text)
        self.assertIn('pn-onnx-venv', text)
        self.assertIn('cold jobs', text)
        self.assertNotIn('canción', text)

    def test_invalid_profile_is_rejected(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            bench.parse_args(['--profiles', 'tpu', '--out', 'x'])

    def test_worker_error_writes_class_name_only(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'm.json'
            bench.write_worker_error(target, ValueError('secret text must not leak'))
            data = json.loads(target.read_text(encoding='utf-8'))
            self.assertEqual(data, {'schema': 1, 'error': 'ValueError'})


class MeasurementRegressionTests(unittest.TestCase):
    setUp = RunBenchmarkTests.setUp
    options = RunBenchmarkTests.options
    run_bench = RunBenchmarkTests.run_bench
    def test_launcher_memory_is_unavailable_even_if_runner_returns_a_number(self):
        raw, _ = self.run_bench(FakeRunner())
        for record in raw['records']:
            self.assertIsNone(record.get('peak_working_set_mb'))
            self.assertEqual(record['memory_unavailable_reason'], 'venv_launcher_not_inference_process')

    def test_each_success_and_warm_iteration_retains_actual_device_evidence(self):
        raw, _ = self.run_bench(FakeRunner())
        self.assertTrue(raw['records'])
        for record in raw['records']:
            self.assertTrue(bench.devices_match(record['profile'], record['diagnostics']))
            self.assertIn('providers', record)
            for item in record.get('iterations', []):
                self.assertTrue(bench.devices_match(record['profile'], item['diagnostics']))

    def test_exclusive_cold_steps_reconcile_including_worker_residual(self):
        raw, _ = self.run_bench(FakeRunner())
        for record in raw['records']:
            if record['kind'] == 'cold':
                steps = record['steps']
                self.assertIn('untimed_worker', steps)
                self.assertAlmostEqual(sum(v for k, v in steps.items() if k not in ('total_worker', 'total_wall')),
                                       record['wall_ms'])

    def test_missing_wrong_or_ambiguous_devices_are_rejected(self):
        for codes in ([], ['kokoro-onnx-provider-cpu'],
                      ['kokoro-onnx-provider-cpu', 'lid-onnx-provider-cuda'],
                      ['kokoro-onnx-provider-cpu', 'kokoro-onnx-provider-cuda', 'lid-onnx-provider-cpu']):
            self.assertFalse(bench.devices_match('cpu', codes))
        self.assertTrue(bench.devices_match('gpu', ['kokoro-onnx-provider-cuda', 'lid-onnx-provider-cuda']))

    def test_engine_jobs_cli_and_safe_inline_command(self):
        args = bench.parse_args(['--out', 'x'])
        self.assertEqual(args.engine_reps, 1)
        jobs = bench.build_schedule(['cpu', 'gpu'], ['es-40'], 1, 1, False, 7, 'es-40', engine_reps=2)
        self.assertEqual(len([j for j in jobs if j['kind'] == 'engine']), 4)
        argv, env = bench.engine_command('gpu', CommandTests.paths, Path('C:/scratch/o.wav'), {})
        self.assertEqual(argv[:2], ['bun', '-e'])
        self.assertIn('defaultKokoroEngine', argv[2])
        self.assertIn('synthesizePlan', argv[2])
        self.assertIn('handle.devices()', argv[2])
        for forbidden in ('writeConfig', 'writeFile', 'speakPlan', 'SoundPlayer', 'createConfigReader'):
            self.assertNotIn(forbidden, argv[2])
        self.assertEqual(env['OPEN_VOX_BENCH_PROFILE'], 'cuda13')

    def test_engine_inline_executes_with_mock_modules_only_and_suppresses_errors(self):
        mock_engine = '''
export function defaultKokoroEngine(env, getConfig, diagnostic) {
  if (Object.keys(env).join() !== "OPEN_VOX_HOME") throw Error("unsafe env");
  const c = getConfig();
  if (c.runtimeProfile !== "cuda13" || c.narrationBackend !== "onnx" || c.speed !== 1
      || c.voices.es !== "em_blocktype" || c.voices.en !== "af_heart"
      || c.toneWeight.es !== 0) throw Error("wrong settings");
  c.voices.es = "changed";
  if (getConfig().voices.es !== "em_blocktype") throw Error("mutated settings");
  return { synthesizePlan(plan, wav) {
    if (plan.marker !== "año" || wav !== "mock-only.wav") throw Error("wrong input");
    diagnostic("lid-onnx-provider-cuda"); diagnostic("kokoro-onnx-provider-cuda");
    return { exited: Promise.resolve(0), devices: () => ({ lid: "gpu", kokoro: "gpu" }) };
  } };
}'''
        env = bench.child_env(APPROVED)
        data_module = lambda source: 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()
        env.update(OPEN_VOX_BENCH_ENGINE=data_module(mock_engine),
                   OPEN_VOX_BENCH_CONFIG=data_module('export const DEFAULT_CONFIG = {};'),
                   OPEN_VOX_BENCH_PROFILE='cuda13', OPEN_VOX_BENCH_HOME='mock-home',
                   OPEN_VOX_BENCH_WAV='mock-only.wav')
        done = subprocess.run(['bun', '-e', bench.ENGINE_SCRIPT], input=json.dumps({'marker': 'año'}).encode(),
                              capture_output=True, env=env, cwd=bench.REPO, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr.decode())
        value = json.loads(done.stdout)
        self.assertEqual(value['devices'], {'lid': 'gpu', 'kokoro': 'gpu'})
        self.assertTrue(bench.devices_match('gpu', value['diagnostics']))
        self.assertGreaterEqual(value['pipeline_ms'], 0)
        self.assertNotIn('año', done.stdout.decode())
        env['OPEN_VOX_BENCH_ENGINE'] = data_module('throw Error("secret prose")')
        failed = subprocess.run(['bun', '-e', bench.ENGINE_SCRIPT], input=b'{}', capture_output=True,
                                env=env, cwd=bench.REPO, timeout=30)
        self.assertEqual(failed.returncode, 2)
        self.assertEqual((failed.stdout, failed.stderr), (b'', b''))

    def test_later_invalid_evidence_remains_auditable_but_is_excluded(self):
        class BadRunner(FakeRunner):
            def __call__(self, argv, stdin, env, timeout, cwd=None):
                result = super().__call__(argv, stdin, env, timeout, cwd)
                if '--metrics-out' in argv:
                    path = Path(argv[argv.index('--metrics-out') + 1])
                    data = json.loads(path.read_text(encoding='utf-8'))
                    if data['mode'] == 'warm':
                        # Only the last timed iteration is bad; first successes cannot mask it.
                        data['iterations'][-1]['diagnostics'] = ['kokoro-onnx-provider-cpu']
                    elif len(self.calls) > 2:
                        data['diagnostics'] = []
                    path.write_text(json.dumps(data), encoding='utf-8')
                else:
                    value = json.loads(result.stdout)
                    value['diagnostics'] = ['kokoro-onnx-provider-cpu', 'lid-onnx-provider-cpu']
                    result.stdout = json.dumps(value).encode()
                return result
        raw, _ = self.run_bench(BadRunner())
        invalid = [r for r in raw['records'] if not r['valid_device']]
        self.assertEqual({r['kind'] for r in invalid}, {'cold', 'warm', 'prod', 'engine'})
        self.assertEqual(len(invalid), len(raw['failures']))
        self.assertEqual({f['reason'] for f in raw['failures']}, {'invalid-device-evidence'})
        import bench_report
        agg = bench_report.aggregate(raw)
        self.assertFalse(agg['cold'])
        self.assertFalse(agg['warm'])
        self.assertNotIn('gpu', agg['prod'])
        self.assertNotIn('gpu', agg['engine'])

    def test_residuals_keep_negative_accounting_defects_visible(self):
        job = {'profile': 'cpu', 'cell': 'es-40', 'rep': 1, 'first_ever': False}
        metrics = {'startup_ms': 10, 'wrapper_preload_ms': 0, 'total_worker_ms': 20,
                   'steps': {'import_modules': 30}, 'diagnostics': [],
                   'audio': {'samples': 10, 'sample_rate': 10}}
        record = bench._cold_record(job, bench.ProcResult(0, 29, b'', None), metrics)
        self.assertEqual(record['steps']['untimed_worker'], -10)
        self.assertEqual(record['steps']['unattributed'], -1)

    def test_engine_count_default_and_explicit_skip_are_predictable(self):
        runner = FakeRunner()
        raw, _ = self.run_bench(runner)
        self.assertEqual(len([r for r in raw['records'] if r['kind'] == 'engine']), 10)
        raw, _ = self.run_bench(FakeRunner(), '--engine-reps', '0')
        self.assertFalse([r for r in raw['records'] if r['kind'] == 'engine'])

    def test_engine_handle_devices_must_agree_with_diagnostics(self):
        record = {'kind': 'engine', 'profile': 'gpu',
                  'diagnostics': ['lid-onnx-provider-cuda', 'kokoro-onnx-provider-cuda']}
        self.assertFalse(bench.record_devices_match(record))
        record['devices'] = {'lid': 'gpu', 'kokoro': 'cpu'}
        self.assertFalse(bench.record_devices_match(record))
        record['devices']['kokoro'] = 'gpu'
        self.assertTrue(bench.record_devices_match(record))

    def test_peak_query_does_not_inspect_launcher_handle(self):
        class Launcher:
            @property
            def _handle(self):
                raise AssertionError('launcher handle is not inference memory')
        self.assertIsNone(bench.peak_working_set_mb(Launcher()))


class GpuMemoryTests(unittest.TestCase):
    def test_parses_single_query_value(self):
        run = lambda *a, **k: SimpleNamespace(returncode=0, stdout='1234\n')
        self.assertEqual(bench.query_gpu_memory_mb(run=run, which=lambda name: 'nvidia-smi'), 1234)

    def test_missing_tool_or_failure_is_silent(self):
        self.assertIsNone(bench.query_gpu_memory_mb(which=lambda name: None))
        def broken(*a, **k):
            raise OSError('x')
        self.assertIsNone(bench.query_gpu_memory_mb(run=broken, which=lambda name: 'nvidia-smi'))


if __name__ == '__main__':
    unittest.main()
