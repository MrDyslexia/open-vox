"""Private version-1 NDJSON worker. Model state lives here; request state does not."""
import argparse
import contextlib
import io
import json
import math
import os
from pathlib import Path
import queue
import re
import stat
import sys
import threading

REQUEST_BYTES = 1024 * 1024
RESPONSE_BYTES = 8192
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
CODE = re.compile(r'[a-z][a-z0-9-]{0,79}')
STARTUP_STAGES = ('imports', 'runtime-probe', 'detector-build', 'kokoro-load')
REQUEST_STAGES = ('request-read', 'lid-resolve', 'synthesis', 'result')


def no_progress(stage):
    pass


def strict_json(raw):
    if len(raw) > REQUEST_BYTES or not raw.endswith(b'\n'):
        raise ValueError('invalid-frame')
    def pairs(entries):
        result = {}
        for key, value in entries:
            if key in result:
                raise ValueError('duplicate-key')
            result[key] = value
        return result
    def nonfinite(_):
        raise ValueError('nonfinite-json')
    return json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=pairs, parse_constant=nonfinite)


def validate_request(value, owner, generation):
    fields = {'v', 'owner', 'generation', 'request', 'mode', 'input', 'output', 'voice', 'lang',
              'speed', 'toneVoice', 'toneWeight'}
    if (type(value) is not dict or set(value) != fields or type(value['v']) is not int or value['v'] != 1
            or value['owner'] != owner or value['generation'] != generation
            or type(value['request']) is not str or not UUID.fullmatch(value['request'])):
        raise ValueError('invalid-request')
    if (value['mode'] not in ('text', 'plan') or value['lang'] not in ('es', 'en-us', 'en-gb')
            or type(value['voice']) is not str or not re.fullmatch(r'[a-z]{2}_[a-z0-9_]{1,60}', value['voice'])
            or type(value['toneVoice']) is not str
            or (value['toneVoice'] and not re.fullmatch(r'[a-z]{2}_[a-z0-9_]{1,60}', value['toneVoice']))
            or type(value['output']) is not str or len(value['output']) > 4096):
        raise ValueError('invalid-settings')
    for name, minimum, maximum in [('speed', 0.5, 2), ('toneWeight', 0, 1)]:
        number = value[name]
        if type(number) not in (int, float) or not math.isfinite(number) or not minimum <= number <= maximum:
            raise ValueError('invalid-settings')
    if value['mode'] == 'text':
        if type(value['input']) is not str or not value['input'].strip() or len(value['input']) > 4000:
            raise ValueError('invalid-text')
    elif type(value['input']) is not dict:
        raise ValueError('invalid-plan')
    return value


def safe_path(path):
    """Reject symlinks/junctions at every existing component, not only the leaf."""
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('invalid-output')
    for part in [*reversed(path.parents), path]:
        if part.exists() or part.is_symlink():
            s = part.lstat()
            if stat.S_ISLNK(s.st_mode) or getattr(s, 'st_file_attributes', 0) & 0x400:
                raise ValueError('unsafe-output')


@contextlib.contextmanager
def candidate_file(output, root):
    """Only new UUID WAVs or empty caller-created placeholders in the trusted private directory."""
    path, root = Path(output), Path(root)
    safe_path(root)
    safe_path(path)
    if (not root.is_dir() or path.parent != root or path.suffix != '.wav'
            or not UUID.fullmatch(path.stem)):
        raise ValueError('invalid-output')
    # O_EXCL for a new file; existing AudioCache candidates are empty regular placeholders.
    flags = os.O_RDWR | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    try:
        fd = os.open(path, flags | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        fd = os.open(path, flags)
    try:
        current, leaf = os.fstat(fd), path.lstat()
        if (not stat.S_ISREG(current.st_mode) or current.st_size != 0 or current.st_nlink != 1
                or (current.st_dev, current.st_ino) != (leaf.st_dev, leaf.st_ino)):
            raise ValueError('foreign-output')
        safe_path(path)
        with os.fdopen(fd, 'w+b') as stream:
            fd = None
            yield stream
    finally:
        if fd is not None:
            os.close(fd)


class CallCounter:
    """Delegate an owned instance method without retaining arguments or results."""
    def __init__(self, target, method, counters, key):
        self.target, self.method, self.counters, self.key = target, method, counters, key

    def __getattr__(self, name):
        value = getattr(self.target, name)
        if name != self.method:
            return value
        def call(*args, **kwargs):
            self.counters[self.key] += 1
            return value(*args, **kwargs)
        return call


class DetectorCounter:
    def __init__(self, detector, counters):
        self.target, self.counters = detector, counters
        self.load = detector._load
        # The owned detector calls this seam only after its normal input checks. No module patching.
        detector._load = self._load

    def __getattr__(self, name):
        return getattr(self.target, name)

    def _load(self):
        before = self.target._runtime
        self.load()
        runtime = self.target._runtime
        if before is None and runtime is not None:
            self.counters['lidLoads'] += 1
            self.counters['tokenizerLoads'] += 1
            if self.target.__class__.__module__ == 'narration_lid_onnx':
                numpy, tokenizer, session = runtime
                if callable(getattr(session, 'run', None)):
                    self.counters['lidRuns'] = 0
                    self.target._runtime = (numpy, tokenizer, CallCounter(session, 'run', self.counters, 'lidRuns'))


def preimport_sdk(args):
    """Import libraries serially before pipe reading; never construct models or tokenizers."""
    from kokoro_say import build_detector, load_kokoro
    from runtime_device import probe_runtime
    if args.lid_backend == 'onnx':
        try:
            from tokenizers import Tokenizer
        except ImportError:
            pass  # The lazy detector retains its missing-dependencies fallback.
    elif args.app_home:
        try:
            import torch
            from transformers import AutoModelForTokenClassification, AutoTokenizer
            # AutoModel resolves this module lazily for the pinned BERT architecture.
            from transformers.models.bert.modeling_bert import BertForTokenClassification
        except ImportError:
            pass  # Optional LID must not prevent direct Kokoro synthesis.
    return build_detector, load_kokoro, probe_runtime


class Models:
    """Only loaded models/tokenizers and their device diagnostics survive process_request."""
    def __init__(self, args, progress, sdk):
        build_detector, load_kokoro, probe_runtime = sdk
        progress('runtime-probe')
        candidate = probe_runtime(include_torch=args.lid_backend == 'torch' and bool(args.app_home))
        progress('detector-build')
        self.detector = build_detector(args.lid_backend, args.lid_dir, args.app_home, args.lid_manifest, candidate)
        progress('kokoro-load')
        self.kokoro, self.kokoro_device = load_kokoro(args.model, args.voices, candidate)
        # Successful returned model/runtime loads, not constructor attempts or accepted requests.
        self.counters = dict(detectorBuilds=int(self.detector is not None), kokoroLoads=1,
                             lidLoads=None, tokenizerLoads=None, kokoroCreates=None,
                             kokoroRuns=None, lidRuns=None)
        if (self.detector is not None and self.detector.__class__.__module__ in
                ('narration_lid', 'narration_lid_onnx') and hasattr(self.detector, '_runtime')):
            try:
                self.detector = DetectorCounter(self.detector, self.counters)
                self.counters.update(lidLoads=0, tokenizerLoads=0)
            except (AttributeError, TypeError):
                pass  # Unsupported owned-instance instrumentation remains unavailable.
        # The installed Kokoro API owns `sess` and delegates inference through sess.run.
        # Unknown library versions remain usable, but cannot claim observable native run counts.
        if self.kokoro.__class__.__module__.split('.')[0] == 'kokoro_onnx':
            session = getattr(self.kokoro, 'sess', None)
            if session is not None and callable(getattr(session, 'run', None)):
                try:
                    self.kokoro.sess = CallCounter(session, 'run', self.counters, 'kokoroRuns')
                    self.counters['kokoroRuns'] = 0
                except (AttributeError, TypeError):
                    pass
            if callable(getattr(self.kokoro, 'create', None)):
                self.counters['kokoroCreates'] = 0
                self.kokoro = CallCounter(self.kokoro, 'create', self.counters, 'kokoroCreates')

    def synthesize(self, request, output, progress=no_progress):
        from kokoro_say import validate_tone_voice
        import soundfile as sf
        if request['voice'] not in self.kokoro.get_voices():
            raise ValueError('unknown-voice')
        if request['toneWeight'] > 0:
            validate_tone_voice(self.kokoro, request['toneVoice'])
        if request['mode'] == 'text':
            progress('synthesis')
            samples, rate = self.kokoro.create(request['input'], voice=request['voice'],
                                               speed=request['speed'], lang=request['lang'])
            sf.write(output, samples, rate, format='WAV')
            return [self.kokoro_device]
        from narration_resolver import resolve_plan
        from narration_synthesis import load_plan, raw_phonemizer, synthesize_envelope
        plan = load_plan(io.StringIO(json.dumps(request['input'], ensure_ascii=False)))
        progress('lid-resolve')
        resolved = resolve_plan(plan, self.detector)
        english = request['lang'] if request['lang'] in ('en-us', 'en-gb') else 'en-us'
        progress('synthesis')
        synthesize_envelope(resolved, self.kokoro, request['voice'], request['speed'], output,
                            raw_phonemizer(self.kokoro, english), tone_voice=request['toneVoice'],
                            tone_weight=request['toneWeight'])
        codes = ({d['code'] for d in resolved['diagnostics']} | {self.kokoro_device}
                 | set(self.detector.device_diagnostics if self.detector else []))
        if plan['outcome'] != 'complete':
            codes.add('narration-truncated')
        return sorted(codes)


def process_request(models, value, args, progress=no_progress):
    """All text, plans, voice styles and outputs die with this function's frame."""
    request = validate_request(value, args.owner, args.generation)
    with candidate_file(request['output'], args.output_root) as stream:
        codes = models.synthesize(request, stream, progress)
    if (type(codes) is not list or len(codes) > 32 or len(set(codes)) != len(codes)
            or any(type(c) is not str or not CODE.fullmatch(c) for c in codes)):
        raise ValueError('invalid-diagnostics')
    return {'v': 1, 'owner': args.owner, 'generation': args.generation, 'type': 'result',
            'request': request['request'], 'code': 0, 'diagnostics': codes}


def emit(stream, value):
    raw = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8') + b'\n'
    if len(raw) > RESPONSE_BYTES:
        raise ValueError('oversized-response')
    stream.write(raw)
    stream.flush()


def progress_reporter(protocol, owner, generation, request=None):
    """Fixed scalar metadata only; each scope emits at most four strictly ordered stages."""
    stages = STARTUP_STAGES if request is None else REQUEST_STAGES
    last = -1
    def report(stage):
        nonlocal last
        if stage not in stages or stages.index(stage) <= last:
            raise ValueError('invalid-progress')
        last = stages.index(stage)
        emit(protocol, {'v': 1, 'owner': owner, 'generation': generation, 'type': 'progress',
                        'request': request, 'stage': stage})
    return report


def read_frames(stream, inbox, terminate=os._exit):
    """A reader alone watches EOF, even during native inference; it never calls model code.

    Once started after SDK imports, a vanished host closes its private stdin pipe. Immediate exit
    avoids an idle orphan and can interrupt native work when this thread can run. There is no
    monitoring during imports and no all-time orphan guarantee or process-tree watchdog.
    """
    try:
        while True:
            raw = stream.readline(REQUEST_BYTES + 1)
            if not raw:
                terminate(0)
                return
            if len(raw) > REQUEST_BYTES or not raw.endswith(b'\n'):
                terminate(2)
                return
            inbox.put_nowait(raw)  # No unbounded queue for unauthorized concurrent requests.
            del raw  # Queue owns the frame; do not retain plaintext during the next blocking read.
    except Exception:
        terminate(2)


def serve(args, source, protocol, bootstrap=None, model_factory=None):
    progress = progress_reporter(protocol, args.owner, args.generation)
    progress('imports')
    sdk = (bootstrap or preimport_sdk)(args)
    inbox = queue.Queue(maxsize=1)
    reader = threading.Thread(target=read_frames, args=(source, inbox), daemon=True)
    reader.start()
    # Imports, library prints and native fd-1 warnings must never enter the protocol stream.
    models = (model_factory or Models)(args, progress, sdk)
    emit(protocol, {'v': 1, 'owner': args.owner, 'generation': args.generation, 'type': 'ready'})
    while True:
        raw = inbox.get()
        value = strict_json(raw)
        validate_request(value, args.owner, args.generation)
        progress = progress_reporter(protocol, args.owner, args.generation, value['request'])
        progress('request-read')
        try:
            result = process_request(models, value, args, progress)
        except Exception:
            result = {'v': 1, 'owner': args.owner, 'generation': args.generation, 'type': 'result',
                      'request': value['request'], 'code': 2, 'diagnostics': []}
        progress('result')  # Boundary reached, not a success claim; code/stats retain their original roles.
        emit(protocol, {'v': 1, 'owner': args.owner, 'generation': args.generation, 'type': 'stats',
                        'request': value['request'], **models.counters})
        emit(protocol, result)
        # Explicitly clear the loop variables while idle: model objects are the only retained payload.
        del raw, value, result, progress


def main(argv=None):
    parser = argparse.ArgumentParser()
    for name in ('model', 'voices', 'output-root', 'owner', 'generation'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--app-home')
    parser.add_argument('--lid-manifest')
    parser.add_argument('--lid-backend', choices=('torch', 'onnx'), default='torch')
    parser.add_argument('--lid-dir')
    args = parser.parse_args(argv)
    if not UUID.fullmatch(args.owner) or not UUID.fullmatch(args.generation):
        return 2
    if args.lid_backend == 'onnx' and (not args.lid_dir or not Path(args.lid_dir).is_absolute()):
        return 2
    if args.lid_backend == 'torch' and args.lid_dir:
        return 2
    safe_path(Path(args.output_root))
    # Duplicate the private protocol pipe, then redirect fd 1 too (contextlib alone misses native prints).
    with os.fdopen(os.dup(sys.stdout.fileno()), 'wb', buffering=0) as protocol:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        with contextlib.redirect_stdout(sys.stderr):
            try:
                serve(args, sys.stdin.buffer, protocol)
            except Exception:
                return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
