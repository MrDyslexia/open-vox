"""Synthesize UTF-8 text from stdin to a WAV file with Kokoro (local ONNX)."""
import argparse
import json
import os
import sys

import soundfile as sf
from kokoro_onnx import Kokoro


def main() -> int:
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
    args = parser.parse_args()

    if args.plan_json:
        # Offline flags also apply when invoked outside the TypeScript runner.
        for key in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY',
                    'HF_HUB_DISABLE_PROGRESS_BARS', 'DO_NOT_TRACK'):
            os.environ[key] = '1'
        os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN'] = '1'
        os.environ['HF_TOKEN'] = ''
        os.environ['HUGGING_FACE_HUB_TOKEN'] = ''
        try:
            from narration_lid import LocalDetector
            from narration_resolver import resolve_plan
            from narration_synthesis import load_plan, local_lid_directory, raw_phonemizer, synthesize_envelope
            plan = load_plan(sys.stdin)
            detector = LocalDetector(local_lid_directory(args.app_home), args.lid_manifest) if args.app_home else None
            resolved = resolve_plan(plan, detector)
            kokoro = Kokoro(args.model, args.voices)
            english = args.lang if args.lang in ('en-us', 'en-gb') else 'en-us'
            synthesize_envelope(resolved, kokoro, args.voice, args.speed, args.out, raw_phonemizer(kokoro, english))
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
