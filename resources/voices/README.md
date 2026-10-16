# Bundled voices

Custom Kokoro voices shipped with open-vox. Each `<id>.npy` is a float32 style array of shape
`(510, 1, 256)`, the same layout as the stock voices in `voices-v1.0.bin`.

`open-vox setup kokoro` merges every file in this directory into the voices pack through
[`scripts/add_voices.py`](../../scripts/add_voices.py). The merge is idempotent, never modifies the
stock voices and replaces the pack atomically. Re-run `open-vox setup kokoro` on an existing
install to receive a newly bundled voice.

A voice id must start with `e` for Spanish (that prefix selects the Spanish phonemizer), and it must
also be listed in `KOKORO_VOICES` in `src/config.ts`; a test enforces that every file here is in the
catalog.

| Id | Language | Gender | Provenance |
| --- | --- | --- | --- |
| `em_blocktype` | Spanish | male | Style vectors optimized on top of the stock Kokoro `em_alex` voice (Kokoro-82M, Apache-2.0) against a speaker embedding of the maintainer's own recordings. Published with the maintainer's consent. The model weights are not modified. |

## Adding another voice

1. Produce a `(510, 1, 256)` float32 array and save it with `numpy.save(<id>.npy, array, allow_pickle=False)`.
2. Add the file here and a `voice(...)` entry to `KOKORO_VOICES`.
3. Run `bun test` and the Python tests (`python -B -m unittest discover -s test/python -p "test_add_voices.py"`).
