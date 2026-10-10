"""Synthesize UTF-8 text from stdin to a WAV file with Kokoro (local ONNX)."""
import argparse
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
    args = parser.parse_args()

    text = sys.stdin.buffer.read().decode("utf-8", errors="replace").strip()
    if not text:
        return 2
    kokoro = Kokoro(args.model, args.voices)
    samples, rate = kokoro.create(text, voice=args.voice, speed=args.speed, lang=args.lang)
    sf.write(args.out, samples, rate)
    return 0


if __name__ == "__main__":
    sys.exit(main())
