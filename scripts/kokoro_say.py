"""Synthesize UTF-8 text from stdin to a WAV file with Kokoro (local ONNX)."""
import argparse
import json
import math
import os
import sys
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro

LID_BACKENDS = ('torch', 'onnx')
TONE_WEIGHT_MIN = 0.0
TONE_WEIGHT_MAX = 1.0


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--voices", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--lang", required=True)
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--out", required=True)
    parser.add_argument("--plan-json", action="store_true")
    parser.add_argument("--app-home", help="Local app home; no provisioning during inference")
    parser.add_argument("--lid-manifest", help="Bundled pinned LID manifest; defaults relative to this helper")
    # Validated by validate_lid_args (no argparse `choices`): a rejected value is never echoed.
    parser.add_argument("--lid-backend", default="torch", metavar="{torch,onnx}",
                        help="Language detector backend; defaults to torch")
    parser.add_argument("--lid-dir", help="Absolute local ONNX model directory; only valid with --lid-backend onnx")
    # Validated by validate_tone_args/validate_tone_voice (no argparse `choices`): a rejected value is never echoed.
    # The donor only moves prosody (gravity and monotone); pace stays owned by --speed.
    parser.add_argument("--tone-voice", default='', metavar="VOICE",
                        help="Donor voice blended into the prosody half of the style; empty disables the blend "
                             "(measured donor: am_onyx)")
    parser.add_argument("--tone-weight", type=float, default=0.0, metavar="WEIGHT",
                        help="Donor prosody weight in 0.0-1.0; 0.0 disables the blend (measured weight: 0.75)")
    return parser


def parse_args(argv=None):
    return make_parser().parse_args(argv)


def validate_lid_args(args) -> None:
    """Raises ValueError (without echoing values) unless the backend/directory pair is coherent."""
    if args.lid_backend not in LID_BACKENDS:
        raise ValueError('invalid-lid-backend')
    if args.lid_backend == 'torch':
        if args.lid_dir is not None:
            raise ValueError('lid-dir-requires-onnx')
        return
    if not args.plan_json or not args.lid_dir or not Path(args.lid_dir).is_absolute():
        raise ValueError('invalid-onnx-lid-arguments')


def validate_tone_args(args) -> None:
    """Raises ValueError (without echoing values) unless the tone weight is finite and within range."""
    weight = args.tone_weight
    if not isinstance(weight, (int, float)) or not math.isfinite(weight):
        raise ValueError('invalid-tone-weight')
    if not TONE_WEIGHT_MIN <= weight <= TONE_WEIGHT_MAX:
        raise ValueError('invalid-tone-weight')


def validate_tone_voice(kokoro, tone_voice) -> None:
    """Raises ValueError (without echoing the name) unless a requested donor exists in the loaded pack.

    The pack is the only authority: the donor is deliberately not restricted to the narration language,
    so a hardcoded list would reject the measured best donors.
    """
    if not tone_voice:
        return
    if tone_voice not in kokoro.get_voices():
        raise ValueError('unknown-tone-voice')


def build_detector(backend, lid_dir, app_home, manifest):
    """Imports only the selected backend's module; torch behavior is exactly the pre-existing one."""
    if backend == 'onnx':
        from narration_lid_onnx import OnnxDetector
        return OnnxDetector(Path(lid_dir), manifest)
    if not app_home:
        return None
    from narration_lid import LocalDetector
    from narration_synthesis import local_lid_directory
    return LocalDetector(local_lid_directory(app_home), manifest)


def main(argv=None) -> int:
    args = parse_args(argv)
    try:
        validate_lid_args(args)
        validate_tone_args(args)
    except ValueError:
        sys.stderr.write('Narration synthesis failed\n')
        return 2

    if args.plan_json:
        # Offline flags also apply when invoked outside the TypeScript runner.
        for key in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY',
                    'HF_HUB_DISABLE_PROGRESS_BARS', 'DO_NOT_TRACK'):
            os.environ[key] = '1'
        os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN'] = '1'
        os.environ['HF_TOKEN'] = ''
        os.environ['HUGGING_FACE_HUB_TOKEN'] = ''
        try:
            from narration_resolver import resolve_plan
            from narration_synthesis import load_plan, raw_phonemizer, synthesize_envelope
            plan = load_plan(sys.stdin)
            detector = build_detector(args.lid_backend, args.lid_dir, args.app_home, args.lid_manifest)
            resolved = resolve_plan(plan, detector)
            kokoro = Kokoro(args.model, args.voices)
            if args.tone_weight > 0:
                validate_tone_voice(kokoro, args.tone_voice)
            english = args.lang if args.lang in ('en-us', 'en-gb') else 'en-us'
            synthesize_envelope(resolved, kokoro, args.voice, args.speed, args.out, raw_phonemizer(kokoro, english),
                                tone_voice=args.tone_voice, tone_weight=args.tone_weight)
            codes = sorted({d['code'] for d in resolved['diagnostics']})
            if plan['outcome'] != 'complete':
                codes.append('narration-truncated')
            json.dump({'diagnostics': codes}, sys.stdout)
            return 0
        except Exception:
            sys.stderr.write('Narration synthesis failed\n')
            return 2
    text = sys.stdin.buffer.read().decode("utf-8", errors="replace").strip()
    if not text:
        return 2
    kokoro = Kokoro(args.model, args.voices)
    samples, rate = kokoro.create(text, voice=args.voice, speed=args.speed, lang=args.lang)
    sf.write(args.out, samples, rate)
    return 0


if __name__ == "__main__":
    sys.exit(main())
