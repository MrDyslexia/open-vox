"""Deterministic report generator for bench_runtime raw JSON (schema 1): Markdown tables plus one CSV.

Re-runnable from the stored raw file; reads no other input and refuses documents carrying text-like fields.
It reports what the numbers show and flags variance; it makes no recommendation and no quality claim.
"""
import argparse
import csv
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench_runtime import WORKER_STEPS, find_forbidden, record_devices_match, summarize  # noqa: E402

HIGH_VARIANCE_CV = 0.25
MIN_COLD_N = 5
MIN_WARM_N = 10
COLD_STEPS = ('interpreter_startup', *WORKER_STEPS, 'untimed_worker', 'total_worker', 'unattributed', 'total_wall')
WARM_STEPS = ('lid_inference_resolve', 'phonemize', 'kokoro_inference', 'wav_write', 'synthesis_overhead', 'total_iteration')
PROFILE_ORDER = ('cpu', 'gpu')


# ---------------------------------------------------------------- math

def speedup(cpu, gpu):
    if cpu is None or gpu is None or gpu <= 0:
        return None
    return cpu / gpu


def high_variance(stats):
    mean, stddev = stats.get('mean'), stats.get('stddev')
    return stats.get('n', 0) >= 3 and bool(mean) and stddev is not None and stddev / abs(mean) > HIGH_VARIANCE_CV


def linear_fit(xs, ys):
    """Ordinary least squares y = a + b*x. None for fewer than 3 points or no spread in x."""
    n = len(xs)
    if n < 3 or len(set(xs)) < 2:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    slope = sxy / sxx
    intercept = my - slope * mx
    total = sum((y - my) ** 2 for y in ys)
    residual = sum((y - (intercept + slope * x)) ** 2 for x, y in zip(xs, ys))
    return intercept, slope, (1.0 - residual / total) if total else 1.0


# ---------------------------------------------------------------- loading and aggregation

def validate_raw(raw):
    if not isinstance(raw, dict) or raw.get('schema') != 1:
        raise ValueError('unsupported-schema')
    for key in ('parameters', 'environment', 'samples', 'records', 'failures'):
        if key not in raw:
            raise ValueError('incomplete-document')
    found = find_forbidden(raw)
    if found:
        raise ValueError('refusing-text-like-fields: ' + ', '.join(found[:5]))
    return raw


def load_raw(path):
    return validate_raw(json.loads(Path(path).read_text(encoding='utf-8')))


def aggregate(raw):
    samples = {s['id']: s for s in raw['samples']}
    cold, warm, first, rtf_cold, rtf_warm, first_ever, peak, gpu_delta, gaps = {}, {}, {}, {}, {}, {}, {}, {}, []
    buckets = {}
    production, engine = {}, {}

    def bucket(table, profile, sample, step, value):
        if value is not None:
            buckets.setdefault((table, profile, sample, step), []).append(value)

    for record in raw['records']:
        if not record_devices_match(record):
            continue
        profile, sample = record['profile'], record['sample']
        if record['kind'] == 'cold':
            if record.get('first_ever'):
                bucket('first_ever', profile, sample, 'total_wall', record['wall_ms'])
                continue
            for step, value in record['steps'].items():
                bucket('cold', profile, sample, step, value)
            bucket('audio', profile, sample, 'cold', record['audio']['seconds'])
            gaps.append(record['crosscheck']['gap_pct'])
        elif record['kind'] == 'warm':
            for item in record['iterations']:
                if item['role'] == 'timed':
                    for step, value in item['steps'].items():
                        bucket('warm', profile, sample, step, value)
                    bucket('warm', profile, sample, 'total_iteration', item['total_ms'])
                elif item['role'] == 'first':
                    for step, value in item['steps'].items():
                        bucket('first', profile, sample, step, value)
                    bucket('first', profile, sample, 'total_iteration', item['total_ms'])
            bucket('audio', profile, sample, 'warm', record['audio']['seconds'])
            memory = record.get('gpu_memory_mb')
            if memory:
                bucket('gpu_delta', profile, sample, 'warm', memory['after'] - memory['before'])
        elif record['kind'] in ('prod', 'engine'):
            bucket(record['kind'], profile, sample, 'total_wall', record['wall_ms'])
            if record['kind'] == 'engine':
                bucket('engine', profile, sample, 'pipeline_ms', record.get('pipeline_ms'))
    tables = {'cold': cold, 'warm': warm, 'first': first, 'first_ever': first_ever, 'prod': production, 'engine': engine}
    for (table, profile, sample, step), values in buckets.items():
        if table in tables:
            tables[table].setdefault(profile, {}).setdefault(sample, {})[step] = summarize(values)
    for (table, profile, sample, step), values in buckets.items():
        if table == 'peak':
            peak.setdefault(profile, {})[sample] = summarize(values)['median']
        elif table == 'gpu_delta':
            gpu_delta.setdefault(profile, {})[sample] = summarize(values)['median']
    for profile, by_sample in cold.items():
        for sample, steps in by_sample.items():
            seconds = summarize(buckets.get(('audio', profile, sample, 'cold'), []))['median']
            if seconds and steps.get('total_wall', {}).get('median') is not None:
                rtf_cold.setdefault(profile, {})[sample] = steps['total_wall']['median'] / 1000.0 / seconds
    for profile, by_sample in warm.items():
        for sample, steps in by_sample.items():
            seconds = summarize(buckets.get(('audio', profile, sample, 'warm'), []))['median']
            if seconds and steps.get('total_iteration', {}).get('median') is not None:
                rtf_warm.setdefault(profile, {})[sample] = steps['total_iteration']['median'] / 1000.0 / seconds
    # first-inference rows hold the median of the first iterations, keyed like the other tables
    first_inference = {p: {s: {step: stats['median'] for step, stats in steps.items()} for s, steps in by.items()}
                       for p, by in first.items()}
    fits = {}
    for label, table, step in (('cold', cold, 'total_wall'), ('warm', warm, 'total_iteration')):
        for profile, by_sample in table.items():
            points = sorted((samples[s]['narration_chars'], steps[step]['median']) for s, steps in by_sample.items()
                            if s in samples and samples[s]['kind'] == 'prose' and samples[s].get('narration_chars') is not None
                            and steps.get(step, {}).get('median') is not None)
            fit = linear_fit([p[0] for p in points], [p[1] for p in points])
            if fit:
                fits.setdefault(label, {})[profile] = {'intercept': fit[0], 'slope': fit[1], 'r2': fit[2], 'points': len(points)}
    gap_values = [g for g in gaps if g is not None]
    return {'samples': samples, 'cold': cold, 'warm': warm, 'first_inference': first_inference, 'first_ever': first_ever,
            'prod': production, 'engine': engine,
            'rtf_cold': rtf_cold, 'rtf_warm': rtf_warm, 'fits': fits, 'peak_mb': peak, 'gpu_delta_mb': gpu_delta,
            'gap_pct': summarize(gap_values)}


# ---------------------------------------------------------------- rendering helpers

def fmt(value):
    if value is None:
        return '-'
    return f'{value:.0f}' if abs(value) >= 10 else f'{value:.1f}'


def fx(value):
    return '-' if value is None else f'{value:.2f}x'


def table(headers, rows):
    lines = ['| ' + ' | '.join(headers) + ' |', '|' + '|'.join('---' for _ in headers) + '|']
    lines += ['| ' + ' | '.join(str(c) for c in row) + ' |' for row in rows]
    return lines


def median_of(table_, profile, sample, step):
    return table_.get(profile, {}).get(sample, {}).get(step, {}).get('median')


def flags(*stats, minimum):
    found = []
    for label, s in stats:
        if s and high_variance(s):
            found.append(f'high variance {label} (cv {100 * s["stddev"] / s["mean"]:.0f}%)')
        if s and 0 < s['n'] < minimum:
            found.append(f'low n {label} ({s["n"]})')
    return '; '.join(found)


def present_profiles(agg, *names):
    return [p for p in PROFILE_ORDER if any(p in agg[n] for n in names)]


def sample_order(raw):
    return [s['id'] for s in raw['samples']]


def render_markdown(raw):
    agg = aggregate(raw)
    ids = sample_order(raw)
    params = raw['parameters']
    env = raw['environment']
    out = ['# CPU vs GPU runtime benchmark report', '']
    if not raw['records']:
        out += ['No successful runs were recorded.', '']
    out += ['## Run', '']
    out += table(['Field', 'Value'], [
        ['created (UTC)', raw.get('created_utc', '-')], ['complete', raw.get('complete')],
        ['profiles', ', '.join(params.get('profiles', []))], ['cold repetitions', params.get('cold_reps')],
        ['warm timed iterations', params.get('warm_reps')], ['warm-up iterations', params.get('warmup')],
        ['seed', params.get('seed')], ['below recommended repetitions', params.get('below_recommended_reps')],
        ['successful records', len(raw['records'])], ['excluded runs', len(raw['failures'])]])
    out += ['', '## Environment', '']
    gpu = env.get('gpu') or {}
    out += table(['Fact', 'Value'], [['OS', env.get('os', '-')], ['CPU', env.get('cpu', '-')],
                                     ['GPU', gpu.get('name', '-')], ['GPU driver', gpu.get('driver', '-')],
                                     ['parent Python', env.get('parent_python', '-')], ['bun', env.get('bun', '-')]])
    for profile in PROFILE_ORDER:
        info = env.get('profiles', {}).get(profile)
        if info:
            rows = [[f'{k}', json.dumps(v, sort_keys=True)] for k, v in sorted((info.get('env') or {}).items())]
            rows += [[f'providers.{k}', ', '.join(v)] for k, v in sorted((info.get('providers') or {}).items())]
            out += ['', f'**{profile} worker interpreter (reported by the worker)**', ''] + table(['Fact', 'Value'], rows)
    out += ['', '## Samples (counts only; no text is stored)', '']
    out += table(['sample', 'kind', 'lang', 'target chars', 'chars', 'words', 'plan blocks', 'narration chars', 'plan outcome'],
                 [[s['id'], s['kind'], s['lang'], s['target_chars'], s['chars'], s['words'], s['plan_blocks'],
                   s['narration_chars'], s['plan_outcome']] for s in raw['samples']])

    cold = agg['cold']
    out += ['', '## Instrumented cold total wall time, CPU vs GPU (per-process)', '',
            'Speed-up = CPU median / GPU median; values below 1.00x mean the GPU profile was slower.', '']
    rows = []
    for sample in ids:
        c = cold.get('cpu', {}).get(sample, {}).get('total_wall')
        g = cold.get('gpu', {}).get(sample, {}).get('total_wall')
        if c or g:
            rows.append([sample, fmt(c and c['median']), fmt(g and g['median']), fx(speedup(c and c['median'], g and g['median'])),
                         c['n'] if c else 0, g['n'] if g else 0,
                         flags(('cpu', c), ('gpu', g), minimum=MIN_COLD_N)])
    out += table(['sample', 'cpu median ms', 'gpu median ms', 'speed-up', 'cpu n', 'gpu n', 'flags'], rows)

    for name, step, title in (
            ('prod', 'total_wall', 'Python production-worker wall'),
            ('engine', 'pipeline_ms', 'TypeScript engine synthesis pipeline'),
            ('engine', 'total_wall', 'TypeScript engine parent wall')):
        out += ['', f'## {title} (CPU vs GPU, ms)', '',
                'Separate runs, not instrumented cold totals. n=1 is preliminary; no variance estimate. '
                'The default production/engine repetition count is 1, versus 5 cold runs.', '']
        rows = []
        for sample in ids:
            c = agg[name].get('cpu', {}).get(sample, {}).get(step)
            g = agg[name].get('gpu', {}).get(sample, {}).get(step)
            if c or g:
                rows.append([sample, fmt(c and c['median']), fmt(g and g['median']),
                             fx(speedup(c and c['median'], g and g['median'])),
                             c['n'] if c else 0, g['n'] if g else 0,
                             flags(('cpu', c), ('gpu', g), minimum=MIN_COLD_N)])
        out += table(['sample', 'cpu median ms', 'gpu median ms', 'speed-up', 'cpu n', 'gpu n', 'flags'], rows)
    out += ['', 'Engine pipeline: inside Bun, after module import and stdin plan parsing, from default engine construction '
            'through synthesizePlan child completion. Parent wall additionally includes Bun startup/import, stdin and exit. '
            'The shared real planner runs before these jobs and is not timed. No player or whole-UI latency is measured.']

    out += ['', '## First-ever run per profile (kept out of the cold statistics)', '']
    rows = [[p, s, fmt(stats['total_wall']['median'])] for p in PROFILE_ORDER for s, stats in sorted(agg['first_ever'].get(p, {}).items())]
    out += table(['profile', 'sample', 'wall ms'], rows)

    out += ['', '## Cold per-step medians (ms): cpu / gpu (speed-up)', '']
    rows = []
    for step in COLD_STEPS:
        cells = []
        for sample in ids:
            c, g = median_of(cold, 'cpu', sample, step), median_of(cold, 'gpu', sample, step)
            cells.append('-' if c is None and g is None else f'{fmt(c)} / {fmt(g)} ({fx(speedup(c, g))})')
        if any(cell != '-' for cell in cells):
            rows.append([step, *cells])
    out += table(['step', *ids], rows)
    out += ['', 'interpreter_startup is spawn to first worker timestamp; dll_preload_probe is the GPU wrapper preload plus '
            'probe_runtime; unattributed is parent wall time minus startup, wrapper preload and worker time (process exit, '
            'runpy and spawn overhead). synthesis_overhead is the rest of synthesize_envelope (phoneme adaptation, chunk packing, '
            'style fetch, concatenation). untimed_worker is the signed worker elapsed time minus exclusive timed steps '
            '(excluding wrapper preload already counted in dll_preload_probe), including argparse and function setup. '
            'Exclusive steps + untimed_worker + unattributed reconcile parent wall per run; total_worker and total_wall '
            'are overlapping totals, not additional steps. Per-step medians do not necessarily sum to the median total. '
            'Negative residuals are retained, not hidden by clamping.']

    gap = agg['gap_pct']
    out += ['', '## Cross-check: parent wall vs harness total', '']
    out += [f'Median unattributed gap: {fmt(gap["median"])}% of parent wall time (p95 {fmt(gap["p95"])}%, n={gap["n"]}).'
            if gap['n'] else 'No cold records to cross-check.']

    warm = agg['warm']
    out += ['', '## Warm in-process steady state (ms, median of timed iterations)', '',
            'First inference and warm-up iterations are excluded. cpu / gpu (speed-up).', '']
    rows = []
    for step in WARM_STEPS:
        cells = []
        for sample in ids:
            c, g = median_of(warm, 'cpu', sample, step), median_of(warm, 'gpu', sample, step)
            cells.append('-' if c is None and g is None else f'{fmt(c)} / {fmt(g)} ({fx(speedup(c, g))})')
        if any(cell != '-' for cell in cells):
            rows.append([step, *cells])
    out += table(['step', *ids], rows)
    rows = []
    for sample in ids:
        for profile in PROFILE_ORDER:
            s = warm.get(profile, {}).get(sample, {}).get('total_iteration')
            if s:
                rows.append([sample, profile, s['n'], fmt(s['min']), fmt(s['median']), fmt(s['mean']), fmt(s['p95']),
                             fmt(s['stddev']), flags((profile, s), minimum=MIN_WARM_N)])
    out += ['', '**Warm iteration total statistics**', ''] + table(
        ['sample', 'profile', 'n', 'min', 'median', 'mean', 'p95', 'stddev', 'flags'], rows)

    out += ['', '## Real-time factor (processing seconds per audio second; lower is faster)', '']
    rows = []
    for sample in ids:
        values = [agg[t].get(p, {}).get(sample) for t in ('rtf_cold', 'rtf_warm') for p in PROFILE_ORDER]
        if any(v is not None for v in values):
            rows.append([sample, *[('-' if v is None else f'{v:.3f}') for v in values]])
    out += table(['sample', 'cold RTF cpu', 'cold RTF gpu', 'warm RTF cpu', 'warm RTF gpu'], rows)

    out += ['', '## Fixed vs per-character cost (illustrative linear fit)', '']
    rows = []
    for label in ('cold', 'warm'):
        for profile in PROFILE_ORDER:
            fit = agg['fits'].get(label, {}).get(profile)
            if fit:
                rows.append([label, profile, fmt(fit['intercept']), f'{fit["slope"]:.3f}', f'{fit["r2"]:.3f}', fit['points']])
    out += table(['mode', 'profile', 'fixed ms (intercept)', 'ms per narration char (slope)', 'r2', 'points'], rows)
    for label in ('cold', 'warm'):
        fits = agg['fits'].get(label, {})
        if 'cpu' in fits and 'gpu' in fits and fits['cpu']['slope'] != fits['gpu']['slope']:
            crossing = (fits['gpu']['intercept'] - fits['cpu']['intercept']) / (fits['cpu']['slope'] - fits['gpu']['slope'])
            note = f'about {crossing:.0f} narration characters' if crossing > 0 else 'not at a positive length'
            out += ['', f'Illustrative {label} crossover where the two fitted lines meet: {note}.']
    out += ['', 'Limits: median per sample, prose samples only, Spanish and English pooled, a handful of points, and chunk packing '
            'makes real cost piecewise rather than linear. Treat intercept and slope as rough descriptions, not predictions.']

    out += ['', '## First inference vs steady state (warm worker, ms)', '']
    rows = []
    for sample in ids:
        for profile in PROFILE_ORDER:
            first = agg['first_inference'].get(profile, {}).get(sample, {}).get('total_iteration')
            steady = median_of(warm, profile, sample, 'total_iteration')
            if first is not None:
                rows.append([sample, profile, fmt(first), fmt(steady), fx(speedup(first, steady))])
    out += table(['sample', 'profile', 'first inference', 'steady median', 'first / steady'], rows)

    out += ['', '## Resources', '']
    out += ['Process peak memory: UNAVAILABLE (venv_launcher_not_inference_process). Legacy numeric launcher peaks '
            'are ignored; inference-process memory was not measured.', '']
    rows = [[p, s, fmt(v)] for p in PROFILE_ORDER for s, v in sorted(agg['gpu_delta_mb'].get(p, {}).items())]
    out += ['', '**Coarse global GPU memory delta (MB, nvidia-smi before load vs after iterations; includes other GPU users; '
            'not a workload peak)**', '']
    out += table(['profile', 'sample', 'delta MB'], rows)

    out += ['', '## Per-run device evidence', '',
            'Both models must report CPU for CPU jobs or CUDA for GPU jobs. Provider registration is not all-node placement; '
            'CUDA sessions may legitimately register CPU for shape operations. Missing/mismatched evidence is excluded '
            'from every timing aggregate and speed-up, including legacy records without per-run evidence.', '']
    rows = []
    for r in sorted(raw['records'], key=lambda r: (r['kind'], r['profile'], r['sample'], r['rep'])):
        items = r.get('iterations') if r['kind'] == 'warm' else [r]
        for item in items or []:
            rows.append([r['kind'], r['profile'], r['sample'], r['rep'], item.get('index', '-'),
                         item.get('role', '-'), record_devices_match(r), ', '.join(item.get('diagnostics') or []),
                         json.dumps(item.get('providers', r.get('providers', {})), sort_keys=True)])
    out += table(['mode', 'profile', 'sample', 'rep', 'iteration', 'role', 'valid', 'device codes', 'registered providers'], rows)
    out += ['', f'Records excluded by device validation: {sum(not record_devices_match(r) for r in raw["records"])}. '
            'Invalid successful processes remain in raw records for audit; failure entries may refer to those same jobs.']

    out += ['', '## Excluded runs (non-zero exit, timeout or unusable metrics)', '']
    rows = [[f['kind'], f['profile'], f['sample'], f['rep'], f['reason'], f.get('exit_code'), f.get('error_class', '')]
            for f in sorted(raw['failures'], key=lambda f: (f['kind'], f['profile'], f['sample'], f['rep']))]
    out += table(['kind', 'profile', 'sample', 'rep', 'reason', 'exit code', 'error class'], rows) if rows else ['None.']

    out += ['', '## Reading guide', ''] + [f'- {line}' for line in reading_guide(raw, agg, ids)]
    return '\n'.join(out) + '\n'


def reading_guide(raw, agg, ids):
    lines = []
    both = [s for s in ids if median_of(agg['cold'], 'cpu', s, 'total_wall') is not None
            and median_of(agg['cold'], 'gpu', s, 'total_wall') is not None]
    if both:
        lower = [s for s in both if median_of(agg['cold'], 'gpu', s, 'total_wall') < median_of(agg['cold'], 'cpu', s, 'total_wall')]
        lines.append(f'Cold total wall median is lower than CPU on the GPU profile in {len(lower)} of {len(both)} samples '
                     f'({", ".join(lower) if lower else "none"}).')
    both = [s for s in ids if median_of(agg['warm'], 'cpu', s, 'total_iteration') is not None
            and median_of(agg['warm'], 'gpu', s, 'total_iteration') is not None]
    if both:
        lower = [s for s in both if median_of(agg['warm'], 'gpu', s, 'total_iteration') < median_of(agg['warm'], 'cpu', s, 'total_iteration')]
        lines.append(f'Warm steady-state iteration median is lower than CPU on the GPU profile in {len(lower)} of {len(both)} samples.')
    for profile in PROFILE_ORDER:
        by_sample = agg['cold'].get(profile, {})
        if by_sample:
            sample = max(by_sample, key=lambda s: by_sample[s].get('total_wall', {}).get('median') or 0)
            steps = {k: v['median'] for k, v in by_sample[sample].items()
                     if k not in ('total_wall', 'total_worker') and v['median'] is not None}
            top = max(steps, key=steps.get)
            lines.append(f'{profile}: in the slowest sample ({sample}) the largest single cold step by median is {top} '
                         f'({fmt(steps[top])} ms of {fmt(by_sample[sample]["total_wall"]["median"])} ms).')
    variable = sum(1 for table_ in (agg['cold'], agg['warm']) for by in table_.values() for steps in by.values()
                   for s in steps.values() if high_variance(s))
    lines.append(f'{variable} step cells have a coefficient of variation above {int(HIGH_VARIANCE_CV * 100)}% (high variance); '
                 'compare their medians with caution and see the flags columns.')
    if agg['gap_pct']['n']:
        lines.append(f'Parent wall time exceeds the harness total by a median {fmt(agg["gap_pct"]["median"])}% (process exit and '
                     'spawn overhead that no in-worker timer can see).')
    lines.append(f'{len(raw["failures"])} runs were excluded; sample sizes per cell are in the n columns. Cold figures need '
                 f'at least {MIN_COLD_N} runs and warm figures at least {MIN_WARM_N}; cells below that are flagged low n.')
    lines.append('Timings come from one machine in one session; thermal state, background load and file cache are not controlled. '
                 'No audio quality or numerical parity is measured.')
    return lines


def find_forbidden_in_output(markdown):
    """Lines long enough to hold prose; a rendered table row never needs them."""
    return [i for i, line in enumerate(markdown.splitlines(), 1) if len(line) > 1000]


CSV_HEADER = ['mode', 'profile', 'sample', 'lang', 'narration_chars', 'step', 'n', 'min_ms', 'median_ms', 'mean_ms', 'p95_ms',
              'stddev_ms']


def render_csv(raw):
    agg = aggregate(raw)
    stream = io.StringIO()
    writer = csv.writer(stream, lineterminator='\n')
    writer.writerow(CSV_HEADER)
    number = lambda v: '' if v is None else f'{v:.3f}'
    for mode, table_, steps in (('cold', agg['cold'], COLD_STEPS), ('warm', agg['warm'], WARM_STEPS),
                                ('prod', agg['prod'], ('total_wall',)),
                                ('engine', agg['engine'], ('pipeline_ms', 'total_wall'))):
        for profile in PROFILE_ORDER:
            for sample in sample_order(raw):
                info = agg['samples'][sample]
                for step in steps:
                    s = table_.get(profile, {}).get(sample, {}).get(step)
                    if s:
                        writer.writerow([mode, profile, sample, info['lang'], info['narration_chars'], step, s['n'],
                                         number(s['min']), number(s['median']), number(s['mean']), number(s['p95']),
                                         number(s['stddev'])])
    return stream.getvalue()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw', required=True, help='results.json written by bench_runtime.py')
    parser.add_argument('--md', required=True, help='Markdown report to write')
    parser.add_argument('--csv', required=True, help='CSV table to write')
    args = parser.parse_args(argv)
    raw = load_raw(args.raw)
    for target, content in ((args.md, render_markdown(raw)), (args.csv, render_csv(raw))):
        with open(target, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(content)
    return 0


if __name__ == '__main__':
    sys.exit(main())
