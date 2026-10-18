# Local experimental voice lab

A standalone browser panel for short Kokoro style experiments, with an optional local speaker-embedding comparator. It does not integrate with the plugin, change settings, modify existing voice assets or upload audio externally. Text and WAVs go only to the local Python process. Optional setup explicitly installs a separate ignored environment and downloads one public checkpoint; serving never downloads assets.

## Launch

From `<project-root>`, run in the foreground:

```powershell
& "<local-kokoro-python>" -B tools/voice-lab/server.py
```

Open **http://127.0.0.1:8765/**. Stop with **Ctrl+C**. Optional `--port 8766` changes only the port, never the loopback bind. CLI-only `--model` and `--voices` arguments may select trusted local assets; browser presets cannot select filesystem paths.

Defaults use `%LOCALAPPDATA%\open-vox\kokoro\kokoro-v1.0.onnx` and `voices-v1.0.bin`. The existing environment must already contain NumPy, soundfile and kokoro_onnx. Startup loads the NPZ voicepack with `allow_pickle=False`, caches immutable source arrays and serves voice names without constructing Kokoro. The first Generate initializes the model; subsequent requests reuse that successful instance. Startup success alone does not prove model or phonemizer readiness.

## Optional comparator: setup and launch

Use Windows CPython 3.13 (observed 3.13.15). Direct and transitive versions are pinned in `requirements-comparator.txt`. Public downloads need no credentials: PyPI, the official CPU Torch index/CDN and the pinned Hugging Face model. Setup stops for an unknown or greater-than-1-GB estimate. No plugin environment or existing asset is modified.

```powershell
# Resolve and measure only; no installation.
& "<local-kokoro-python>" -B tools/voice-lab/setup_comparator.py --estimate

# Explicit installation and model download; neither occurs on import.
& "<local-kokoro-python>" -B tools/voice-lab/setup_comparator.py --install --download-model

# User-controlled launch with optional comparison enabled.
& "tools/voice-lab/.venv-comparator/Scripts/python.exe" -B tools/voice-lab/server.py
```

**An already-running server does not acquire new routes or a new environment.** The writer did not stop/restart port 8765. Restart your own lab when ready, using the last command; alternatively explicitly select an unused `--port`. No service/background server is installed. The old Kokoro environment remains usable for synthesis with comparison unavailable. Invalid existing checkpoints are not overwritten; bootstrap failure leaves a partial ignored environment, never a fabricated success. Runtime `.venv-comparator/` and `.models/` are ignored before creation.

Observed bootstrap, 2026-10-14:

| Item | Observed result |
| --- | --- |
| Comparison packages | Torch / torchaudio `2.11.0+cpu`, SpeechBrain `1.1.1`, SciPy `1.18.1` |
| Synthesis packages in isolated environment | NumPy `2.5.3`, soundfile `0.14.0`, onnxruntime `1.31.0`, kokoro-onnx `0.6.1` |
| HEAD-measured wheels + checkpoint | 211,154,022 + 83,316,686 = **294,470,708 bytes**; cached wheels reduce actual network transfer |
| Installed environment file bytes | **904,904,401 bytes**, plus checkpoint and additional standard pip cache disk usage |
| Dependency check | `pip check`: no broken requirements |
| Real offline sanity | 50 s / 44.1 kHz mono local reference; 17 windows; self cosine **1.0** |
| CPU / memory observation | Cold 2.592 s, warm 0.560 s; two Torch threads; peak process working set **484,134,912 bytes** |

These are host observations, not latency/RAM guarantees. Torch 2.14.1 had no matching torchaudio wheel; the available 2.11.0 CPU pair resolved and passed actual inference. No GPU packages were selected. The sanity check blocked socket `connect`/`connect_ex` in-process; this is not OS-level air-gap proof or perceptual acceptance.

## Compare current audio

1. Select a **single-speaker WAV you own or have permission to use**, check the permission note and explicitly upload locally. File selection alone does not upload. Accepts RIFF PCM 8/16/24/32-bit, one/two channels, 8–192 kHz, 2–60 seconds and ≤10 MiB. Float/compressed/extensible WAV, truncation and near-silence are rejected. No video decoder or ASR is added.
2. Generate a sample and explicitly press **Compare current audio**. The retained exact generated Blob is compared, not current slider settings or regenerated speech.
3. Read raw cosine [−1,+1], reference ID, durations/window counts and observed pair-window spread. This is **not** probability, identity proof, speech quality or calibrated perceptual resemblance. Phrase, language, channel, short clips and synthetic/real domain differences matter. Manual comparison does not start a search.
4. Clear removes the server reference summary; replacement creates a new opaque ID and invalidates old comparisons. Failed replacement preserves the previously valid reference. Scores clear on upload attempts, clear, new generation and Reset all. Settings alone do not alter current audio or its labelled score. Async revision guards suppress stale responses.

Server cache contains one reference summary only: at most 20 × 192 float64 embeddings, approximately 32 KiB with the mean vector, plus metadata; no reference WAV/audio history is retained. Raw/decoded buffers are transient and bounded by upload, duration and channels. Model/process RAM is separate. The browser retains the selected File/current audio Blob until replacement/reset/clear/page closure. Clear is not secure memory erasure and does not delete the source file. Energy filtering does not establish consent or single-speaker purity.

### Model and preprocessing

`model-provenance.json` records the reviewed public model card (Apache-2.0), pinned configuration, constructors, revision `0f99f2d0ebe89ac095bcc5903c4dd8f72b367286`, checkpoint size 83,316,686 bytes and SHA256 `0575cb64845e6b9a10db9bcb74d5ac32b326b8dc90352671d345e2ee3d0126a2`. Only `embedding_model.ckpt` is downloaded. Serving rechecks size/hash and uses CPU `torch.load(weights_only=True)` with strict state matching.

Public YAML was read as data, not stored/executed. Fixed constructors: `Fbank(n_mels=80)`, `InputNormalization(norm_type="sentence", std_norm=False)`, ECAPA_TDNN input 80, channels `[1024,1024,1024,1024,3072]`, kernels `[5,3,3,3,1]`, dilations `[1,2,3,4,1]`, attention 128 and output 192. Classifier/labels/global normalization are unused, matching `encode_batch(normalize=False)` followed by explicit L2 normalization. No `from_hparams`, remote YAML/custom code or serving-time download fallback. Optional imports and model loading are lazy.

Both inputs use identical arithmetic stereo downmix and SciPy bandlimited `resample_poly` to 16 kHz. Sequential non-overlapping windows are 2–3 seconds, at most 20; tails under 2 seconds are dropped. At least one second of samples must exceed amplitude `1e-4`; each retained window RMS must exceed `1e-4`. This heuristic is **not VAD, diarization or automatic cleaning**. Finite 192-vectors are L2-normalized, averaged and renormalized; invalid/zero/cancelled vectors fail without scores. Cosine/pair dots are clamped numerically to [−1,+1]. Pair spread uses all retained window combinations, not temporal alignment or statistical confidence.

## Run an explicit bounded search

Leave any existing user-owned server on 8765 untouched. To use the new routes in a separately owned foreground session, launch the already installed isolated environment (no setup or downloads):

```powershell
& "tools/voice-lab/.venv-comparator/Scripts/python.exe" -B tools/voice-lab/server.py --port 8766
```

Open **http://127.0.0.1:8766/**. Use only an unused port and stop only this owned process with Ctrl+C.

1. Upload a permitted reference, or use the current reference shown by this server. Choose a sentence long enough to synthesize 2–60 seconds of usable audio. Text, language, voices, speed, initial offsets and reference are frozen at Start.
2. Select **2–32 trials** (UI default **12**, baseline included), an unsigned 32-bit seed (default 0), and optionally **Advanced** offsets. Press **Start search** explicitly. Each trial performs sequential local synthesis and embedding computation; timing is uncertain, potentially seconds to minutes per job. There are no automatic retries, startup-triggered searches or continuous loops.
3. Inspect successful/attempted counts, baseline and best **raw cosine**, history and elapsed time. The unchanged preset is evaluated first. A coarse 3×3 weight lattice precedes seeded local proposals around the best actually evaluated preset; duplicates are skipped in a finite proposal loop. Same seed/configuration and deterministic callbacks reproduce proposals; real model determinism is not promised.
4. **Cancel search** requests cooperative cancellation. A running evaluation finishes and may update the best/count before `cancelled`; model inference is not killed. Generate, reference upload/clear and Reset all are disabled until terminal status. Leaving the page stops polling, not the bounded server job; reload recovers the retained job. Network/status failures stop automatic polling; Refresh is explicit.
5. After a terminal result, **Apply best preset and load exact WAV** explicitly replaces controls and loads the evaluated WAV into the main player/download link; it does not regenerate or autoplay. Manual Compare then sends that exact retained Blob. **Download best preset JSON** exports the evaluated preset, not subsequent slider edits. A later failed candidate may leave an earlier valid best; baseline failure produces no best or invented score.

Default search changes only timbre/prosody weights. Donor Off is rejected unless Advanced is enabled, in which case only offsets change. Advanced proposals alter four eligible components from the full 256 using signed steps 0.025, 0.05 or 0.1, bounded to [−2,+2]; local weight steps are 0.025–0.1 and weights remain [0,1]. Source arrays and the frozen initial preset are never mutated. This limited heuristic does not explore every value/component, prove a global optimum or measure perceptual quality. Listen and test additional sentences: optimizing one phrase can overfit.

### Search HTTP contract

All existing Host/Origin protections, exact JSON parsing and the **32 KiB** POST limit apply. Complete `preset` is the version-1 schema below; `referenceId` is the current 32-character lowercase hex server ID. All five search fields are required, with no extras; numeric integers reject booleans. Browser controls supply defaults, but HTTP callers must provide them explicitly.

```javascript
const start = await fetch('/api/search/start', {
  method: 'POST', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({preset, referenceId, trials: 12, seed: 0, advancedOffsets: false})
});
// 202: {jobId, referenceId}; do not blindly retry a lost start response.
```

| Route | Behavior |
| --- | --- |
| `POST /api/search/start` | Validates preset/style compatibility, reference and comparator availability; reserves the shared gate nonblockingly and returns 202. |
| `GET /api/search/<jobId>` | State (`running`, `cancelling`, `completed`, `cancelled`, `failed`), attempts/completed/trials, seed/mode, baseline/best score, exact best preset or null, ≤32 scalar history rows, elapsed time, reference ID, warnings/model/revision and sanitized error. No base64 WAV. |
| `POST /api/search/<jobId>/cancel` | Exact JSON `{}`; idempotent for terminal jobs, no queued evaluation. |
| `GET /api/search/<jobId>/audio` | Exact retained best PCM WAV after terminal status; 409 `no_best` without success or `job_active` before terminal. |
| `GET /api/comparator/status` | Also includes retained `search` identity/state/reference or null for lost-response/page reload recovery. |

One active worker and one retained job only. A new accepted job replaces terminal results; old IDs become **404 `unknown_job`**, including old audio/cancel routes. Active synthesis/reference/comparison/search competitors receive **429 `busy`**. A missing/replaced reference is **409 `stale_reference`**; unavailable comparator **503 `comparator_unavailable`**; invalid search **400 `invalid_search`**. Workers release the gate in `finally`; status/cancel never wait for model callbacks. The first evaluation failure stops without retries and reports `failed`, preserving only earlier successful results. Candidate scores must be finite [−1,+1] with valid duration/window metadata; too-short synthesis fails gracefully.

Only scalar history, frozen request, exact best preset and **one WAV ≤10 MiB** are retained, plus the existing reference/model caches. Nonwinning WAVs and reference snapshots are transient; no search audio/history is written to disk or uploaded externally. Source models/settings remain unchanged. Browser result downloads occur only when explicitly requested.

## Use

1. Choose a sentence, synthesis language, base and donor. Defaults are Spanish, `em_alex`, `am_onyx`, zero blend weights and rate 1. If these voices are absent, the UI falls back to the first available base and donor Off.
2. Adjust independent timbre/prosody blend weights. Zero leaves that base half unchanged; one replaces it with the donor half. Donor Off resets and disables both weights.
3. Optionally expand the advanced component groups. All 256 offsets are raw experimental deltas from −2 to +2, applied uniformly along the final tensor axis after blending. They are not named semantic controls, and the halves are not guaranteed to be audibly independent.
4. Press **Generate & play**. If browser playback is blocked, press Play in the native audio control. A playback restriction does not invalidate the generated WAV.

Changing a slider or importing a preset does **not** alter existing audio. Reset all restores the default sentence, voices, language, rate, zero weights and zero offsets, and clears current audio. Reset offsets changes only the offsets. Preset files are parsed in the browser; their raw file contents are never uploaded. A later Generate sends the validated request values.

## HTTP contract

Exact synthesis routes remain `GET /`, `GET /index.html`, `GET /api/metadata` and `POST /api/synthesize`. Metadata contains `version`, `voices`, `languages`, `maxText` and `defaultText`. Synthesis still returns `audio/wav` bytes on success or a JSON `error` message on failure.

Every route requires one literal Host `127.0.0.1:<actual-port>` or `localhost:<actual-port>`. If Origin is supplied, it must exactly match either corresponding `http://` origin (no trailing slash). Foreign/duplicate hosts/origins are rejected before inference; no CORS wildcard. Every POST requires one bounded Content-Length and no Transfer-Encoding. Synthesis requires `application/json`, ≤32 KiB, nonblank text up to 500 characters and an exact schema.

Additional protected routes:

| Route | Request / successful JSON response |
| --- | --- |
| `GET /api/comparator/status` | Availability, `state` (`unavailable`, `not_loaded`, `ready`), model/revision, limits/warnings and current `reference` or null. `not_loaded` is provisional presence, not runtime validation. |
| `POST /api/reference` | Raw `audio/wav`, ≤10 MiB; `referenceId`, `durationSeconds`, `usedSeconds`, `windowCount`. |
| `POST /api/compare` | Raw candidate `audio/wav`, ≤10 MiB; exactly one current `X-Reference-Id`. Response: `cosine`, `referenceId`, `reference`/`candidate` metadata, `model`, `revision`, `pairWindowSpread` (`min`, `max`, `mean`, `std`, `count`) and `warnings`. |
| `POST /api/reference/clear` | `application/json` body **`{}`**, ≤32 KiB; `{"reference": null}`. |

Comparison errors are JSON `error` plus typed `code`: 400 `invalid_input`, 408 `body_timeout`, 409 `stale_reference`, 429 `busy`, 503 `comparator_unavailable`. There are no fake scores. Type/size/boundary failures use 415/413/403. Errors never echo input or filesystem paths. Query strings/arbitrary paths do not match. Header bounds/types/duplicates are checked before reads. One shared nonblocking gate covers WAV reads/decoding, reference mutation, model loading/inference and synthesis; metadata/status remain responsive. A slow upload can hold the gate for the 10-second body timeout. Busy uploads are rejected without body allocation; a client sending data despite pre-body rejection can observe TCP close rather than a readable error response.

Browser example (the browser supplies Content-Length):

```javascript
const upload = await fetch('/api/reference', {
  method: 'POST', headers: {'Content-Type': 'audio/wav'}, body: referenceFile
});
if (!upload.ok) throw new Error('Reference upload failed.');
const {referenceId} = await upload.json();
const comparison = await fetch('/api/compare', {
  method: 'POST', headers: {'Content-Type': 'audio/wav', 'X-Reference-Id': referenceId},
  body: retainedGeneratedWavBlob
});
```

Request/preset shape (the following JavaScript expression constructs the complete JSON object):

```javascript
const preset = {
  version: 1,
  text: 'Los sistemas claros nos ayudan a pensar mejor y a construir con confianza.',
  baseVoice: 'em_alex',
  donorVoice: 'am_onyx', // null means Off and requires zero blend weights
  timbreWeight: 0,      // finite number in [0, 1]
  prosodyWeight: 0,     // finite number in [0, 1]
  speed: 1,            // finite number in [0.5, 2]
  lang: 'es',          // es, en-us or en-gb; never forced from donor
  offsets: Array(256).fill(0) // exactly 256 finite numbers in [-2, 2]
};
fetch('/api/synthesize', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(preset)
});
```

Boolean numeric fields, nonfinite values, duplicate JSON fields, unavailable voices and incompatible active donor shapes are invalid. Blending requires identical base/donor shapes with a final dimension of 256. Each generated style is an owned float32 copy, so even model-side mutation cannot overwrite cached source arrays. Source assets are never written.

## Limits and failures

One nonblocking inference lock covers style preparation, lazy initialization, inference and WAV encoding. A second generation receives **429**, not a queued inference job. Metadata remains available during inference. The browser prevents duplicate clicks, stops waiting after 120 seconds and reports network/server failures; request-body reads on the server have a 10-second timeout. **There is no hard model-inference deadline or cancellation guarantee.** Aborting a browser request does not stop CPU inference; wait before retrying. Ctrl+C stops this standalone process.

This is a local experimental stdlib HTTP server, not an authenticated multi-user service. Loopback/Host/Origin checks protect the browser boundary, not against malicious programs running under the same local account. Large offsets can produce poor speech. No auditory acceptance or perceptual similarity is claimed.

## Deterministic checks

```powershell
& "<local-kokoro-python>" -B -m unittest discover -s tools/voice-lab -p test_server.py
& "tools/voice-lab/.venv-comparator/Scripts/python.exe" -B -m unittest discover -s tools/voice-lab -p "test_*.py"
# Explicit real local sanity check, with socket connections blocked in-process.
& "tools/voice-lab/.venv-comparator/Scripts/python.exe" -B tools/voice-lab/test_comparator.py --real-reference "<local-reference-audio>"
```

Tests use fake model output, immutable source arrays and ephemeral servers bound to `127.0.0.1`, all closed in teardown. They exercise validation, math, language forwarding, lazy model caching, PCM16 WAV output, active-inference busy responses, sanitized failures and HTTP boundaries. They do not load ONNX or prove browser playback or real synthesis. See `odd/tasks/voice-lab.md` for observed RED/GREEN and regression results; independent real-model/browser verification is tracked as VL-05.

Comparator tests use fake embeddings and no network. SciPy resampling skips explicitly in the old environment. A Bun-backed DOM harness executes the actual UI script with fake fetch to verify exact Blob retention, reset/stale-score suppression, replacement and clear; it does not prove real-browser layout/playback. The explicit real smoke validates identical-audio consistency only. Independent real HTTP checks verified reference upload, same-audio and generated-candidate comparison, clear/stale-reference behavior and unchanged synthesis. Listening and real-browser acceptance remain pending; observed evidence is recorded in `odd/tasks/voice-lab-comparator.md`.

Search checks add deterministic seed/budget/baseline/best identity, clipping/frozen fields, blocked-callback cancellation, partial failures, invalid metadata/scores, WAV cap, protected ephemeral HTTP routes, whole-job resource exclusion, stale IDs and exact returned best audio. The same Bun DOM harness checks active controls, cancellation, terminal polling stop and explicit best loading/export state. Search implementation evidence and pending independent four-trial real search are tracked in `odd/tasks/voice-lab-search.md`; no real-model search, visual acceptance or auditory acceptance is claimed by these mocked checks.

Delivery route: standalone delegated direct, not SDD; no commit, staging or publishing. Comparator rollback removes only its added files/ignored runtime directories, comparison UI/routes/tests and scoped documentation additions, preserving the original synthesis lab and unrelated plugin/tone work. Preserve any user-owned runtime server until the user explicitly stops it.
