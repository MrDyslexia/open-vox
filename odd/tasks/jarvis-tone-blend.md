# Open-Vox — JARVIS tone blend for Kokoro narration

**Status: IN PROGRESS / IMPLEMENTATION AUTHORIZED.** Updated: 2026-10-14. Display project: Open-Vox; canonical Engram project: `agentvoz`.
Implementation was authorized by the maintainer after the exploratory spike below. Python and TypeScript implementation is present; full TypeScript verification is blocked by missing local Markdown dependencies, and auditory acceptance remains pending. Branch: `feat/jarvis-tone-blend` (base `ce2e794`). No implementation commit is recorded.

## Objective and acceptance requirements

Give Spanish narration a JARVIS-like tone (grave, monotone, deliberate) without adding a second TTS engine, a voice clone, or a finetune. Kokoro exposes no pitch, emotion, or SSML parameter, and Spanish has only three voices (`ef_dora`, `em_alex`, `em_santa`), none of which fit. The only in-model lever is the style vector.

| ID | Requirement |
| --- | --- |
| JT-01 | Blend only the prosody half of the Kokoro style vector: keep `[..., :128]` (decoder reference, timbre) from the configured voice and interpolate `[..., 128:]` (prosody/text-encoder style driving F0, duration, energy) toward a donor voice by a weight. |
| JT-02 | Keep the donor voice independent of narration language. `--lang` must keep deriving from the timbre voice, not the donor. This fixes phonemizer selection but does not guarantee the embedding cannot affect perceived accent. |
| JT-03 | Expose the blend per language through config and CLI, with the donor and weight persisted and validated. Default must be blend-off so existing behavior is unchanged. |
| JT-04 | Expose blend weight as experimental style interpolation and `speed` as separate synthesis rate control. Weight also changes predicted duration, so the controls are not physically orthogonal and no specific pitch or monotone outcome is guaranteed. |
| JT-05 | Do not modify `voices-v1.0.bin`. The blend is computed at synthesis time so the weight stays tunable and the downloaded asset stays reproducible. |

## Verified current behavior

Source inspection on 2026-10-14 against `ce2e794`, plus an exploratory audio spike. Historical measurements are limited-sample rough autocorrelation estimates, not validated pitch measurements or perceptual JARVIS acceptance. Current implementation evidence is recorded below.

| Finding | Evidence |
| --- | --- |
| Plugin and CLI `say` narration dispatch through Kokoro's plan path, which resolves a voice style and passes an ndarray to `create`. | `src/plugin.ts` (`liveEngine`, `createLiveSink`, `speakOnce`); `scripts/narration_synthesis.py` (`synthesize_envelope`) |
| A direct plain-text API route still exists and passes a voice name. Python only blends plans; TypeScript deliberately emits no tone flags for direct text. Piper/SAPI do not blend. | `scripts/kokoro_say.py` (`main`); `src/kokoro-engine.ts` (`commandFor`) |
| espeak language is derived from the configured base voice alone. Donor selection does not change that argument; perceived accent still requires listening. | `src/config.ts` (`kokoroLanguageCode`); `src/kokoro-engine.ts` (`commandFor`) |
| Voice validation is a closed, language-partitioned whitelist over a 31-entry catalog. A donor from another language fails it, so the donor needs separate validation. | `src/config.ts:36-46,60-61,75-76`; `src/cli.ts:153` |
| `parseConfig` is a strict allow-list: unknown keys are dropped on read and destroyed by the next `writeConfig`. A new field that is not added to the allow-list cannot survive a round-trip. | `src/config.ts:72-81`; `test/config.test.ts:53,79` |
| The Kokoro CLI argument array is asserted byte-for-byte, so unconditional new flags break it. Emitting flags only when the blend is active keeps the default-path assertions green. | `test/kokoro-engine.test.ts:171-180,184,192` |
| Runtime style tensors are `(510, 1, 256)` float32, matching the on-disk `.npy` and contradicting the 2D shape implied by the kokoro-onnx docs. Splicing via `[..., 128:]` is correct for either rank. | measured: `get_voice_style('em_alex').shape` |
| Synthesis assets and interpreter already present locally; no new dependency is required. | `%LOCALAPPDATA%\open-vox\kokoro\{kokoro-v1.0.onnx,voices-v1.0.bin}`; `%LOCALAPPDATA%\open-vox\kokoro-venv` |

## Exploratory spike observations

Timbre `em_alex`, `speed=0.9`, `lang=es`, long text inside the 100-200 token range from `VOICES.md`. Baseline is unblended `em_alex`: estimated F0 median 127.0 Hz, estimated F0 spread 62.8 Hz, 23.1 s. These values were supplied from the earlier spike, not remeasured in this implementation session. They do not establish perceptual resemblance or predictor destabilization.

| ID | Measured finding |
| --- | --- |
| JT-06 | Reported duration rose monotonically with weight at identical `speed` (+17.7% from w=0 to w=1) in this sample. Blend weight is therefore not duration-independent. |
| JT-07 | The reported sweep of 25 male donors ranked `am_onyx` best on the exploratory metrics at w=1.0: estimated F0 87.0 Hz (-40.7), spread 30.7 Hz, longer duration. `bm_lewis` had estimates of 99.6 Hz and spread 52.6 Hz. Neither ranking establishes listening quality. |
| JT-08 | `bm_george` ranked 21 of 25 (estimated F0 +12.3 Hz). Accent or gender labels alone did not predict the measured result. |
| JT-09 | A separate reported weight sweep found the smallest estimated spread at **w=0.75** (29.7 Hz, -53% vs baseline, estimated F0 93.8 Hz), versus 37.1 Hz at w=1.00. This does not prove predictor destabilization. Suggested experimental preset: `am_onyx`, `0.75`; shipped defaults remain empty donor and zero weight. |

## Implementation tasks

Python first, so the blend can be exercised by flags before TypeScript config exists. TypeScript followed the default test-first policy; no strict TDD mode was explicitly configured. Python uses stdlib `unittest`, not pytest. Verification commands and observed limits follow the checklist.

- [ ] JARVIS tone blend — implementation authorized on branch `feat/jarvis-tone-blend`.
  - [x] JT-10 — Python parser defaults to empty donor and weight `0.0`; finite range/pack validation and plan keyword forwarding are implemented. Existing new `ToneArgumentTests` and plan stub tests cover these paths. Parent reported 140 tests, 4 skips; current regression independently reproduced that result. No commit recorded.
  - [x] JT-11 — Python copies the base style, checks donor shape, interpolates only `[..., 128:]`, preserves dtype and skips donor resolution when off. Existing new `ToneBlendTests` cover rank, shape, off, copy and synthesis behavior. Same 140-test/4-skip regression evidence; no commit recorded.
  - [x] JT-12 — Added per-language `toneVoice`/`toneWeight` with off defaults and partial nested patches; config round-trip and sibling preservation passed deterministic Bun tests.
  - [x] JT-13 — Added catalog-wide donor and finite inclusive `[0,1]` weight validation to strict parsing and persistence. Invalid tone patches preserve stored valid values. Identity voices remain language-restricted. Config tests passed.
  - [x] JT-14 — Added exact-arity `tone`, `tone es|en`, set and off forms. Empty/nonfinite/out-of-range weights and invalid donors are rejected before writing. CLI tests passed.
  - [x] JT-15 — Help/status/reset include tone; help separates style interpolation from rate control and notes duration effects. CLI tests passed; README documents plan-only scope and default-off behavior.
  - [x] JT-16 — Engine samples optional tone settings per language per utterance and emits flags after `--out`, before the plan tail, only for valid active plans. Default factory threads persisted tone. A dependency-independent transport harness passed 16 assertions, including legacy/off equivalence and direct-route suppression. Engine/wiring test files are added but could not load in the requested suites; full regression acceptance is not claimed.
  - [ ] JT-17 — Maintainer listening acceptance of a chosen preset, including perceived accent and duration, remains pending. Shipped defaults remain off; `am_onyx 0.75` is only a suggested preset.

### Observed implementation verification (2026-10-14)

- Focused RED, before TypeScript implementation: `bun test test/config.test.ts test/cli.test.ts test/kokoro-engine.test.ts test/wiring.test.ts` — **71 pass, 9 fail, 2 errors**. Config/CLI behavior failed as expected; engine/wiring imports were blocked by missing `mdast-util-from-markdown`.
- Same focused command after implementation: **78 pass, 2 fail, 2 errors**. Config and CLI behavior is green; the two failed file loads remain dependency-blocked. This is not a fully green focused suite.
- Isolated `bun test test/config.test.ts test/cli.test.ts` — **78 pass, 0 fail**, exit 0. Final reruns reproduced the focused/full/typecheck results below.
- `bun test` — **301 pass, 1 skip, 8 fail, 8 errors** across 23 files. Eight file loads were blocked by the same missing Markdown dependency. No dependencies were installed.
- `bun run typecheck` — failed with four missing modules/types (`mdast-util-from-markdown`, `mdast-util-gfm`, `micromark-extension-gfm`, `mdast`) and two implicit-any indexing errors in `src/markdown-narration.ts`.
- Supplemental `bun -e` transport harness — **16 assertions passed** using schema-validated synthetic plans, fake processes and in-memory config. Covered exact active flag order, base-language selection, per-language donor/weight, one settings read per call, invalid/off legacy equality, plain-route suppression and default-factory persisted on/off readback. This does not substitute for the blocked full suite or listening.
- `<local-kokoro-python> -B -m unittest discover -s test/python -p test_*.py` — **140 tests, OK (skipped=4)**. Existing Python source/tests and parent-created pycache were preserved.
- `git diff --check` — exit 0, with Git LF-to-CRLF advisory warnings only. No formatter is prescribed in package scripts, so none was introduced.
- No commit, staging, push, branch change, install, live-profile activation or plugin reinstall was performed. No explicitly configured general model was supplied; runtime default applies. `skill_resolution: paths-injected` for the exact requested work-unit skill; `.atl/skill-registry.md` exists and was read.

### Bounded Python correction evidence (2026-10-14)

- Direct `synthesize_envelope` calls now validate tone weight before chunk preparation or style lookup. A shared local validator also guards direct `blend_tone_style` calls before style inspection. Only built-in integers/floats in finite inclusive `[0,1]` are accepted; booleans, strings and other invalid types raise the stable `ValueError('invalid-tone-weight')` without coercion. Invalid weights are rejected even with an empty donor.
- Plan-mode donor membership is checked only for positive weight; an unknown donor at zero weight skips `get_voices` and proceeds to synthesis. The unknown-donor rejection regression now uses positive weight. Empty-donor disable behavior and plain-text routing are unchanged.
- Test-first RED, before either source correction: `<local-kokoro-python> -B -m unittest discover -s test/python -p test_*.py` — **143 tests, FAILED (failures=18, errors=13, skipped=4)**, exit 1. The new invalid-weight subtests and unknown-donor/zero-weight regression exposed both holes.
- GREEN, same command after source correction — **143 tests, OK (skipped=4)**, exit 0. Invalid negative, above-one, NaN, infinite, boolean and invalid-type weights are covered with both active and empty donors; assertions verify no chunk preparation, phonemization, style lookup, inference or audio write. Direct helper calls verify rejection before style inspection.
- `git diff --check` — exit 0, with LF-to-CRLF advisory warnings only. Commands ran from the repository; Python used `-B`. Existing work and caches were preserved; no cache cleanup, commit, staging, install, review, branch operation or live configuration change was performed.
- Remaining gates are unchanged: missing local Markdown dependencies (`mdast-util-from-markdown`, `mdast-util-gfm`, `micromark-extension-gfm`, `mdast`) still block the previously recorded TypeScript verification; auditory JT-17 acceptance remains pending. Neither was rerun or claimed resolved by this correction.
- `skill_resolution: paths-injected`: `<skills-root>/work-unit-commits/SKILL.md` (loaded before work); `<skills-root>/cognitive-doc-design/SKILL.md` (loaded before this evidence update). Engram project detection remained ambiguous; no memory writes were attempted.

### Dependency restoration and final verification (2026-10-14)

- User explicitly authorized `bun install --frozen-lockfile`; it installed 59 packages without changing `bun.lock` or `package.json`. This resolved the previously recorded local dependency blockers; historical failing results above are retained as intermediate evidence, not current failures.
- Focused Bun suite: **242 passed, 0 failed**, 816 assertions across four files. A fresh independent verifier reproduced this result after restoration.
- Full `bun test`: **621 passed, 5 skipped, 0 failed**, 2,459 assertions across 23 files. Run once by the restoration worker; not independently rerun.
- `bun run typecheck`: **passed**, no diagnostics. Parent spot check and independent verifier reproduced the result.
- Python unittest discovery with `-B`: **143 tests run, OK, 4 skipped** (139 passed). Restoration worker and independent verifier reproduced the corrected result.
- `git diff --check` passed with line-ending advisories only. `git diff --exit-code -- bun.lock package.json` passed in worker, parent and independent verification.
- Independent inspection confirmed direct weight validation precedes synthesis work, zero-weight donor membership is skipped, active plan flags preserve base-language selection, and disabled settings retain legacy arguments. No severe candidate-caused runtime regression was found in the inspected scope.
- Implementation and deterministic verification are complete; JT-17 auditory acceptance remains pending. No plugin installation, profile activation, commit, staging, push or review-mode change was performed. Receipt-driven review remains clone-local off.

## Functional verification and pending listening acceptance

| ID | Verification |
| --- | --- |
| JT-18 | Blend-off produces a byte-identical legacy argument array (transport harness verified); real audio equivalence versus `ce2e794` remains unmeasured in this session. |
| JT-19 | A config round-trip preserves `toneVoice` and `toneWeight` across read, patch, and write, including the existing cross-language rejection for `voices` and the legacy-unknown-key behavior. |
| JT-20 | A cross-language donor is accepted for tone while `--lang` still follows the timbre voice; an invalid donor or an out-of-range weight is rejected without being persisted. |
| JT-21 | Audition a chosen experimental preset against unblended `em_alex`; record perceived tone/accent and duration at matched speed. Use a validated pitch estimator before claiming F0 improvements. The shipped default is off and weight can affect duration. |
| JT-22 | `voices-v1.0.bin` is unmodified after a full narration cycle (JT-05). |

## Next step and synchronized locators

Dependency restoration and deterministic checks are complete. Hold JT-17 until the maintainer auditions the suggested preset; do not activate it automatically. From the repository, `bun src/cli.ts tone es am_onyx 0.75` configures the experimental preset and `bun src/cli.ts tone es off` disables it. These commands change persisted settings and have not been run against the live profile. Deterministic transport evidence is not auditory qualification.

- Repository locator: `odd/tasks/jarvis-tone-blend.md` (authoritative source of truth for this task).
- Engram: project `agentvoz`, topic `odd/jarvis-tone-blend/tasks` — **MIRROR PENDING, NOT WRITTEN.** Writes fail with `ambiguous_project` because the Engram MCP resolves its project from its own cwd (`<user-home>`), where `status-provider-baseline` and `status-provider-dev` sit as loose git repositories. A repo-local `.engram/config.json` does not fix this, since that path is never consulted from the MCP cwd. Resolve by relocating those two repositories out of the user home, or by repointing the Engram MCP cwd; then re-mirror this document.
- Branch: `feat/jarvis-tone-blend`, base `ce2e794`.
- Spike artifacts: temporary only, outside the repository; not committed.
