# Bundled custom voice (`em_blocktype`)

## Objective

Ship the custom Spanish voice `em_blocktype` with the plugin so it is selectable everywhere and is
installed by the simple setup (`open-vox setup kokoro`), including on existing installs.

## Scope

- `resources/voices/em_blocktype.npy`: the style array (510x1x256 float32).
- `scripts/add_voices.py`: idempotent, atomic merge of bundled voices into `voices-v1.0.bin` (numpy only).
- `src/setup.ts`: `setupKokoro` runs the merge after the downloads, with the venv python.
- `src/config.ts`: catalog entry. The TUI and the CLI read that catalog.
- Tests: `test/python/test_add_voices.py`, `test/bundled-voices.test.ts`, `test/config.test.ts`.

## Decisions

- The voice data is not downloaded: the stock pack comes from the kokoro-onnx release and cannot carry it.
- The merge also runs when files already exist, so re-running `setup kokoro` upgrades an old install.
- A failed merge fails the setup: a catalog voice that cannot play is worse than a visible error.
- Stock voices are never rewritten; the merge verifies them before replacing the pack.

## Checklist

- [x] B01 Bundled asset and merge helper, with Python unit tests (7 tests).
- [x] B02 `setupKokoro` hook, with TypeScript tests (7 tests).
- [x] B03 Catalog entry and docs.
- [x] B04 Verified against a pristine 54-voice pack and the installed pack.

## Verification

- `python -B -m unittest discover -s test/python -p "test_add_voices.py"`: 7 tests, OK.
- `bun test`, `bun run typecheck`: see the delivery commit.
- Synthesis through `scripts/kokoro_say.py` with `--voice em_blocktype` produced audio; ECAPA speaker
  similarity to the source recordings was 0.917 (stock `em_alex`: 0.299), fundamental frequency 96 Hz.
  A listening check by the maintainer is separate.
