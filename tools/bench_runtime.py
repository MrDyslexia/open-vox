"""Per-step CPU vs GPU narration benchmark (planned path: LID + Kokoro). Synthetic text only; NEVER plays audio.

Parent mode (any Python): builds authentic plans through the TypeScript planner, spawns one worker per job with an
explicitly chosen interpreter, and stores aggregate-only raw JSON (schema 1). Text is never written to results.
Worker mode (`--worker`, runs inside the venv interpreters): imports the production functions, times each step with
perf_counter, still writes the WAV, and writes ONE JSON document of step timings to --metrics-out.

It never changes runtimeProfile or any persistent configuration, never installs or downloads anything.
"""
import time
_T0 = (time.perf_counter_ns(), time.time_ns())  # worker anchor: first statement of the script

import argparse
import contextlib
import dataclasses
import datetime
import json
import math
import os
import platform
import random
import shutil
import statistics
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

SCHEMA = 1
REPO = Path(__file__).resolve().parents[1]
PROFILES = ('cpu', 'gpu')
VENVS = {'cpu': 'pn-onnx-venv', 'gpu': 'pn-onnx-gpu-venv'}
DEFAULT_VOICES = {'es': 'em_blocktype', 'en': 'af_heart'}
LANG_CODES = {'es': 'es', 'en': 'en-us'}
LID_DIR_REL = Path('lid-onnx') / 'codeswitch-spaeng-lid-lince' / '66d0e899b3fcf70d8727e4521c7a9c3f7a1fa73c-onnx-fp32-a322d9809cd3'
LID_MANIFEST_REL = Path('resources') / 'lid-model-onnx-fp32.json'
# Steps measured inside the worker, in execution order. dll_preload_probe = GPU wrapper preload + probe_runtime.
WORKER_STEPS = ('import_modules', 'plan_load', 'dll_preload_probe', 'lid_load', 'lid_inference_resolve', 'kokoro_load',
                'phonemizer_setup', 'phonemize', 'kokoro_inference', 'wav_write', 'synthesis_overhead')
FORBIDDEN_KEYS = frozenset({'text', 'original', 'plan', 'content', 'body', 'markdown', 'narration', 'plan_content', 'prompt'})
MAX_STRING = 400
MEMORY_UNAVAILABLE = 'venv_launcher_not_inference_process'
PROD_WRAPPER = ("import sys,runpy,pathlib;script=sys.argv[1];sys.argv=sys.argv[1:];sys.path.insert(0,str(pathlib.Path(script).parent));"
                "import gpu_runtime_probe as p;p.prepare_worker();p.preload_for_worker(None);runpy.run_path(script,run_name='__main__')")
BUN_SCRIPT = ("const m = await import(process.env.OPEN_VOX_BENCH_MODULE);"
              "const t = await Bun.stdin.text();"
              "process.stdout.write(JSON.stringify(m.createNarrationPlan(t, process.env.OPEN_VOX_BENCH_LANG)));")
ENGINE_SCRIPT = """
try {
  const { defaultKokoroEngine } = await import(process.env.OPEN_VOX_BENCH_ENGINE);
  const { DEFAULT_CONFIG } = await import(process.env.OPEN_VOX_BENCH_CONFIG);
  const plan = JSON.parse(await Bun.stdin.text());
  const config = { ...structuredClone(DEFAULT_CONFIG), narrationBackend: "onnx",
    runtimeProfile: process.env.OPEN_VOX_BENCH_PROFILE,
    voices: { es: "em_blocktype", en: "af_heart" }, speed: 1,
    toneVoice: { es: "", en: "" }, toneWeight: { es: 0, en: 0 } };
  const diagnostics = [];
  const start = performance.now();
  const engine = defaultKokoroEngine({ OPEN_VOX_HOME: process.env.OPEN_VOX_BENCH_HOME },
    () => structuredClone(config), code => diagnostics.push(code));
  if (!engine?.synthesizePlan) throw new Error();
  const handle = engine.synthesizePlan(plan, process.env.OPEN_VOX_BENCH_WAV);
  const code = await handle.exited;
  const pipeline_ms = performance.now() - start;
  const devices = handle.devices();
  if (code !== 0) throw new Error();
  process.stdout.write(JSON.stringify({ pipeline_ms, devices, diagnostics }));
} catch { process.exitCode = 2; }
"""


# ---------------------------------------------------------------- statistics and timers

def summarize(values):
    """n/min/median/mean/p95/stddev; p95 uses linear interpolation; stddev is the sample deviation (None if n<2)."""
    data = sorted(float(v) for v in values if v is not None)
    n = len(data)
    if not n:
        return {'n': 0, 'min': None, 'median': None, 'mean': None, 'p95': None, 'stddev': None}
    position = 0.95 * (n - 1)
    low = int(math.floor(position))
    high = min(low + 1, n - 1)
    p95 = data[low] + (data[high] - data[low]) * (position - low)
    return {'n': n, 'min': data[0], 'median': statistics.median(data), 'mean': statistics.fmean(data), 'p95': p95,
            'stddev': statistics.stdev(data) if n > 1 else None}


class StepTimer:
    """Accumulating millisecond timer with injectable nanosecond clock; keeps first-insertion order."""

    def __init__(self, clock=time.perf_counter_ns):
        self.clock = clock
        self.steps = {}

    def add(self, name, ms):
        self.steps[name] = self.steps.get(name, 0.0) + ms

    @contextlib.contextmanager
    def step(self, name):
        start = self.clock()
        try:
            yield
        finally:
            self.add(name, (self.clock() - start) / 1e6)


def timed_synthesis(seams, clock, resolved, kokoro, phonemize, voice, speed, out, tone_voice='', tone_weight=0.0):
    """Run the production synthesize_envelope and split phonemize / Kokoro inference / WAV write by wrapping the
    callables it uses. Returns (info, steps, notes). synthesis_overhead is everything else inside the call
    (phoneme adaptation, chunk packing, style fetch, concatenation). Patches are always restored."""
    acc = {'phonemize': 0.0, 'kokoro_inference': 0.0, 'wav_write': 0.0}
    notes = []

    def timed(name, function):
        def wrapper(*args, **kwargs):
            start = clock()
            try:
                return function(*args, **kwargs)
            finally:
                acc[name] += (clock() - start) / 1e6
        return wrapper

    had_own = 'create' in getattr(kokoro, '__dict__', {})
    original_create = kokoro.create
    patched = False
    try:
        kokoro.create = timed('kokoro_inference', original_create)
        patched = True
    except (AttributeError, TypeError):
        notes.append('kokoro_inference_merged_into_synthesis_overhead')
    soundfile = seams.soundfile
    original_write = soundfile.write
    soundfile.write = timed('wav_write', original_write)
    start = clock()
    try:
        info = seams.synthesize_envelope(resolved, kokoro, voice, speed, out, timed('phonemize', phonemize),
                                         tone_voice=tone_voice, tone_weight=tone_weight)
    finally:
        total = (clock() - start) / 1e6
        soundfile.write = original_write
        if patched:
            if had_own:
                kokoro.create = original_create
            else:
                del kokoro.create
    steps = {'phonemize': acc['phonemize']}
    if patched:
        steps['kokoro_inference'] = acc['kokoro_inference']
    steps['wav_write'] = acc['wav_write']
    steps['synthesis_overhead'] = total - sum(steps.values())
    return info, steps, notes


# ---------------------------------------------------------------- worker pipelines (mirror kokoro_say.main)

def _load_stage(seams, args, stdin, timer, notes, wrapper_preload_ms):
    with timer.step('import_modules'):
        seams.import_modules()
    with timer.step('plan_load'):
        plan = seams.load_plan(stdin)
    with timer.step('dll_preload_probe'):
        candidate = seams.probe_runtime(include_torch=False)
    timer.add('dll_preload_probe', wrapper_preload_ms)
    with timer.step('lid_load'):
        detector = seams.build_detector(args.lid_backend, args.lid_dir, args.app_home, args.lid_manifest, candidate)
        load = getattr(detector, '_load', None)  # the exact call detect() makes first; idempotent
        if callable(load):
            load()
        else:
            notes.append('lid_load_merged_into_lid_inference_resolve')
    return plan, candidate, detector


def _english(args):
    return args.lang if args.lang in ('en-us', 'en-gb') else 'en-us'


def run_cold_pipeline(seams, args, stdin, clock, wrapper_preload_ms, start_ns=None):
    start = clock() if start_ns is None else start_ns
    timer = StepTimer(clock)
    notes = []
    plan, candidate, detector = _load_stage(seams, args, stdin, timer, notes, wrapper_preload_ms)
    with timer.step('lid_inference_resolve'):
        resolved = seams.resolve_plan(plan, detector)
    with timer.step('kokoro_load'):
        kokoro, device = seams.load_kokoro(args.model, args.voices, candidate)
    with timer.step('phonemizer_setup'):
        phonemize = seams.raw_phonemizer(kokoro, _english(args))
    info, steps, synth_notes = timed_synthesis(seams, clock, resolved, kokoro, phonemize, args.voice, args.speed, args.out,
                                               tone_voice=args.tone_voice, tone_weight=args.tone_weight)
    for name, ms in steps.items():
        timer.add(name, ms)
    total = (clock() - start) / 1e6
    codes = sorted({d['code'] for d in resolved['diagnostics']} | {device} | set(getattr(detector, 'device_diagnostics', [])))
    if plan['outcome'] != 'complete':
        codes.append('narration-truncated')
    return {'schema': SCHEMA, 'mode': 'cold', 'wrapper_preload_ms': wrapper_preload_ms, 'steps': dict(timer.steps),
            'total_worker_ms': total, 'audio': _audio(info), 'diagnostics': codes,
            'providers': seams.providers(detector, kokoro), 'env': seams.collect_env(detector, kokoro),
            'notes': notes + synth_notes}


def _audio(info):
    return {'samples': int(info['samples']), 'sample_rate': int(info['sampleRate']), 'chunks': len(info['chunks'])}


def run_warm_pipeline(seams, args, stdin, clock, wrapper_preload_ms, iterations, warmup):
    """Load once, then 1 first-inference + `warmup` discarded + `iterations` timed in-process iterations."""
    timer = StepTimer(clock)
    notes = []
    memory_before = seams.gpu_memory()
    plan, candidate, detector = _load_stage(seams, args, stdin, timer, notes, wrapper_preload_ms)
    with timer.step('kokoro_load'):
        kokoro, device = seams.load_kokoro(args.model, args.voices, candidate)
    with timer.step('phonemizer_setup'):
        phonemize = seams.raw_phonemizer(kokoro, _english(args))
    roles = ['first'] + ['warmup'] * warmup + ['timed'] * iterations
    items = []
    for index, role in enumerate(roles):
        inner = StepTimer(clock)
        begin = clock()
        with inner.step('lid_inference_resolve'):
            resolved = seams.resolve_plan(plan, detector)
        info, steps, synth_notes = timed_synthesis(seams, clock, resolved, kokoro, phonemize, args.voice, args.speed,
                                                   args.out, tone_voice=args.tone_voice, tone_weight=args.tone_weight)
        total = (clock() - begin) / 1e6
        for note in synth_notes:
            if note not in notes:
                notes.append(note)
        audio = _audio(info)
        items.append({'index': index, 'role': role, 'steps': {**inner.steps, **steps}, 'total_ms': total,
                      'samples': audio['samples'], 'sample_rate': audio['sample_rate'],
                      'diagnostics': sorted({d['code'] for d in resolved['diagnostics']} | {device}
                                            | set(getattr(detector, 'device_diagnostics', []))),
                      'providers': seams.providers(detector, kokoro)})
    memory_after = seams.gpu_memory()
    return {'schema': SCHEMA, 'mode': 'warm', 'wrapper_preload_ms': wrapper_preload_ms, 'load_steps': dict(timer.steps),
            'iterations': items,
            'gpu_memory_mb': None if memory_before is None or memory_after is None else {'before': memory_before, 'after': memory_after},
            'providers': seams.providers(detector, kokoro), 'env': seams.collect_env(detector, kokoro), 'notes': notes}


def query_gpu_memory_mb(run=subprocess.run, which=shutil.which):
    """One nvidia-smi query; silently None when the tool is missing or fails."""
    executable = which('nvidia-smi')
    if not executable:
        return None
    try:
        result = run([executable, '--query-gpu=memory.used', '--format=csv,noheader,nounits'], capture_output=True,
                     text=True, timeout=10, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode != 0:
            return None
        return int(result.stdout.strip().splitlines()[0])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


class ProductionSeams:
    """Imports and exposes the exact production callables. Only constructed inside venv interpreters."""

    def __init__(self, scripts_dir):
        self.scripts_dir = str(scripts_dir)

    def import_modules(self):
        if self.scripts_dir not in sys.path:
            sys.path.insert(0, self.scripts_dir)
        import soundfile
        import kokoro_say  # top-level imports kokoro_onnx / onnxruntime exactly like the real worker
        for key in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY', 'HF_HUB_DISABLE_PROGRESS_BARS',
                    'DO_NOT_TRACK'):
            os.environ[key] = '1'
        os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN'] = '1'
        os.environ['HF_TOKEN'] = ''
        os.environ['HUGGING_FACE_HUB_TOKEN'] = ''
        from narration_resolver import resolve_plan
        from narration_synthesis import load_plan, raw_phonemizer, synthesize_envelope
        from runtime_device import probe_runtime
        self.soundfile = soundfile
        self.build_detector = kokoro_say.build_detector
        self.load_kokoro_fn = kokoro_say.load_kokoro
        self.resolve_plan = resolve_plan
        self.load_plan = load_plan
        self.raw_phonemizer = raw_phonemizer
        self.synthesize_envelope = synthesize_envelope
        self.probe_runtime = probe_runtime

    def load_kokoro(self, model, voices, candidate):
        return self.load_kokoro_fn(model, voices, candidate)

    def providers(self, detector, kokoro):
        found = {}
        try:
            found['kokoro'] = list(kokoro.sess.get_providers())
        except Exception:
            pass
        try:
            found['lid'] = list(detector._runtime[2].get_providers())
        except Exception:
            pass
        return found

    def collect_env(self, detector, kokoro):
        import importlib.metadata as metadata
        import onnxruntime
        versions = {}
        for name in ('onnxruntime', 'onnxruntime-gpu'):
            try:
                versions[name] = metadata.version(name)
            except metadata.PackageNotFoundError:
                pass
        return {'python': platform.python_version(), 'venv': Path(sys.prefix).name, 'onnxruntime': onnxruntime.__version__,
                'distributions': versions, 'available_providers': list(onnxruntime.get_available_providers())}

    def gpu_memory(self):
        return query_gpu_memory_mb()


def worker_parser():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--mode', choices=('cold', 'warm'), required=True)
    parser.add_argument('--metrics-out', required=True)
    parser.add_argument('--spawn-ns', type=int, required=True)
    parser.add_argument('--iterations', type=int, default=10)
    parser.add_argument('--warmup', type=int, default=2)
    for flag in ('--model', '--voices', '--voice', '--lang', '--out'):
        parser.add_argument(flag, required=True)
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--plan-json', action='store_true')
    parser.add_argument('--app-home')
    parser.add_argument('--lid-manifest')
    parser.add_argument('--lid-backend', default='onnx')
    parser.add_argument('--lid-dir')
    parser.add_argument('--tone-voice', default='')
    parser.add_argument('--tone-weight', type=float, default=0.0)
    return parser


def write_worker_error(path, error):
    """Class name only: third-party messages may carry prose."""
    Path(path).write_text(json.dumps({'schema': SCHEMA, 'error': type(error).__name__}), encoding='utf-8')


def worker_main(argv):
    args = worker_parser().parse_args(argv)
    try:
        if args.lid_backend != 'onnx' or not args.plan_json:
            raise ValueError('bench-supports-planned-onnx-only')
        wrapper = globals().get('BENCH_WRAPPER')
        if wrapper:
            began, ended, first_wall = wrapper
            preload_ms = (ended - began) / 1e6
        else:
            preload_ms, first_wall = 0.0, _T0[1]
        seams = ProductionSeams(Path(__file__).resolve().parents[1] / 'scripts')
        if args.mode == 'cold':
            payload = run_cold_pipeline(seams, args, sys.stdin, time.perf_counter_ns, preload_ms, start_ns=_T0[0])
        else:
            payload = run_warm_pipeline(seams, args, sys.stdin, time.perf_counter_ns, preload_ms, args.iterations, args.warmup)
        payload['startup_ms'] = (first_wall - args.spawn_ns) / 1e6
        Path(args.metrics_out).write_text(json.dumps(payload), encoding='utf-8')
        json.dump({'diagnostics': payload.get('diagnostics', [])}, sys.stdout)
        return 0
    except Exception as error:
        write_worker_error(args.metrics_out, error)
        sys.stderr.write('Narration synthesis failed\n')
        return 2


# ---------------------------------------------------------------- commands

def bench_wrapper(scripts_dir):
    """Production GPU wrapper plus timing anchors; scripts_dir replaces the script's own folder on sys.path."""
    return ("import time;_a=time.perf_counter_ns();_w=time.time_ns();"
            "import sys,runpy,pathlib;script=sys.argv[1];sys.argv=sys.argv[1:];"
            f"sys.path.insert(0,{str(scripts_dir)!r});"
            "import gpu_runtime_probe as p;p.prepare_worker();p.preload_for_worker(None);"
            "_b=time.perf_counter_ns();"
            "runpy.run_path(script,run_name='__main__',init_globals={'BENCH_WRAPPER':(_a,_b,_w)})")


def _planned_args(cell, paths, wav, voice, speed):
    return ['--model', str(paths['model']), '--voices', str(paths['voices']), '--voice', voice,
            '--lang', LANG_CODES[cell['lang']], '--speed', str(speed), '--out', str(wav), '--plan-json',
            '--app-home', str(paths['home']), '--lid-manifest', str(paths['lid_manifest']),
            '--lid-backend', 'onnx', '--lid-dir', str(paths['lid_dir'])]


def worker_command(profile, interpreter, cell, mode, paths, wav, metrics, voice, speed, iterations=10, warmup=2):
    script = Path(paths['repo']) / 'tools' / 'bench_runtime.py'
    prefix = [str(interpreter)]
    if profile == 'gpu':
        prefix += ['-I', '-B', '-X', 'utf8', '-c', bench_wrapper(Path(paths['repo']) / 'scripts')]
    extra = ['--iterations', str(iterations), '--warmup', str(warmup)] if mode == 'warm' else []
    return [*prefix, str(script), '--worker', '--mode', mode, '--metrics-out', str(metrics), *extra,
            *_planned_args(cell, paths, wav, voice, speed), '--spawn-ns', '0']


def production_command(profile, interpreter, cell, paths, wav, voice, speed):
    script = Path(paths['repo']) / 'scripts' / 'kokoro_say.py'
    prefix = [str(interpreter)]
    if profile == 'gpu':
        prefix += ['-I', '-B', '-X', 'utf8', '-c', PROD_WRAPPER]
    return [*prefix, str(script), *_planned_args(cell, paths, wav, voice, speed)]


def engine_command(profile, paths, wav, env):
    """Real default engine; injected settings only, synthesis-only, same stdin plan as Python jobs."""
    repo = Path(paths['repo']).resolve()
    return ['bun', '-e', ENGINE_SCRIPT], {**env,
        'OPEN_VOX_BENCH_ENGINE': (repo / 'src' / 'kokoro-engine.ts').as_uri(),
        'OPEN_VOX_BENCH_CONFIG': (repo / 'src' / 'config.ts').as_uri(),
        'OPEN_VOX_BENCH_PROFILE': 'cuda13' if profile == 'gpu' else 'cpu',
        'OPEN_VOX_BENCH_HOME': str(paths['home']), 'OPEN_VOX_BENCH_WAV': str(wav)}


def resolve_paths(home, repo=REPO):
    home = Path(home)
    return {'home': home, 'repo': Path(repo), 'model': home / 'kokoro' / 'kokoro-v1.0.onnx',
            'voices': home / 'kokoro' / 'voices-v1.0.bin', 'lid_dir': home / LID_DIR_REL,
            'lid_manifest': Path(repo) / LID_MANIFEST_REL,
            'interpreters': {p: home / VENVS[p] / 'Scripts' / 'python.exe' for p in PROFILES}}


def preflight_items(paths, profiles=PROFILES):
    items = [(f'interpreter-{p}', paths['interpreters'][p], True) for p in profiles]
    items += [('kokoro-model', paths['model'], True), ('kokoro-voices', paths['voices'], True),
              ('lid-model-dir', paths['lid_dir'], True), ('lid-manifest', paths['lid_manifest'], True),
              ('production-script', Path(paths['repo']) / 'scripts' / 'kokoro_say.py', True)]
    return items


def preflight_check(paths, profiles=PROFILES):
    missing = [name for name, path, _ in preflight_items(paths, profiles) if not Path(path).exists()]
    if not shutil.which('bun'):
        missing.append('bun')
    if missing:
        raise RuntimeError('preflight-missing: ' + ', '.join(missing))


# ---------------------------------------------------------------- safety

def approved_root():
    return Path(os.environ['LOCALAPPDATA']) / 'Temp' / 'opencode'


def is_link(path):
    path = Path(path)
    return path.is_symlink() or bool(getattr(path, 'is_junction', lambda: False)())


def validated_output_path(out, root=None, require_new=True):
    """Absolute, no '..', strictly inside the approved scratch root, no symlink/junction in the chain."""
    out = Path(out)
    root = Path(root) if root is not None else approved_root()
    if not out.is_absolute() or '..' in out.parts or '..' in root.parts:
        raise ValueError('invalid-output-path')
    if not root.is_dir():
        raise ValueError('missing-scratch-root')
    try:
        relative = out.resolve().relative_to(root.resolve())
    except ValueError:
        raise ValueError('output-outside-scratch-root') from None
    if str(relative) == '.':
        raise ValueError('output-is-scratch-root')
    for parent in (out, *out.parents):
        if parent.exists() and is_link(parent):
            raise ValueError('output-through-link')
    if require_new and out.exists():
        raise ValueError('output-exists')
    return out


def child_env(tmp, base=None):
    """Production worker environment plus TEMP/TMP inside the scratch dir. Never mutates os.environ."""
    env = dict(os.environ if base is None else base)
    env.update({'TEMP': str(tmp), 'TMP': str(tmp), 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8',
                'PYTHONDONTWRITEBYTECODE': '1', 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
                'HF_HUB_DISABLE_TELEMETRY': '1', 'HF_HUB_DISABLE_PROGRESS_BARS': '1', 'DO_NOT_TRACK': '1',
                'HF_HUB_DISABLE_IMPLICIT_TOKEN': '1', 'HF_TOKEN': '', 'HUGGING_FACE_HUB_TOKEN': '', 'PYTHONNOUSERSITE': '1'})
    return env


def find_forbidden(value, path=''):
    """Paths of fields that could carry text: forbidden key names or oversized strings."""
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            here = f'{path}/{key}'
            if str(key).lower() in FORBIDDEN_KEYS:
                found.append(here)
            found += find_forbidden(item, here)
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            found += find_forbidden(item, f'{path}[{index}]')
    elif isinstance(value, str) and len(value) > MAX_STRING:
        found.append(path + ' (long string)')
    return found


def assert_no_text(value):
    found = find_forbidden(value)
    if found:
        raise ValueError('refusing-to-persist-text-fields: ' + ', '.join(found[:5]))


# ---------------------------------------------------------------- synthetic input

SENTENCES = {
    'es': ['La configuración del año está lista.', 'Esta canción suena mejor en la mañana.',
           'El café está caliente y la lección empieza pronto.', 'Mañana revisaremos la información con calma.',
           'Está claro que la descripción necesita más atención.', 'El niño miró la ventana y cantó una canción.',
           'La versión nueva incluye una corrección pequeña.', 'Después de la reunión, escribimos la explicación final.',
           'Hoy el sistema responde con rapidez y sin errores.', 'Nadie sabía cuántos años tenía la antigua estación.',
           'La opción más cómoda está en el menú de configuración.', 'Aquí termina la prueba, gracias por su paciencia.'],
    'en': ['The configuration for this year is ready.', 'This song sounds better in the morning.',
           'The café is warm and the lesson starts soon.', 'Tomorrow we will review the information carefully.',
           'It is clear that the description needs more attention.', 'The child looked out the window and sang a song.',
           'The new version includes one small correction.', 'After the meeting, we wrote the final explanation.',
           'Today the system responds quickly and without errors.', 'Nobody knew how old the naïve old station was.',
           'The most convenient option is in the settings menu.', 'The test ends here, thank you for your patience.'],
}
MARKDOWN = {
    'es': ('# Informe de configuración\n\nLa **canción** del año está en la lista:\n\n'
           '- Primer punto con `codigo_inline` y un [enlace](https://example.invalid/ruta)\n'
           '- Segundo punto: configuración básica\n- Tercer punto, año nuevo\n\n'
           '> Nota: esta cita está en un bloque aparte.\n\n| Columna | Valor |\n|---|---|\n| uno | 1 |\n| dos | 2 |\n\n'
           '```python\nprint("hola")\n```\n\n## Resumen\n\n'),
    'en': ('# Configuration report\n\nThe **song** of the year is on the list:\n\n'
           '- First point with `inline_code` and a [link](https://example.invalid/path)\n'
           '- Second point: basic configuration\n- Third point, new year\n\n'
           '> Note: this quote sits in a separate block.\n\n| Column | Value |\n|---|---|\n| one | 1 |\n| two | 2 |\n\n'
           '```python\nprint("hello")\n```\n\n## Summary\n\n'),
}


def generate_text(lang, target, seed):
    bank = SENTENCES[lang]
    rng = random.Random(f'{seed}:{lang}:{target}')
    order, parts, length, count = [], [], 0, 0
    while length < target:
        if not order:
            order = list(range(len(bank)))
            rng.shuffle(order)
        sentence = bank[order.pop()]
        separator = '' if not parts else ('\n\n' if count % 3 == 0 else ' ')
        parts.append(separator + sentence)
        length += len(separator) + len(sentence)
        count += 1
    text = ''.join(parts)
    if len(text) > target:
        cut = text[:target]
        end = cut.rfind('.')
        if end + 1 >= max(20, int(target * 0.8)):
            text = cut[:end + 1]
        else:
            text = cut[:cut.rfind(' ')].rstrip(' ,;:') + '.'
    return text.strip()


def build_matrix(langs, sizes, seed):
    cells = [{'id': f'{lang}-{size}', 'lang': lang, 'kind': 'prose', 'target': size, 'text': generate_text(lang, size, seed)}
             for lang in langs for size in sizes]
    lang = 'es' if 'es' in langs else langs[0]
    head = MARKDOWN[lang]
    cells.append({'id': f'markdown-{lang}', 'lang': lang, 'kind': 'markdown', 'target': 700,
                  'text': head + generate_text(lang, max(40, 700 - len(head)), seed)})
    return cells


# ---------------------------------------------------------------- scheduling

def build_schedule(profiles, cell_ids, cold_reps, prod_reps, warm, seed, first_cell, engine_reps=0):
    """Seeded and interleaved: profiles of one (cell, repetition) are adjacent so drift hits both equally."""
    rng = random.Random(seed)
    jobs = []

    def job(kind, profile, cell, rep, first=False):
        return {'kind': kind, 'profile': profile, 'cell': cell, 'rep': rep, 'first_ever': first}

    def rounds(kind, reps):
        for rep in range(1, reps + 1):
            cells = list(cell_ids)
            rng.shuffle(cells)
            for cell in cells:
                order = list(profiles)
                rng.shuffle(order)
                jobs.extend(job(kind, p, cell, rep) for p in order)

    if cold_reps > 0:
        order = list(profiles)
        rng.shuffle(order)
        jobs.extend(job('cold', p, first_cell, 0, True) for p in order)
        rounds('cold', cold_reps)
    rounds('prod', prod_reps)
    rounds('engine', engine_reps)
    if warm:
        cells = list(cell_ids)
        rng.shuffle(cells)
        for cell in cells:
            order = list(profiles)
            rng.shuffle(order)
            jobs.extend(job('warm', p, cell, 1) for p in order)
    return jobs


# ---------------------------------------------------------------- process execution

@dataclasses.dataclass
class ProcResult:
    exit_code: object
    wall_ms: float
    stdout: bytes
    peak_mb: object
    timed_out: bool = False


def peak_working_set_mb(proc):
    """Unavailable: Windows venv launchers are not the inference process. Do not misattribute their peak."""
    return None


def default_runner(argv, stdin, env, timeout, cwd=None):
    start = time.perf_counter_ns()
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
                            cwd=cwd, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try:
        output, _ = proc.communicate(stdin, timeout=timeout)
        timed_out = False
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        output, timed_out = b'', True
    wall = (time.perf_counter_ns() - start) / 1e6
    return ProcResult(None if timed_out else proc.returncode, wall, (output or b'')[:8192],
                      None if timed_out else peak_working_set_mb(proc), timed_out)


def bun_plan_builder(repo=REPO, run=subprocess.run):
    module = (Path(repo) / 'src' / 'markdown-narration.ts').as_uri()

    def build(text, lang):
        env = {**os.environ, 'OPEN_VOX_BENCH_MODULE': module, 'OPEN_VOX_BENCH_LANG': lang}
        result = run(['bun', '-e', BUN_SCRIPT], input=text.encode('utf-8'), capture_output=True, env=env, cwd=str(repo),
                     timeout=60)
        if result.returncode != 0:
            raise RuntimeError('plan-generation-failed')
        return json.loads(result.stdout.decode('utf-8'))
    return build


def _first_line(command):
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=10,
                              creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        return done.stdout.strip().splitlines()[0] if done.returncode == 0 and done.stdout.strip() else None
    except (OSError, subprocess.SubprocessError, IndexError):
        return None


def gather_environment():
    cpu = None
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'HARDWARE\DESCRIPTION\System\CentralProcessor\0') as key:
            cpu = winreg.QueryValueEx(key, 'ProcessorNameString')[0].strip()
    except Exception:
        pass
    gpu = None
    smi = shutil.which('nvidia-smi')
    if smi:
        line = _first_line([smi, '--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'])
        if line:
            parts = [p.strip() for p in line.split(',')]
            gpu = {'name': parts[0], 'driver': parts[1] if len(parts) > 1 else None,
                   'memory_total_mb': parts[2] if len(parts) > 2 else None}
    return {'os': platform.platform(), 'cpu': cpu, 'cpu_threads': os.cpu_count(), 'gpu': gpu,
            'parent_python': platform.python_version(), 'bun': _first_line(['bun', '--version'])}


# ---------------------------------------------------------------- orchestration

def _failure(job, reason, result=None, error_class=None):
    entry = {'kind': job['kind'], 'profile': job['profile'], 'sample': job['cell'], 'rep': job['rep'], 'reason': reason,
             'exit_code': None if result is None else result.exit_code}
    if error_class:
        entry['error_class'] = error_class
    return entry


def _read_metrics(path):
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return None, 'missing-metrics', None
    except (OSError, ValueError):
        return None, 'invalid-metrics', None
    if not isinstance(data, dict) or data.get('schema') != SCHEMA:
        return None, 'invalid-metrics', None
    if 'error' in data:
        return None, 'worker-error', str(data['error'])[:80]
    if find_forbidden(data):
        return None, 'invalid-metrics', None
    return data, None, None


def _cold_record(job, result, metrics):
    steps = {'interpreter_startup': metrics['startup_ms']}
    for name in WORKER_STEPS:
        if name in metrics['steps']:
            steps[name] = metrics['steps'][name]
    harness = metrics['startup_ms'] + metrics['wrapper_preload_ms'] + metrics['total_worker_ms']
    gap = result.wall_ms - harness
    worker_sum = sum(metrics['steps'].values()) - metrics['wrapper_preload_ms']
    # Signed residuals expose accounting defects; do not clamp away real gaps or overlap.
    steps['untimed_worker'] = metrics['total_worker_ms'] - worker_sum
    step_sum = sum(v for v in steps.values() if v is not None)
    steps.update({'total_worker': metrics['total_worker_ms'], 'unattributed': gap, 'total_wall': result.wall_ms})
    audio = metrics['audio']
    return {'kind': 'cold', 'profile': job['profile'], 'sample': job['cell'], 'rep': job['rep'], 'first_ever': job['first_ever'],
            'wall_ms': result.wall_ms, 'steps': steps,
            'audio': {**audio, 'seconds': audio['samples'] / audio['sample_rate']},
            'peak_working_set_mb': None, 'diagnostics': metrics['diagnostics'], 'notes': metrics.get('notes', []),
            'crosscheck': {'harness_ms': harness, 'gap_ms': gap, 'gap_pct': (100 * gap / result.wall_ms) if result.wall_ms else None,
                           'step_sum_ms': step_sum, 'worker_untimed_ms': metrics['total_worker_ms'] - worker_sum}}


def _warm_record(job, result, metrics, expected):
    items = metrics.get('iterations')
    if not isinstance(items, list) or len(items) != expected:
        return None
    first = items[0]
    return {'kind': 'warm', 'profile': job['profile'], 'sample': job['cell'], 'rep': job['rep'], 'wall_ms': result.wall_ms,
            'startup_ms': metrics['startup_ms'], 'wrapper_preload_ms': metrics['wrapper_preload_ms'],
            'load_steps': metrics['load_steps'], 'iterations': items,
            'audio': {'samples': first['samples'], 'sample_rate': first['sample_rate'],
                      'seconds': first['samples'] / first['sample_rate']},
            'gpu_memory_mb': metrics.get('gpu_memory_mb'), 'peak_working_set_mb': None,
            'notes': metrics.get('notes', [])}


def execute_job(job, ctx):
    """Returns (record, failure, worker_info)."""
    args, cell = ctx.args, ctx.cells[job['cell']]
    stem = f"{job['kind']}-{job['profile']}-{job['cell']}-{job['rep']}"
    wav, metrics_path = ctx.out / 'wav' / f'{stem}.wav', ctx.out / 'metrics' / f'{stem}.json'
    interpreter = ctx.paths['interpreters'][job['profile']]
    voice = DEFAULT_VOICES[cell['lang']]
    timeout = args.timeout
    env = ctx.env
    if job['kind'] == 'engine':
        argv, env = engine_command(job['profile'], ctx.paths, wav, env)
    elif job['kind'] == 'prod':
        argv = production_command(job['profile'], interpreter, cell, ctx.paths, wav, voice, 1.0)
    else:
        mode = job['kind']
        argv = worker_command(job['profile'], interpreter, cell, mode, ctx.paths, wav, metrics_path, voice, 1.0,
                              iterations=args.warm_reps, warmup=args.warmup)
        if mode == 'warm':
            timeout = args.timeout * 3
        argv[argv.index('--spawn-ns') + 1] = str(time.time_ns())
    try:
        result = ctx.runner(argv, ctx.plan_bytes[job['cell']], env, timeout)
        if result.timed_out:
            return None, _failure(job, 'timeout', result), None
        if result.exit_code != 0:
            error = _read_metrics(metrics_path)[2] if job['kind'] in ('cold', 'warm') else None
            return None, _failure(job, 'exit-nonzero', result, error), None
        if job['kind'] in ('prod', 'engine'):
            try:
                metrics = json.loads(result.stdout.decode('utf-8'))
                if not isinstance(metrics, dict) or find_forbidden(metrics):
                    raise ValueError()
            except (ValueError, UnicodeError):
                return None, _failure(job, 'invalid-metrics', result), None
            record = {'kind': job['kind'], 'profile': job['profile'], 'sample': job['cell'], 'rep': job['rep'],
                      'wall_ms': result.wall_ms, 'exit_code': 0}
            if job['kind'] == 'engine':
                elapsed = metrics.get('pipeline_ms')
                if not isinstance(elapsed, (float, int)) or not math.isfinite(elapsed) or not 0 <= elapsed <= result.wall_ms:
                    return None, _failure(job, 'invalid-metrics', result), None
                record['pipeline_ms'] = elapsed
                record['devices'] = metrics.get('devices')
        else:
            metrics, reason, error = _read_metrics(metrics_path)
            if reason:
                return None, _failure(job, reason, result, error), None
            if job['kind'] == 'cold':
                record = _cold_record(job, result, metrics)
            else:
                record = _warm_record(job, result, metrics, 1 + args.warmup + args.warm_reps)
                if record is None:
                    return None, _failure(job, 'invalid-metrics', result), None
        record.update({'diagnostics': metrics.get('diagnostics', []), 'providers': metrics.get('providers', {}),
                       'peak_working_set_mb': None, 'memory_unavailable_reason': MEMORY_UNAVAILABLE})
        if job['kind'] == 'warm':
            record['diagnostics'] = sorted({code for item in record['iterations'] for code in item.get('diagnostics', [])})
        record['valid_device'] = record_devices_match(record)
        info = {'env': metrics.get('env'), 'providers': metrics.get('providers'), 'diagnostics': metrics.get('diagnostics')}
        failure = None if record['valid_device'] else _failure(job, 'invalid-device-evidence', result)
        return record, failure, info
    finally:
        if not ctx.keep:
            for leftover in (wav, metrics_path):
                with contextlib.suppress(OSError):
                    leftover.unlink()


def devices_match(profile, diagnostics):
    """Require one actual ONNX selection for BOTH models, not available/registered provider advertisements."""
    if not isinstance(diagnostics, list) or not all(isinstance(c, str) for c in diagnostics):
        return False
    wanted = 'cuda' if profile == 'gpu' else 'cpu'
    for model in ('lid', 'kokoro'):
        prefix = model + '-onnx-provider-'
        codes = {c for c in diagnostics if c.startswith(prefix)}
        if codes != {prefix + wanted}:
            return False
    return True


def record_devices_match(record):
    if record.get('valid_device') is False or not devices_match(record['profile'], record.get('diagnostics')):
        return False
    if record['kind'] == 'warm':
        return bool(record.get('iterations')) and all(devices_match(record['profile'], i.get('diagnostics'))
                                                       for i in record['iterations'])
    if record['kind'] == 'engine':
        devices = record.get('devices') or {}
        return all(devices.get(m) == record['profile'] for m in ('lid', 'kokoro'))
    return True


def _split_ints(text):
    return [int(p) for p in text.split(',') if p.strip()]


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--profiles', default='cpu,gpu', help='comma list of cpu,gpu')
    parser.add_argument('--sizes', default='40,120,300,700,1500', help='target characters per prose sample')
    parser.add_argument('--langs', default='es,en')
    parser.add_argument('--cold-reps', type=int, default=5, help='cold per-process repetitions per cell (0 skips)')
    parser.add_argument('--warm-reps', type=int, default=10, help='timed in-process iterations per cell (0 skips warm)')
    parser.add_argument('--warmup', type=int, default=2, help='discarded warm iterations after the first inference')
    parser.add_argument('--prod-reps', type=int, default=1, help='unmodified production-script wall runs per cell and profile')
    parser.add_argument('--engine-reps', type=int, default=1, help='real TypeScript synthesis-only engine runs per cell and profile')
    parser.add_argument('--out', help='new directory under %%LOCALAPPDATA%%\\Temp\\opencode')
    parser.add_argument('--seed', type=int, default=1337)
    parser.add_argument('--keep', action='store_true', help='keep plans, WAVs and per-run metrics (synthetic data only)')
    parser.add_argument('--dry-run', action='store_true', help='print matrix and commands; spawns nothing')
    parser.add_argument('--preflight', action='store_true', help='check interpreters, assets and tools; spawns nothing')
    parser.add_argument('--home', default=str(Path(os.environ.get('LOCALAPPDATA', '.')) / 'open-vox'))
    parser.add_argument('--timeout', type=int, default=900, help='seconds per cold/prod process (warm gets 3x)')
    args = parser.parse_args(argv)
    args.profiles = [p.strip() for p in args.profiles.split(',') if p.strip()]
    args.langs = [p.strip() for p in args.langs.split(',') if p.strip()]
    if not args.profiles or any(p not in PROFILES for p in args.profiles) or len(set(args.profiles)) != len(args.profiles):
        parser.error('--profiles must be a subset of cpu,gpu')
    if not args.langs or any(lang not in SENTENCES for lang in args.langs):
        parser.error('--langs must be a subset of es,en')
    try:
        args.sizes = _split_ints(args.sizes)
    except ValueError:
        parser.error('--sizes must be integers')
    if not args.sizes or min(args.sizes) < 20 or min(args.cold_reps, args.warm_reps, args.warmup, args.prod_reps, args.engine_reps) < 0:
        parser.error('invalid sizes or repetition counts')
    if not args.out and not args.preflight:
        parser.error('--out is required')
    return args


def run_benchmark(args, *, runner=default_runner, plan_builder=None, root=None, preflight=None, gather_env=None):
    out = validated_output_path(args.out, root)
    paths = resolve_paths(args.home)
    (preflight or (lambda p: preflight_check(p, args.profiles)))(paths)
    plan_builder = plan_builder or bun_plan_builder()
    cells = build_matrix(args.langs, args.sizes, args.seed)
    out.mkdir()
    for name in ('plans', 'wav', 'metrics', 'tmp'):
        (out / name).mkdir()
    samples, plan_bytes = [], {}
    for cell in cells:
        plan = plan_builder(cell['text'], cell['lang'])
        data = json.dumps(plan, ensure_ascii=False).encode('utf-8')
        plan_bytes[cell['id']] = data
        (out / 'plans' / f"{cell['id']}.json").write_bytes(data)
        samples.append({'id': cell['id'], 'lang': cell['lang'], 'kind': cell['kind'], 'target_chars': cell['target'],
                        'chars': len(cell['text']), 'words': len(cell['text'].split()),
                        'plan_blocks': len(plan.get('blocks', [])), 'narration_chars': plan.get('narrationLength'),
                        'plan_outcome': plan.get('outcome')})
    ctx = SimpleNamespace(args=args, cells={c['id']: c for c in cells}, paths=paths, out=out, runner=runner, keep=args.keep,
                          plan_bytes=plan_bytes, env=child_env(out / 'tmp'))
    first_cell = 'es-120' if 'es-120' in ctx.cells else cells[0]['id']
    jobs = build_schedule(args.profiles, [c['id'] for c in cells], args.cold_reps, args.prod_reps, args.warm_reps > 0,
                          args.seed, first_cell, engine_reps=args.engine_reps)
    environment = {**(gather_env or gather_environment)(), 'profiles': {}}
    raw = {'schema': SCHEMA, 'tool': 'bench_runtime', 'created_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
           'complete': False,
           'parameters': {'profiles': args.profiles, 'sizes': args.sizes, 'langs': args.langs, 'cold_reps': args.cold_reps,
                           'warm_reps': args.warm_reps, 'warmup': args.warmup, 'prod_reps': args.prod_reps,
                           'engine_reps': args.engine_reps, 'measurement_revision': 2, 'seed': args.seed,
                          'voices': DEFAULT_VOICES, 'speed': 1.0, 'backend': 'onnx', 'timeout_s': args.timeout,
                          'below_recommended_reps': args.cold_reps < 5 or args.warm_reps < 10},
           'environment': environment, 'samples': samples, 'records': [], 'failures': []}
    try:
        for number, job in enumerate(jobs, 1):
            record, failure, info = execute_job(job, ctx)
            if record:
                raw['records'].append(record)
                if not failure:
                    environment['profiles'].setdefault(job['profile'], {k: v for k, v in (info or {}).items() if v})
            if failure:
                raw['failures'].append(failure)
            status = failure['reason'] if failure else 'ok'
            wall = record['wall_ms'] if record else 0.0
            print(f"[{number}/{len(jobs)}] {job['kind']} {job['profile']} {job['cell']} rep={job['rep']} {status} {wall:.0f} ms",
                  flush=True)
        raw['complete'] = True
    finally:
        assert_no_text(raw)
        with (out / 'results.json').open('w', encoding='utf-8', newline='\n') as stream:
            json.dump(raw, stream, indent=2, ensure_ascii=False)
            stream.write('\n')
        if not args.keep:
            for name in ('plans', 'wav', 'metrics', 'tmp'):
                for leftover in (out / name).glob('*'):
                    with contextlib.suppress(OSError):
                        leftover.unlink()
    return raw


def forecast(args, cells):
    """Planning estimate from ASSUMED constants (not measurements); B2's own log is the authority."""
    fixed = {'cpu': 8.0, 'gpu': 14.0}
    rtf = {'cpu': 0.12, 'gpu': 0.05}
    seconds = 0.0
    for profile in args.profiles:
        for cell in cells:
            audio = len(cell['text']) / 15.0
            cold = fixed[profile] + rtf[profile] * audio
            seconds += cold * (args.cold_reps + args.prod_reps + args.engine_reps)
            if args.cold_reps:
                seconds += cold
            if args.warm_reps:
                seconds += fixed[profile] + rtf[profile] * audio * (1 + args.warmup + args.warm_reps)
    return seconds / 60.0


def print_plan(args, paths, cells):
    jobs = build_schedule(args.profiles, [c['id'] for c in cells], args.cold_reps, args.prod_reps, args.warm_reps > 0,
                          args.seed, 'es-120' if any(c['id'] == 'es-120' for c in cells) else cells[0]['id'],
                          engine_reps=args.engine_reps)
    count = lambda kind: len([j for j in jobs if j['kind'] == kind])
    print(f'Matrix ({len(cells)} samples; synthetic text is never printed or stored):')
    for c in cells:
        print(f"  {c['id']:<14} {c['kind']:<9} lang={c['lang']} target={c['target']:<5} chars={len(c['text']):<5} words={len(c['text'].split())}")
    print('Interpreters (explicit; active runtimeProfile is never read or changed):')
    for p in args.profiles:
        path = paths['interpreters'][p]
        print(f"  {p}: {path} (exists: {'yes' if path.exists() else 'NO'})")
    print(f"Jobs: cold jobs={count('cold')} (incl. {len(args.profiles)} first-ever), prod-wall jobs={count('prod')}, "
          f"engine jobs={count('engine')}, warm workers={count('warm')} x {1 + args.warmup + args.warm_reps} iterations")
    print(f'Rough planning estimate from ASSUMED constants (not measured): about {forecast(args, cells):.0f} minutes')
    cell = next(c for c in cells if c['id'] == 'es-120') if any(c['id'] == 'es-120' for c in cells) else cells[0]
    print('Command lines (plan JSON arrives on stdin; <wav>/<metrics> are per-run scratch files):')
    for p in args.profiles:
        for label, argv in (('cold', worker_command(p, paths['interpreters'][p], cell, 'cold', paths, '<wav>', '<metrics>',
                                                    DEFAULT_VOICES[cell['lang']], 1.0)),
                            ('warm', worker_command(p, paths['interpreters'][p], cell, 'warm', paths, '<wav>', '<metrics>',
                                                    DEFAULT_VOICES[cell['lang']], 1.0, args.warm_reps, args.warmup)),
                            ('prod', production_command(p, paths['interpreters'][p], cell, paths, '<wav>',
                                                        DEFAULT_VOICES[cell['lang']], 1.0))):
            shown = ['<wrapper>' if len(a) > 200 else a for a in argv]
            print(f'  [{p} {label}] ' + ' '.join(shown))
        print(f'  [{p} engine] bun -e <synthesis-only inline script>; profile={p}; plan stdin; scratch WAV')
    if 'gpu' in args.profiles:
        print('GPU wrapper (bench variant of the production -c wrapper):\n  ' + bench_wrapper(paths['repo'] / 'scripts'))
    print('Schedule head (seeded, interleaved):')
    for job in jobs[:10]:
        print(f"  {job['kind']} {job['profile']} {job['cell']} rep={job['rep']}{' first-ever' if job['first_ever'] else ''}")


def run_preflight(args):
    paths = resolve_paths(args.home)
    ok = True
    for name, path, _ in preflight_items(paths, args.profiles):
        exists = Path(path).exists()
        ok &= exists
        print(f"{'OK     ' if exists else 'MISSING'} {name}: {path}")
    for tool, required in (('bun', True), ('nvidia-smi', False)):
        found = shutil.which(tool)
        ok &= bool(found) or not required
        print(f"{'OK     ' if found else ('MISSING' if required else 'absent ')} {tool}{'' if required else ' (optional)'}")
    root = approved_root()
    print(f"{'OK     ' if root.is_dir() else 'MISSING'} scratch root: {root}")
    return 0 if ok and root.is_dir() else 1


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if '--worker' in argv:
        return worker_main(argv)
    args = parse_args(argv)
    if args.preflight:
        return run_preflight(args)
    paths = resolve_paths(args.home)
    validated_output_path(args.out)
    cells = build_matrix(args.langs, args.sizes, args.seed)
    if args.dry_run:
        print_plan(args, paths, cells)
        return 0
    run_benchmark(args)
    print(f"Raw results: {Path(args.out) / 'results.json'}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
