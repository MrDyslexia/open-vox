"""Add bundled custom voices to a Kokoro voices pack (numpy only; runs in the kokoro venv).

Each ``<name>.npy`` in --voices-dir is a float32 style array of shape (510, 1, 256), the same
shape as the stock voices. The pack (``voices-v1.0.bin``) is a numpy ``.npz`` archive. The merge
is idempotent: a voice that is already present and identical leaves the pack untouched.
Stock voices are never modified, and the pack is replaced atomically.
"""
import argparse
import os
import re
import sys
import tempfile
from pathlib import Path

import numpy as np

STYLE_SHAPE = (510, 1, 256)
VOICE_NAME = re.compile(r"^[a-z]{2}_[a-z0-9]{1,32}$")


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack", required=True, help="Kokoro voices pack (voices-v1.0.bin)")
    parser.add_argument("--voices-dir", required=True, help="Directory with <name>.npy bundled voices")
    return parser


def load_bundled(voices_dir: Path) -> dict:
    """Validates every bundled voice; raises ValueError on the first invalid one."""
    voices = {}
    for path in sorted(voices_dir.glob("*.npy")):
        name = path.stem
        if not VOICE_NAME.match(name):
            raise ValueError(f"invalid voice name: {name}")
        array = np.load(path, allow_pickle=False)
        if array.shape != STYLE_SHAPE or array.dtype != np.float32:
            raise ValueError(f"invalid voice array: {name}")
        if not np.isfinite(array).all():
            raise ValueError(f"non-finite voice array: {name}")
        voices[name] = array
    return voices


def merge(pack: Path, voices_dir: Path) -> list:
    """Returns the voices that were added or updated (empty when the pack is already current)."""
    if not pack.is_file():
        raise ValueError("voices pack not found")
    if not voices_dir.is_dir():
        raise ValueError("voices directory not found")
    bundled = load_bundled(voices_dir)
    with np.load(pack, allow_pickle=False) as archive:
        existing = {key: archive[key] for key in archive.files}
    changed = [name for name, array in bundled.items()
               if name not in existing or not np.array_equal(existing[name], array)]
    if not changed:
        return []

    merged = {**existing, **{name: bundled[name] for name in changed}}
    fd, tmp_name = tempfile.mkstemp(prefix=pack.name + ".", suffix=".tmp", dir=pack.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:  # file object: np.savez must not append ".npz"
            np.savez(handle, **merged)
        with np.load(tmp, allow_pickle=False) as check:
            if set(check.files) != set(merged):
                raise ValueError("merged pack has unexpected voices")
            for key in existing:
                if key not in changed and not np.array_equal(check[key], existing[key]):
                    raise ValueError("stock voice changed during merge")
            for name in changed:
                if not np.array_equal(check[name], bundled[name]):
                    raise ValueError("bundled voice mismatch after merge")
        os.replace(tmp, pack)
    finally:
        if tmp.exists():
            tmp.unlink()
    return changed


def main(argv=None) -> int:
    args = make_parser().parse_args(argv)
    try:
        changed = merge(Path(args.pack), Path(args.voices_dir))
    except (ValueError, OSError) as error:
        sys.stderr.write(f"add_voices failed: {error}\n")
        return 2
    sys.stdout.write(f"bundled voices: {', '.join(changed) if changed else 'already present'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
