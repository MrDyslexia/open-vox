# Bounded automatic voice-style search

Status: VS-01–VS-05 implemented and independently verified; real-browser and auditory acceptance pending. Canonical memory project: `agentvoz`.

## Outcome and boundaries

Extend the local laboratory with an explicit automatic search against its current cached reference. Optimize raw ECAPA cosine for the exact generated candidate, not a claimed JARVIS-likeness probability. Preserve user-owned server sessions, plugin settings, models, environments and existing uncommitted changes. No new packages, model downloads, external audio upload, commits or publishing.

Freeze text, language, base voice, donor voice, synthesis speed and reference ID at search start. Default search varies timbre/prosody weights. An opt-in advanced mode may also perturb bounded raw style offsets. Keep voice choice and speed fixed to avoid improving the metric through an unintended test change. Single-sentence optimization can overfit; user listening and additional sentences remain acceptance requirements.

## Tasks and route

- [x] VS-01 — Implement deterministic bounded proposal/search logic with seed, baseline evaluation, explicit trial budget, best evaluated WAV/preset and truthful raw-score history. Never infer scores or select unevaluated candidates.
- [x] VS-02 — Add one background job with protected start/status/cancel/result endpoints, a single bounded retained job and shared synthesis/comparison resource ownership. Cancellation is cooperative between candidates, not interruption of model inference.
- [x] VS-03 — Add Start search, trial count, advanced-offset opt-in, progress, cancellation, baseline/best score, exact best-audio playback and Apply best preset/export actions. Guard asynchronous state and reference changes.
- [x] VS-04 — Test budgets, deterministic proposals, bounded offsets, best selection, cancellation/error recovery, stale IDs, busy resource handling, result WAV/preset identity and existing boundary defenses.
- [x] VS-05 — Independently run a small actual reference-guided search on an owned temporary loopback server, confirm evaluated best and retained audio, verify regressions, and record costs and remaining visual/listening limitations.
- [ ] VS-06 — User acceptance of actual browser controls/playback and listening on additional sentences. Improved cosine alone does not qualify perceptual voice resemblance.

Delegated direct route: multi-file writing/preparation and independent verification require separate bounded workers. Default test-first applies. Size is advisory, never a reason to omit safety tests.

## Scope and checks

Source: `tools/voice-lab/{search.py,test_search.py,server.py,index.html,test_server.py,README.md}`; tracking: this document. No comparator/bootstrap changes unless a confirmed blocking seam requires separately scoped authorization.

Default budget: 12 trials; hard per-job maximum: 32. No parallel candidate generation, unattended continuous search or automatic retries. Show estimated cost, uncertain timing and cooperative cancellation in the interface. Validate finite/range values and schema; preserve Host/Origin/body limits on every new route. Keep model failures isolated, never fabricate scores or silently replace reference. Keep cached voice arrays immutable. Retain only the current bounded job, score summaries and its best WAV.

Tests: isolated lab Python `-B -m unittest discover -s tools/voice-lab -p 'test_*.py'`; existing Bun and Python regressions once. Real verification may use only an owned transient server on another loopback port and approved temporary outputs; stop only that process. Current user-owned port 8765 must not be restarted or killed.

## Progress

Forecast: each job performs up to its selected budget of local synthesis and embedding computations, consuming CPU for seconds to minutes depending on text length and settings. No hearing, probability calibration or perceptual guarantee is inferred from the metric.

Engram mirror `odd/voice-lab-search/tasks` remains pending existing MCP ambiguity; this document is authoritative. A scoped `mem_save(project="agentvoz")` again returned unrelated available projects; no memory was written to either wrong project. Next: user-controlled foreground launch and browser/listening acceptance. Keep the existing user-owned 8765 process untouched; a new server may use an unused port such as 8766.

## Writer evidence (2026-10-14)

Skills resolved by exact injected paths, read before source writes:
`<skills-root>/{work-unit-commits,cognitive-doc-design,context7}/SKILL.md`.
Skill registry is cached at `.atl/skill-registry.md`; no registry/config changes. No new library APIs required documentation queries. CodeGraph failed because this checkout has no index; scoped file fallback used without initialization. English artifacts; default test-first; no strict-mode claim.

| Phase | Exact command (repository root) | Observed result |
| --- | --- | --- |
| Pure RED | `& "tools/voice-lab/.venv-comparator/Scripts/python.exe" -B -m unittest discover -s tools/voice-lab -p test_search.py` | 1 loader error: missing `search` module, before algorithm implementation. |
| Pure GREEN | Same command | 6 tests passed after initial implementation. |
| UI RED | `& "tools/voice-lab/.venv-comparator/Scripts/python.exe" -B -m unittest discover -s tools/voice-lab -p test_server.py -k BrowserScriptTests` | 1 failure: missing Start search event handler, before UI implementation. |
| UI GREEN | Same command | 1 executed-script harness test passed. |
| Metadata RED | `& "tools/voice-lab/.venv-comparator/Scripts/python.exe" -B -m unittest discover -s tools/voice-lab -p test_search.py -k invalid_candidate` | 1 failure: invalid used duration was accepted; consistency validation then added. |
| API RED | `& "tools/voice-lab/.venv-comparator/Scripts/python.exe" -B -m unittest discover -s tools/voice-lab -p test_server.py -k incompatible_active_styles` | 1 failure: 202 instead of required 400; search acceptance now checks donor compatibility even at baseline zero weights. |
| Initial lab GREEN | `& "tools/voice-lab/.venv-comparator/Scripts/python.exe" -B -m unittest discover -s tools/voice-lab -p "test_*.py"` | 52 tests passed before the three additional metadata/negative-score/style compatibility tests; final count recorded below. |
| Final lab GREEN | Same full isolated lab command | 55 tests passed, including metadata/API RED cases and extended best-export/stale-job/terminal-poll harness assertions. |
| Bun regression (once) | `bun test` | 621 pass, 5 skip, 0 fail; 626 across 23 files, 2,459 assertions. |
| Python regression (once) | `& "tools/voice-lab/.venv-comparator/Scripts/python.exe" -B -m unittest discover -s test/python` | 143 tests, 4 skipped, OK. |
| Typecheck | `node ./node_modules/typescript/bin/tsc --noEmit` | Exit 0. |
| Tracked whitespace | `git diff --check` | Exit 0; existing LF/CRLF warnings only. Untracked lab files also require explicit whitespace verification. |
| Untracked/allowed whitespace | For each of the seven authorized surfaces: `git diff --no-index --check -- NUL <path>` | No whitespace-error diagnostics; each returns 1 for the detected nonempty no-index diff, with LF/CRLF warnings only. |

Implementation: exact five-field start schema `{preset, referenceId, trials, seed, advancedOffsets}`; UI defaults 12/0/false; explicit HTTP values required. Baseline first, bounded lattice/seeded local search, only real evaluated scores, one best WAV ≤10 MiB, terminal replacement invalidates old IDs. Shared gate owns the whole job; gate-owned synthesis and direct comparator seams avoid nested-lock or HTTP-recursion deadlocks. Separate job locks keep status/cancel responsive. Cancellation may retain/count the current evaluation; failures stop immediately without retries or fake scores.

Only authorized lab/task surfaces were written. Preexisting dirty tracked files and untracked comparator/lab work were preserved; no staging, commit, branch, push, installs, downloads, configuration/model mutations or real-model server/search launch. Ephemeral HTTP tests stop/join only their owned server/job threads. The advisory 400-line heuristic is exceeded to retain safety tests and readable code; this is one writer work unit, not SDD. Independent worker verification is the next boundary.

Rollback boundary: remove `search.py`/`test_search.py` and only added search seams/routes/UI/tests/docs from `server.py`, `index.html`, `test_server.py`, lab README and this tracker. Preserve original synthesis/comparison behavior and all unrelated dirty work. No commit identity exists by authorization.

## Bounded duplicate-candidate correction (2026-10-14)

Replaced `repr(preset)` deduplication with an exact known-schema tuple identity. Validated integer/float equivalents, including speed and offsets, now share equality/hash; no rounding hides distinct values such as `0.01` or `1e-12`. Proposal logic, frozen fields and the existing `trials + 10` termination bound are unchanged. Only `search.py`, `test_search.py` and this tracker were edited.

| Check | Command / evidence | Observed result |
| --- | --- | --- |
| Focused RED, before fix | `& "tools/voice-lab/.venv-comparator/Scripts/python.exe" -B -m unittest discover -s tools/voice-lab -p test_search.py -k integer_baseline` | 1 test, 12 failing subtests: baseline evaluated twice instead of once across budgets 4/12/32, seeds 0/17 and repeated runs. |
| Isolated lab GREEN | `& "tools/voice-lab/.venv-comparator/Scripts/python.exe" -B -m unittest discover -s tools/voice-lab -p "test_*.py"` | 58 tests passed: previous 55 plus 3 tests for unique seeded trials, exact numeric identity and bounded duplicate exhaustion. |
| Whitespace | `git diff --check`; `git diff --no-index --check -- NUL <path>` for each of the three edited, untracked surfaces | Tracked check exit 0; each no-index check exit 1 for nonempty diff. No whitespace-error diagnostics; LF/CRLF warnings only. |

Independent verifier's historical four-trial real search reported cosine `0.296757` → `0.347700` (approximately `+0.05094`). This is **pre-correction intermediate evidence**, not final acceptance: trial 2 repeated the integer-zero baseline as float zeros, and the verifier assertion stopped the probe. Original winner retrieval remains pending; browser and listening checks remain pending. Independent cancellation evidence: one in-flight evaluation completed before cooperative cancellation stopped further trials. The parent verifier must follow the corrected algorithm; VS-05 stays unchecked. No full repository suites were rerun for this local correction, and no real server was launched here or user-owned port 8765 touched.

Skills resolved and read from exact injected paths: `<skills-root>/work-unit-commits/SKILL.md` and `<skills-root>/cognitive-doc-design/SKILL.md`. CodeGraph had no index, so scoped reads were used without initialization. Engram save again returned unrelated ambiguous projects; no wrong-project memory was written. Correction rollback: remove `candidate_identity`, restore the original deduplication line, and remove only these three new tests and this section.

## Post-correction independent real-search evidence

Independent verification reproduced **58 lab tests, no skips or failures**. A single four-trial job against the existing 50-second reference completed with four distinct configurations, no errors, and the baseline evaluated once. Text (150-character Spanish sentence), `em_alex`, `am_onyx`, speed 1, `es`, zero offsets and seed 0 stayed fixed; advanced mode was off.

| Trial | Timbre weight | Prosody weight | Raw cosine |
| --- | --- | --- | --- |
| 1, baseline | 0 | 0 | 0.2967573908 |
| 2 | 0 | 0.5 | 0.3246082985 |
| 3, best evaluated | 0 | 1 | 0.3477001034 |
| 4 | 0.5 | 0 | 0.3116459621 |

The job took approximately **4.931 seconds** on this host; score improvement was **0.0509427126**. This is an observed metric change, not probability, perceptual acceptance or a global optimum. The exact best WAV was fetched from this job's audio endpoint before other assertions, without regenerating it: PCM16 mono 24 kHz, 9.792 seconds, 470,060 bytes. The associated preset and terminal/manifest evidence are in the same temporary directory:

`<local-evidence-dir>`

Files: `exact-retained-best.wav`, `best-preset.json`, `terminal.json`, `manifest.json`. Wave SHA256: `9f9f47a1b2164a14f407c81e8212e932d0be9b4957bba41fd4e6228257331c01`. Best score equals the maximum successful history score; frozen fields, numeric bounds and same-job/reference linkage were checked.

Voicepack, Kokoro ONNX and comparator checkpoint hashes were unchanged. The owned verification server terminated and port 8766 closed; user-owned 8765 remained untouched. Independent tracked whitespace checks passed with line-ending warnings only; parent typecheck and manifest/lock unchanged checks passed after correction. Cancellation/resource-release and stale-job evidence above remains valid; those unaffected checks were not redundantly rerun. Real-browser layout/playback and auditory acceptance remain pending.
