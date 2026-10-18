# Local reference speaker comparator

Status: VC-01 through VC-05 implemented and independently verified for backend/model behavior; real-browser and listening acceptance remain pending. Canonical memory project: `agentvoz`. Existing voice laboratory and plugin edits preserved.

## Objective

Extend the standalone lab with a local, optional speaker-embedding comparison between a user-provided single-speaker WAV reference and the exact generated WAV. This guides exploration of voice identity; it is not cloning, identity proof, a probability, a quality score, or a verified measure of JARVIS resemblance. No automatic parameter optimizer is included in this work unit.

## Selected model and costs

SpeechBrain `spkrec-ecapa-voxceleb`, revision `0f99f2d0ebe89ac095bcc5903c4dd8f72b367286`; model card Apache-2.0. Embedding checkpoint size 83,316,686 bytes; SHA256 `0575cb64845e6b9a10db9bcb74d5ac32b326b8dc90352671d345e2ee3d0126a2`. CPU inference on 16 kHz mono input. Python dependencies including CPU Torch may require several hundred MB; use an isolated lab environment, never modify installed plugin environments. Public package/weight downloads require no credentials. Serving must not download anything or execute remote YAML/custom model code.

## Tasks and route

- [x] VC-01 — Add explicit reproducible optional setup, isolated environment, reviewed architecture/configuration and pinned/hashes-verified weight bootstrap. Keep all downloaded assets/environment files ignored and out of commits.
- [x] VC-02 — Implement mono resampling, bounded windowing, normalized embeddings and cosine similarity; cache bounded reference data. Reject invalid/silent/short input, expose model availability and errors without inventing scores. Report durations/window spread as observations, not calibrated confidence.
- [x] VC-03 — Add protected local WAV reference/compare/clear routes without changing synthesis WAV response. Limit WAV bytes, decoded duration/channels/rate, stale reference IDs and concurrent work. Preserve Host/Origin defenses; no filesystem paths from browser.
- [x] VC-04 — Add reference upload, explicit Compare current audio, score details/warnings and clear reference controls. Scores belong only to the exact generated audio and reference; reset/replacement invalidates stale results.
- [x] VC-05 — Test fake embedding boundary cases and HTTP/UI schema, then real offline embeddings on the extracted reference and a candidate. Identical-audio self comparison validates the pipeline only, not perceptual calibration. Record cold/warm CPU timings and all unavailable/skipped checks.
- [ ] VC-06 — User-controlled restart and real-browser upload/compare/playback acceptance, followed by listening qualification. Automated metrics alone do not accept a voice preset.

All tasks use delegated direct: multi-file implementation/preparation requires one writer; independent verification uses a fresh read-only worker. Default test-first applies to meaningful deterministic tests. No commits, publishing, existing server shutdown or plugin profile changes are authorized. Size is advisory; no code compression or omitted tests for line targets.

## Scope

Source: `tools/voice-lab/{server.py,index.html,test_server.py,README.md,comparator.py,test_comparator.py,setup_comparator.py,requirements-comparator.txt,.gitignore,model-provenance.json}`. Tracking: this document and `odd/tasks/voice-lab.md`. Runtime-only bootstrap outputs: `tools/voice-lab/.venv-comparator/` and `tools/voice-lab/.models/`, ignored before creation. Do not change root package manifests, locks, plugin files, installed settings or existing model assets.

## Verification and limits

Keep optional comparison failures isolated: existing synthesis remains functional without comparison dependencies/weights. No online fallback during serving. Load weights safely with `weights_only=True`, on CPU, strict state dictionary validation; do not load remote YAML. Input filtering does not establish single-speaker purity; users must supply appropriate reference and permission. Clear reference removes its in-memory data. Cross-language/phrase/channel differences and short synthetic speech limit score interpretation.

Reference available locally: the previously authorized 50-second mono extraction under the approved temporary directory. No reference or generated audio may be uploaded externally. UI automation may be unavailable; record it honestly.

## Progress

Next: user-controlled restart and real-browser/listening acceptance. The writer did not stop/restart the user-owned port 8765 server. The independent verifier used an owned transient server on port 8766, verified comparison and synthesis, and stopped only that server. Restart with `.venv-comparator/Scripts/python.exe -B server.py` is required for the updated UI/routes and comparison runtime.

Engram mirror `odd/voice-lab-comparator/tasks`: pending existing MCP ambiguity; local document authoritative, never substitute a status-provider project.

## Observed writer verification (2026-10-14)

`skill_resolution: paths-injected`; exact paths read before source:

- `<skills-root>/context7/SKILL.md`
- `<skills-root>/work-unit-commits/SKILL.md`
- `<skills-root>/cognitive-doc-design/SKILL.md`

The registry and this task were read first. CodeGraph had no index and explicitly directed scoped filesystem fallback; no index/root settings were created. Technical artifacts are English. No staging, commits, branch creation, publishing, plugin environment changes or edits outside authorized sources/tracking. Initial/final dirty-file status retained the preexisting plugin/tone changes and caches.

| Check | Actual result |
| --- | --- |
| Initial `test_comparator.py` before module creation | RED: missing comparator import, exit 1 |
| Fake HTTP endpoint tests before route implementation | RED: six failures on missing routes/404, plus one Windows TCP close race in an existing early-rejection test |
| Initial comparator GREEN in old environment | Eight tests, one optional SciPy skip, 0.132 s |
| Final isolated `python.exe -B -m unittest discover -s tools/voice-lab -p 'test_*.py'` | **42 tests, no skips/failures, 8.008 s**, exit 0; includes all original 22 tests |
| Final original Kokoro environment, same discovery | **42 tests, one SciPy skip, 7.579 s**, exit 0 |
| Full `bun test` (once) | **621 passed, 5 skipped, 0 failed**, 626 across 23 files, 12.41 s |
| `bun run typecheck` (once) | `tsc --noEmit`, exit 0 |
| Original environment full Python regression (once), `-B -m unittest discover -s test/python -p 'test_*.py'` | **143 tests, four skipped, 1.323 s**, exit 0 |
| `git diff --check` | Exit 0, existing LF/CRLF warnings only; does not check untracked files |
| Scoped `git diff --no-index --check -- /dev/null <path>` for all twelve authorized files | No whitespace errors; exit 1 per differing file, with LF/CRLF warnings only |
| `git check-ignore` for environment interpreter / checkpoint | Both runtime paths ignored; `git ls-files --others --exclude-standard -- tools/voice-lab` lists only the ten authorized source files |

The actual UI script is exercised in an offline Bun DOM harness for exact Blob submission, reset suppression of in-flight results, raw cosine display, unchanged audio score after settings edits, replacement and clear. This is not real-browser rendering/playback. Initial harness failed on Windows default CP1252 encoding; explicit UTF-8 fixed it. Early-rejection HTTP probes now send headers without a body, proving rejection before reads and avoiding Windows races when the server closes with unread upload data. Clients that send a body despite pre-body rejection may observe TCP close rather than a readable error; this limitation is documented.

Deterministic coverage includes normalized means/cosine/negative cosine, zero/cancelled/nonfinite/wrong-size embeddings, PCM widths, stereo/downmix/resampling, silence/short/long/rate/channel limits, RIFF sizes/truncation, ≤20 windows, optional dependency/weight absence, exact routes, host/origin/duplicate headers, missing reference IDs, body-size/header bounds, stale replacement/clear IDs, busy concurrency across synthesis/comparison, release after exceptions, sanitized 503 and unchanged synthesis without comparison assets. Setup checks approved public package hosts, complete pinned reports and a strict download budget; no network runs in normal tests.

## Bootstrap and real local sanity

Pinned public model card/YAML were fetched only as data. Fixed constructors match the configuration; no remote YAML was saved/executed, and classifier/label/global normalization assets were intentionally excluded. Model state loaded strictly with CPU `weights_only=True`. `model-provenance.json` records source URLs, revision, exact bytes and SHA256.

First metadata-only resolution found Torch `2.14.1+cpu` lacked matching torchaudio. A single compatible correction to the publicly available `2.11.0+cpu` pair resolved with SpeechBrain `1.1.1`, SciPy `1.18.1`, NumPy `2.5.3`, soundfile `0.14.0`, onnxruntime `1.31.0`, kokoro-onnx `0.6.1`; all 48 resolved packages are pinned. A pip dry-run report was kept only in approved temporary storage. HEAD measurements observed 211,154,022 wheel bytes plus 83,316,686 checkpoint bytes = **294,470,708 bytes**, below the 1-GB decision threshold. Some wheels came from cache; this is total asset size, not measured WAN traffic. Installation used standard public binary pip packages, no remote project scripts.

Explicit setup created only the ignored lab environment/model directory. `pip check` reported no broken requirements. Environment files measured **904,904,401 bytes**, plus the **83,316,686-byte** verified checkpoint and standard pip cache overhead. Checkpoint SHA256 matched `0575cb64845e6b9a10db9bcb74d5ac32b326b8dc90352671d345e2ee3d0126a2`. Existing plugin models/environments were not overwritten.

Real command (no server launch/audio upload/synthesis):

```powershell
& "tools/voice-lab/.venv-comparator/Scripts/python.exe" -B tools/voice-lab/test_comparator.py --real-reference "<local-reference-audio>"
```

Socket `connect`/`connect_ex` were blocked during model import/loading and both analyses. Local 50.0-second / 44.1-kHz mono audio yielded 17 windows, 50.0 used seconds, self cosine **1.0**. Cold load+analysis **2.5920076 s**, warm analysis **0.5604569 s**, two Torch threads. Peak process working set **484,134,912 bytes**; observed current working set **466,436,096 bytes**. All 289 window pairs had observed min −0.0835345, max 1.0, mean 0.5204094, std 0.2685691, illustrating that pair spread is not calibrated confidence even for identical full audio. This validates preprocessing/model/aggregation only; no perceptual winner, purity, cloning or resemblance claim.

Remaining: browser layout/file-upload/playback/download checks and listening. No hard inference cancellation/deadline or OS-level air-gap guarantee is claimed. RAM cache stores only one ≤20×192 embedding summary, not PCM/history; transient decoded buffers and process/model memory are separate. Source file consent/single-speaker selection remains the user's responsibility.

## Independent model and HTTP verification

- Fresh verifier and parent spot check each reproduced **42 lab tests, no skips or failures**. Independent typecheck and manifest/lock unchanged checks passed. The full regression results above remain writer-observed, not independently rerun.
- Actual server bound to `127.0.0.1:8766`; foreign Host rejected with 403 before loading. Uploaded reference: 50 seconds, 17 windows. Same-audio comparison: cosine 1.0. Existing `am_onyx_w075.wav`: 24.106667 seconds, eight windows, raw cosine **0.3005419000** against that reference. This is neither a probability nor a perceptual likeness percentage.
- Cold reference upload: approximately 2.212 seconds; warm same-audio comparison: 0.583 seconds; candidate comparison: 0.287 seconds on this host. Timings are observations, not latency guarantees.
- Reference clear returned success; old ID subsequently returned 409 `stale_reference`; status showed no reference. Real Spanish synthesis in the isolated environment produced a valid mono PCM16 24 kHz WAV with 105,984 samples (4.416 seconds).
- Before/after SHA256 hashes matched for the voicepack, Kokoro ONNX model and comparator checkpoint. The probe blocked non-loopback socket connections in process; no OS-level air-gap claim. No severe candidate flaw was found in inspected scope.
- Owned probe server stopped in `finally`; its port closed and PID no longer existed. User-owned 8765 remained untouched. No visual browser or listening acceptance was performed.

Engram save to canonical `agentvoz` was attempted and rejected with unrelated `status-provider-baseline` / `status-provider-dev` ambiguity. No substitute project was selected; this document remains authoritative.
