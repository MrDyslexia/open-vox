# Pronunciation-oriented text normalization

**Status (2026-10-12): IMPLEMENTED / TESTED RUNTIME / BASIC AUDIBILITY CONFIRMED IN LIVE HOST / QUALITY ACCEPTANCE PENDING.** Branch `feat/pn-implementation`, historical checkpoint `3b7dd02` (clean at that checkpoint, not a current delivery claim). I01–I04 are locally committed; three host-found fixes followed. At that historical checkpoint: not published, not merged, not archived. Cached origin/PN-01 later points to dfc1307; this local preparation publishes nothing. Remaining gates are listed under "Acceptance gates".

Locator: `odd/tasks/pronunciation-normalization.md`. Engram: project `agentvoz`, topic `odd/pronunciation-normalization/tasks` (single full snapshot, prompt capture off). Per-attempt prose was compacted on 2026-10-12; approved scope, unit closures with commit ids, evidence and limits are kept. Git holds the detailed history.

## Where we are (2026-10-12)

Local unification checkpoint (U05): per-instance service controls now bind to the
delivered PN plan/cache lifecycle; deterministic fake-process checks do not renew
live-host/model/quality acceptance. See `unified-playback-narration.md` for evidence.

| Item | State |
| --- | --- |
| Commits (base `975b447`) | `db77b0b` I01 Markdown/policies/plan; `a7c9db9` I02 offline contextual resolver; `966a182` I03 fixed-voice bilingual Kokoro integration; `f43c3db` I04 isolated provisioning/doctor; `f3d9025`, `95d6faf` docs/validation; `3338f0a` fix: accept object-valued user summary metadata (SDK contract); `19e992c` fix: cancel narration only for events of its own session (`stopSession`); `3b7dd02` fix: adapt Spanish inverted punctuation. |
| Managed setup | Done under the app home: `pn-venv` plus pinned LID model, about 1.64 GB logical files (model 712,465,856 bytes). Existing `kokoro-venv`, Kokoro model and voices unchanged. |
| Installed host | OpenCode loaders (`~/.config/opencode/plugins/open-vox.js`, `tui-plugins/open-vox.tsx`) point to this worktree. After the three fixes the user CONFIRMED audible narration in the live host. This is basic audibility only. |
| Not yet accepted | ES/EN pronunciation quality of production audio, long texts, and Pause/Resume/Repeat quality by ear. |
| Latest regressions | Full Bun 418 pass / 2 skip (before the punctuation fix; TS unchanged since), Python narration suite 68 pass, typecheck exit 0. |
| RDD | Clone-local OFF for this checkout (global ON). Ordinary checks only; no native review or receipts exist. A publication gate would need the owner's decision. |
| Original checkout | `<playback-worktree>` untouched by this work. |

Diagnosis lesson: the `OPEN_VOX_LOG=<file>` environment variable enables the file logger (speech error lines). The live silence was a plan-child exit code 2 from the unsupported-symbol class (stderr `unsupported-symbol: U+XXXX`).

**Next action:** ask the user for explicit ES/EN listening acceptance (short and long texts, Pause/Resume/Repeat); then decide the path to main below. No publication is authorized.

## Path to main (analysis only, no publication authorized)

**Graph.** `origin/main` = `5fe4faf`. The playback chain (P1 `03a13e8`, P2 `5804e00`/`9dcca5a`, P3a `975b447`) is NOT in main. P3b `7ab8374`/`d40f0da` (service On/Off) and P4 speed (uncommitted work in the original checkout) sit on top of `975b447` in a different checkout. `feat/pn-implementation` is 16 commits ahead of main (9 PN + 7 playback) and 0 behind. A leftover local branch `feat/pronunciation-normalization` points at `5847572` (a P3a delivery-record commit): a distinct historical branch, not a collision with the new delivery/* namespace; it is preserved.

**Coupling.** PN edits files that P3b/P4 also touch (`src/plugin.ts`, `src/speech-sink.ts`, `src/config.ts`, `src/cli.ts`, tests, TUI/README), so conflicts are expected when combining. PN depends on the P3a sink pause API and persistent player; it cannot target main before the playback chain.

**Size.** PN alone is about 4,300+ authored additions (I01 1,039; I02 ~1,194; I03 ~950; I04 986; plus fixes), far above the 400-line advisory budget. Strategy stays `delivery_strategy: auto-chain`, `chain_strategy: feature-branch-chain`: a draft/no-merge tracker PR, children targeting the tracker, then the immediate parent. Options: a cohesive-size exception per unit, or sub-slicing along the dependent sections already identified (manifest/runtime integrity, installer/CLI/docs, Python adapter/helper/tests, dependent TS integration/tests). Maintainers must approve any `size:exception`.

**Open decision (owner):** rebase/merge order of PN versus P3b/P4, and who accepts the size exception.

**Pre-publication checklist (do not execute):**
- [ ] Decide rebase/merge order; resolve conflicts with P3b/P4; re-run full Bun, typecheck and Python suites on the combination.
- [ ] Sanitize tracker and docs of local absolute paths and scratch references before publishing to the public repo (github.com/MrDyslexia/open-vox).
- [ ] Check LF/CRLF warnings (`.gitattributes`).
- [ ] Confirm `bun.lock` and dependency additions are acceptable: `mdast-util-from-markdown` 2.0.3, `mdast-util-gfm` 3.1.0, `micromark-extension-gfm` 3.0.0.
- [ ] README states that `open-vox setup narration` is explicit (about 712 MB model, about 1.64 GB total); release notes for the new `language es|en` setting.
- [ ] Decide the fate of "one unsupported symbol silences everything" (graceful degrade) before or after merge.
- [ ] ES/EN listening acceptance on long texts.
- [ ] Repoint installed-host loaders to the final checkout after merge.
- [x] Delivery namespace uses new delivery/* refs; existing feat/pronunciation-normalization is preserved, not renamed or overwritten.

## Authorization, isolation, scope

- Production PN authorized 2026-10-11. No LLM, external text inference, translation, paraphrase or arbitrary summary is approved.
- Managed setup (`open-vox setup narration`) was explicitly authorized by the user and run once; it is never implicit and never part of ordinary speech. Host activation was a separate user-approved step.
- This tracking update writes only this file: no code, commands, commits, installs, audio or child agents.
- CodeGraph mapper failure/no index was supplied; direct file reads were used.

## Approved contracts and policies

| Area | Required behavior |
| --- | --- |
| Original/source | Narration is derived; original UI/history/source unchanged. Policies, structural plan and resolved envelope are separate representations; source ranges address the unchanged original. |
| Base language/voice | Explicit `es`/`en` base (initially `es`). One existing voice slot selected once per synthesis, constant across languages. Existing voice controls keep their meaning. |
| Engines | Kokoro ONNX: language-specific G2P/raw phonemes. Piper/SAPI get bounded flattened text and configured language, never JSON/phonemes; reduced pronunciation is explicit. Selection stays Kokoro/Piper/SAPI. |
| Input/expansion | At most 4000 UTF16 narration units including separators, numbering and announcements. Explicit cap outcome and omission trace; no technical-token cuts. Resolver expansion over the cap fails readiness without cutting. |
| Inference | Pack adjacent G2P fragments within each block into at most 510 final raw phonemes, counting inserted boundary spaces. Language-run boundaries are not model boundaries. Never split protected technical units; indivisible oversize fails. |
| Local LID | `sagorsarker/codeswitch-spaeng-lid-lince`, revision `66d0e899b3fcf70d8727e4521c7a9c3f7a1fa73c`. Pinned local assets only during inference; no downloads or external text transfer. Missing assets/dependencies give diagnostics and deterministic policy/base fallback. |
| Lifecycle | Preserve queues, ownership, instance/session guards, generation supersession, stop/pause, candidate promotion and cache hold/discard/error handling. Exact cached Repeat does no text/preparation/resolution/synthesis. |

### Markdown behavior

| Source construct | Narration |
| --- | --- |
| Paragraphs/headings/lists/quotes | Speak text; keep structural boundaries, list numbering and depth. Pauses support structure, no prosody guarantee. |
| Emphasis | Plain text without markers. |
| Inline technical code | Preserve protected identifiers, commands, flags, versions, paths, numbers and symbol meanings; only approved rules apply. |
| Fenced/indented code | Omit contents; announce `Bloque de código omitido` / `Code block omitted`. |
| GFM tables | Omit contents; announce `Tabla omitida` / `Table omitted`. |
| Links/raw URLs | Speak visible labels; omit destinations and raw autolinks; keep traces. |
| Images | Speak supplied alt text only. |
| HTML/comments/definitions | Omit; paired/nested HTML suppression follows original source intervals across paragraphs; unclosed/mismatched markup is conservative. |
| Thematic separators/unsupported nodes | Silent separation; unknown nodes traced/omitted or fail per policy. |

Resolver precedence: configured acronym spelling; eligible English identifiers without translation; known names; whole known expressions; contextual ES/EN evidence; configured-base fallback. Deterministic policy precedes detector evidence. Do not extend English to adjacent text. Dictionary expressions cannot enter, leave or bridge protected units. `(API)`/`(HTTP)` keep parentheses and apply spelling; attached calls/commands stay protected; dollar/environment references unchanged. Missing/gapped/conflicting evidence uses explicit fallback.

Final-phoneme symbols (3b7dd02): `«` `»` map to ASCII quotes; `¡` `¿` are removed from final phonemes only (traced with `rawIndex`, `codepoint`, `to:""`, doubled space collapsed). `[ ] { }`, other unsupported symbols and symbols inside protected technical text still fail explicitly with `unsupported-symbol: U+XXXX`. No silent filtering or invented replacements. Ellipsis, em dash, curly double quotes and parentheses are supported; the phonemizer already drops apostrophes, hyphens and en dashes.

### Wire and trace references

- I01 schema 1 `NarrationPlan`: `offsetUnit: utf16`, `rangeConvention: end-exclusive`, `languageStatus: unresolved`, base language, detached policy, blocks/segments/omissions, bounded length, complete/truncated/unsplittable outcome.
- Python converts UTF16 endpoints through cumulative scalar prefixes; rejects mid-surrogate/out-of-range input; no normalization; offsets never recovered by substring search.
- I02 resolved schema 1 keeps the detached `structuralPlan`; units keep source, derived range, spoken text, language, reason, protection and raw detector evidence. `decisionRange` and detector offsets are block-derived Python codepoints. `synthesisReady` and `resolutionOutcome` gate expansion/unsplittable input.
- I03 packed chunks keep block identity and `runs[]` (indices, language, ranges, raw/adapted phonemes, mappings, `separatorBefore`, chunk-local `phonemeRange`/`rawPhonemeRange`). Trace boundaries, not exact original-token ranges.

## Delivery

`delivery_strategy: auto-chain`; `chain_strategy: feature-branch-chain`; advisory budget 400 additions+deletions per slice, never reached by deleting tests/docs. Dependency order: `975b447 -> I01 db77b0b -> I02 a7c9db9 -> I03 966a182 -> I04 f43c3db -> f3d9025 -> 95d6faf -> 3338f0a -> 19e992c -> 3b7dd02`. Native review authority belongs to the owner.

Historical PN-01–PN-05 tasks stay open as umbrella items: PN-01 language/context and protected meanings (I01/I02); PN-02 superseded LLM proposal, resource/accuracy evaluation remains; PN-03 derived integration and lifecycle (I01/I03); PN-04 superseded approval wait; PN-05 fidelity/fluency/listening evaluation (pending).

## Unit closures and retained evidence

### PN-I01 — Structure, contracts, policies (`db77b0b`)
- [x] Versioned contracts, source offsets, immutable-original traces; Markdown/GFM extraction, omissions, numbering, protected meanings; 4000 cap with explicit outcomes.
- Evidence: RED 24 pass/8 fail; focused 32 pass/201 assertions; typecheck 0; full 356 pass/2 skip. Fixed cross-paragraph HTML suppression, joins after omissions, non-HTTP autolinks, protected-code whitespace. Authored 1,039 lines plus lock changes (Markdown dependencies belong here).
- Rollback: unwind consumers first, then remove parser/contracts/policy/tests and dependency entries together.

### PN-I02 — Local detector and resolver (`a7c9db9`)
- [x] Strict wire validation; deterministic policy priority, protected meanings, known expressions/names, identifier routing, configured fallback; local-only detector with bounded windows and explicit missing-asset/dependency failures.
- Detector: lazy Torch/Transformers, absolute local path, `local_files_only=True`, `trust_remote_code=False`, CPU/eval/no-grad, label/config/logit validation, at most 512 tokens per window; oversized atoms degrade explicitly. Scores are uncalibrated softmax.
- Evidence: Python 37 pass; 30 actual TS plans across ES/EN. Fixed protected dictionary boundaries, prose-parenthetical acronyms, dollar/environment references.

### PN-I03 — Fixed-voice bounded synthesis (`966a182`)
- [x] Plan-aware engine/sink, explicit `es`/`en` setting (`open-vox language es|en`, default `es`), unchanged voice slots, bounded unfiltered per-language G2P, within-block packing, explicit protected/unsupported/expansion failures, block pauses (0.18 s), text-only non-Kokoro fallback, live-engine dispatch.
- Runtime contract: strict one-document JSON on stdin; one reused Kokoro model/style per utterance; one raw `create` per packed chunk; bounded audio (600 s ceiling); one final mono 24 kHz PCM16 WAV written only after all inference succeeds; failed write removes the candidate. Voice/speed snapshot once per synthesis; 120 s process budget.
- Packing defect fixed: `Hola local, Open editor y seguimos.` gave three model calls instead of one. RED 16 tests/3 failures; GREEN Python 56. Actual run (absent LID, degraded): one 38-char input, one inference, 2.176 s audio. That run proved packing, not contextual detection.
- Evidence before fixes: focused 127 pass/366 assertions; full 367 pass/2 skip.

### PN-I04 — Managed provisioning and operational closure (`f43c3db`)
- [x] Explicit `open-vox setup narration` creates `<app-home>/pn-venv`; existing Kokoro assets are required and reused read-only; no `setup all` exists. Pinned CPU Torch index plus anonymous PyPI; child isolation, offline flags, no implicit Hub token; inference never provisions.
- Pins: Torch 2.14.1+cpu, Transformers 5.19.0, Tokenizers 0.23.3, safetensors 0.8.0, huggingface_hub 2.2.0, kokoro-onnx 0.6.1, onnxruntime 1.31.0, soundfile 0.14.0, numpy 2.5.3.
- Model: bundled `resources/lid-model.json`, five files, 712,465,856 bytes (weights 711,469,178 bytes, SHA256 `623ce7a7aa55e3ed5516b9962c66cdd5d51fe04725ff2eaf9f60d9daad8833b4`). Strict manifest, exact HTTPS URLs, anonymous manual redirects, owned `.partial` staging, hash check before exclusive publication; corrupt/extra/redirected assets fail closed without overwrite.
- Readiness: schema-1 hint with `provenance: managed-environment-v1`; doctor hashes files and probes imports/versions/CPU without loading weights; Python re-verifies hashes once per detector load. Missing PN leaves Kokoro available with explicit degraded LID.
- Provenance correction: the first probe accepted matching versions from a foreign interpreter/module origin and setup reached pip first. Now `narrationProbeArgs(expectedVenv, basic)` passes the expected root; the basic identity probe runs before pip, the full probe checks all nine package specs/distributions before and after import. RED 60 pass/3 fail; GREEN focused 68 pass/251 assertions, full 396 pass/2 skip, Python 61, typecheck 0.
- Closure: 14 files, 986 additions / 41 deletions at `f43c3db` (over budget; no exception inferred).
- Rollback: remove I04 provisioning/doctor/docs; never uninstall the user's Kokoro environment.

### PN-I05 — Standalone ONNX FP32 LID backend, inactive (IN PROGRESS, 2026-10-13)
Direction (Engram #2229 evidence, #2232 integration limits, #2250 resume runbook): replace the Torch/Transformers detector runtime with the original token classifier exported to ONNX FP32, run with onnxruntime + tokenizers + numpy only. No int8, Lingua, LLM student or retraining; no new studies. Units, in order:
- [x] **I05.1 Backend, manifest, tests (inactive).** `scripts/narration_lid_onnx.py`, `resources/lid-model-onnx-fp32.json`, `test/python/test_narration_lid_onnx.py`. Keep nine labels, Unicode offsets, 510/512 windows, whole-word evidence, non-binary fallback, original source and protected controls. Not selected from the plugin; active install, defaults and `main` unchanged. Backend identity/hashes recorded separately from the strict schema-1 `narration_synthesis` contract.
  - Observed evidence: RED = `python -m unittest discover -s test/python -p "test_narration_*.py"` gave 69 tests/1 import error (module absent) on top of the 68-test baseline; GREEN = new file 31 tests OK (1 skip: symlink creation unavailable), full Python narration suite 99 OK/1 skip with the managed `pn-venv` interpreter (numpy 2.5.3, onnxruntime 1.31.0, tokenizers 0.23.3), `bun test` 418 pass/2 skip/0 fail, `tsc --noEmit` exit 0. The real-asset integration test runs against hard-linked reference files in an exact-set directory (layout: `model.onnx` plus `tokenizer/*`) and pins only high-confidence labels (score > 0.8); it skips when assets or runtime are absent (system Python without numpy: 31 tests OK/3 skips). Nothing imports the module outside its tests; backend marker lives in result field `backend`, schema-1 `identity` keys unchanged.
- [x] I05.2 Reproducible packaging, tokenizers full LICENSE, bundle (local verified bundle; ~709 MB graph never a plain Git file). Parallel inactive ONNX asset layer `src/narration-onnx-assets.ts` (strict manifest validator mirroring `validate_manifest`, `narrationOnnxPaths`, `ONNX_PACKAGES`, ready record + `resolveNarrationOnnxPython`, `assertOnnxLidDirectory`, `copyOnnxModelFromSource`), `test/narration-onnx-assets.test.ts`, `THIRD_PARTY_NOTICES.md`. Torch layer untouched; nothing imports the module.
  - Observed evidence: RED = `bun test test/narration-onnx-assets.test.ts` failed with "Cannot find module ../src/narration-onnx-assets" (0 pass/1 error) with the module absent; GREEN = 17 tests/0 fail (143 -> 149 expects incl. the real-asset hash check, ~0.5 s), full `bun test` 435 pass/2 skip/0 fail (418 baseline + 17), `bun run typecheck` clean, Python narration suite 99 OK/1 skip unchanged. A test runs the same 12 manifests through the TS and Python validators and requires identical accept/reject plus equal filenames and graph/tokenizer hashes; real reference assets match the manifest. Directory junctions are exercised; file symlinks are not creatable here (EPERM), so that branch exits early. **Licensing status (updated 2026-10-13, see the license-notices bullet below): the tokenizers Apache-2.0 text, onnxruntime MIT text and the bundled libsndfile LGPL-2.1 pointer are now verified; the model licensing chain is NOT closed (MIT tag without a license file, owner confirmation pending), so derived ONNX/tokenizer assets must not be redistributed.**
  - Observed evidence (license notices): `THIRD_PARTY_NOTICES.md` now names a source per entry. tokenizers 0.23.3 ships no LICENSE locally, so the Apache-2.0 text comes from the upstream tag `v0.23.3` (raw.githubusercontent.com/huggingface/tokenizers); onnxruntime 1.31.0 has `onnxruntime/LICENSE` (MIT) and `ThirdPartyNotices.txt` in the package dir; the soundfile wheel bundles `_soundfile_data/libsndfile_x64.dll` plus an LGPL-2.1 `COPYING`; the model card at the pinned revision declares `license: mit` but the repo has no LICENSE file and the base model/LinCE terms are unchecked. Newly found and left open: `phonemizer` (GPL-3+) and `espeakng-loader` (license not verified) arrive transitively through kokoro-onnx.
- [x] I05.3 `setup`/`doctor` for a dedicated environment (versions, import origin, hashes). Explicit `open-vox setup narration-onnx --lid-source <dir>` (new target; `setup narration` and the Torch path unchanged, no `setup all`), `src/setup-onnx.ts` (`ONNX_PROBE`, `onnxProbeArgs`, `setupNarrationOnnx`), `inspectNarrationOnnx` in `src/narration-onnx-assets.ts`, doctor INFO/OK/WARN line, README.
  - Observed evidence: RED = new `test/setup-onnx.test.ts`/`test/narration-onnx-doctor.test.ts` and 6 new `test/cli.test.ts` cases failed (modules/exports absent); GREEN = full `bun test` 474 pass/2 skip/0 fail (435 baseline + 39), `bun run typecheck` clean, Python narration suite 99 OK/1 skip unchanged (all injected fake deps and temp dirs; no real setup, pip, venv, download or app-home access). Flow: Kokoro files required, managed-path checks, source verified by size+sha256 BEFORE any write, existing model dir verified or preserved, venv `pn-onnx-venv`, identity probe before pip, old ONNX marker deleted, one `--isolated --only-binary=:all:` pip from anonymous PyPI (no torch index), `ONNX_PROBE` (all origins/roots/versions before import, re-check after, requires CPUExecutionProvider, never imports torch/transformers), verified staged copy, directory recheck, marker last. Doctor ONNX line is printed only when the ONNX inspector is wired; absence is INFO and never red. Backend is still NOT selected (I05.4).
- [x] I05.4 Coherent explicit interpreter/backend/manifest selection. New persisted `narrationBackend` (`torch` default | `onnx`, validated like `language`; old files without the key keep working), `open-vox narration-backend [torch|onnx]` (no arg prints; `onnx` refused with exit 1 and nothing persisted unless the doctor's ONNX readiness holds; `torch` always allowed), `src/narration-runtime.ts` (`resolveNarrationRuntime` returns ONE tuple {backend, python, lidManifest, lidDirectory?}; onnx only when selected AND the cheap marker/file readiness resolves, otherwise the unchanged torch tuple plus one deduplicated `onnx-backend-unavailable` diagnostic through the existing OPEN_VOX_LOG channel), `kokoroEngine` appends `--lid-backend onnx --lid-dir <abs>` only for the onnx tuple (torch args byte-identical), `scripts/kokoro_say.py` `--lid-backend {torch,onnx}` / `--lid-dir` (absolute, onnx only; lazy imports; generic exit 2). Schema-1 `narration_synthesis` contract and `detectorIdentity` untouched. Default NOT changed; nothing activated.
  - Observed evidence: see the I05.4 verification in the commit report (RED: new config/cli/runtime/engine/Python tests failed on missing exports/commands/functions; GREEN: full `bun test`, `bun run typecheck`, Python unit suites incl. a stub-ONNX and a real-reference-asset end-to-end `resolve_plan` through `kokoro_say.build_detector`; no synthesis, no real app home).
- [x] **Real provisioning (2026-10-13, user-authorized):** `open-vox setup narration-onnx --lid-source <hard-linked clean dir>` exit 0; `pn-onnx-venv` (onnxruntime 1.31.0, tokenizers 0.23.3, numpy 2.5.3, no torch) and `lid-onnx/codeswitch-spaeng-lid-lince/66d0e899…-onnx-fp32-a322d9809cd3` created; `open-vox doctor` reports ONNX "verified local assets/dependencies (inactive backend, not selected)"; `narration-backend` still `torch`. Real `OnnxDetector` run from the new venv: status available, no diagnostics, torch/transformers not in sys.modules, 1.22 s first call, ~0.01 s warm on short sentences; same known `cambies` quirk as Torch. Existing pn-venv, kokoro-venv, torch model dir and config untouched.
- [x] I05.5 Regression and listening in the installed host (separate permission; user must listen to ES/EN short + long texts and Pause/Resume/Repeat). **2026-10-13: the user ACCEPTED this ONNX listening gate for short ES/EN mixed narration in the live OpenCode host (user statement: "lo acepto").** Honest limits: the user accepted without enumerating further tests, so long-text and Pause/Resume/Repeat coverage is not separately evidenced here.
  - Observed evidence (bug found while listening, fixed): the Spanish message "Para dar PN por aceptado (I05.5), escuchá esto en OpenCode:" read `OpenCode:` in Spanish. Root cause: `technical()` in `scripts/narration_resolver.py` was applied to whole whitespace-delimited atoms, so edge prose punctuation (`:`) made the atom `protected-technical` and the detector was ignored. Fix: `core_range()` strips only prose marks from atom edges (leading `("'«“‘¿¡`, trailing `:;,!?.…)"'”»’`, a `)` only when it does not balance a `(` inside the core) and the protected range covers the core only; technical syntax characters are never stripped. RED = 4 new tests, 318 failures + 1 error on the old resolver; GREEN = Python suite 116 OK/1 skip (112 baseline + 4), `bun test` and `bun run typecheck` unchanged. End-to-end with the real TS `createNarrationPlan` and real `OnnxDetector` (no audio): before, `OpenCode:` and `deployment:` were `es`/`protected-technical`; after, `OpenCode` is `en`/`english-identifier`/spoken "open code", `deployment` is `en`/`detected-unanimous`, `:` is neutral base, `I05.5` stays protected. Still read in the base language (not changed): `and/or`, `y/o`, `Q&A`, `10%`, dates, `e-mail`/`well-known`-style hyphenated words, `e.g.`/`i.e.`, `OpenCode/Claude`.
  - Observed evidence (follow-up, plain compounds): `technical()` in `scripts/narration_resolver.py` now returns false for `prose_compound()` cores. Rule: hyphen compound = 2..5 Latin-letter parts (accents allowed; no digits, `_`, `.` or other symbols) joined by single `-`, no leading/trailing `-`; slash alternative = exactly 2 Latin-letter parts, each <= 12 chars, one `/`, and (a part has an uppercase letter OR both parts are in a closed function-word list such as and/or, y/o, on/off). Everything else (`--flag`, `-x`, `foo-1`, `v2-beta`, `src/app`, `read/write`, `a/b/c`, paths, URLs, `key:value`, dates) stays protected. Unmarked kebab-case (`my-component`) is now prose-routed; accepted because real code arrives as protected inline code, which stays `protected-technical` (tested). RED = 6 new failing tests (4 behavior tests, 6 subtests-level failures; negative-control tests already green); GREEN = Python suite 121 OK/1 skip (116 + 5), `bun test` 500 pass/2 skip, `bun run typecheck` clean. E2E (real TS plan + real `OnnxDetector`, no audio): before, `back-end`, `real-time`, `y/o`, `OpenCode/Claude`, `e-mail`, `well-known` were all `es`/`protected-technical`; after, `back`/`end`/`real`/`time`/`e`/`mail`/`well`/`known` are `en`/`detected-unanimous`, `y`/`o` are `es`, `OpenCode` is `en`/`english-identifier` ("open code"), `Claude` is `es`/`fallback-nonbinary` (detector quirk), `src/app` and `--flag` stay protected. Still protected (not changed): `%`, `&`, digits/dates, `e.g.`/`i.e.`/`U.S.`.
- [x] I05.6 Controlled activation (done by user authorization): backend `onnx` was selected on 2026-10-13 with `open-vox narration-backend onnx` at the user's request.
Reference assets (temporary, verified present 2026-10-13): `<reference-assets>`; `assets/model.onnx` 709,298,327 B SHA256 `a322d980…a7283f86`, `assets/tokenizer/tokenizer.json` SHA256 `f5c46e58…b2409f7` (both match). Baseline at start: branch `feat/pn-implementation`, HEAD `dfc1307`, worktree clean, tracking `origin/PN-01`.

### Operational evidence (HEAD `f3d9025`, source unchanged during runs)
- Offline run (`pn-offline-result-v2.json`): detector `available`, no fallback; `health`/`check`/`deployment`/ES `timeout` retained `en` evidence (`detected-unanimous`); `getUserName` -> `get user name`; API `a pe i` (ES) / `ay pee eye` (EN).

| Run | ES | EN |
| --- | --- | --- |
| Voice | `em_alex` | `af_heart` |
| G2P runs / chunks / raw phonemes | 9 / 1 / 130 | 1 / 1 / 105 |
| Style reads / ONNX inferences | 1 / 1 | 1 / 1 |
| Fresh process / detector load | 7.075 s / 3.568 s | 6.396 s / 3.582 s |
| WAV | 6.059 s | 5.952 s |

  Mono 24 kHz PCM16; ES SHA256 `573c89431c80f5cf97c2c7e09b4009a90898d3bd1e61c6b5ccd8f3251d052688`, EN `fd61d1ba81002e9fa3e9dfbeadaf1e12d09991afd02b19f460dd03b3dda3d9f9`. Same-instance warm LID 15.85 ms (not whole-pipeline). v1 harness was blocked by its own write guard, not a model defect; v2 allowed only owned runtime-temp. Zero application-level network attempts (not a firewall proof). Tokenizer-regex and unexpected pooler-weight warnings are disclosed.
- Playback run (`pn-playback-result.json`, production sink + managed Python + real Kokoro + cache + WPF host, 22.061 s): Pause held 650 ms over 523 ms and Resume advanced to 1159 ms; exact Repeat reused the same file (SHA256 `0c25fda76fe62791d51944484bd942d2b8b03ff751be77b4f89889aa8e4cc53e`) with preparation/synthesis/runner/resolver counts unchanged at 1 and player calls 1 -> 2; stale revision inert; pending synthesis child killed once (~211 ms), exited within 3.37 ms, prior artifact preserved, no late promotion. This proves pending-child cancellation, not interruption inside ONNX. Selection to playing took 5.979 s.

### Host-found corrections (2026-10-12)
- **SDK summary metadata (`3338f0a`):** user `summary: {title?, body?, diffs}` objects were rejected before a turn existed. Now accepted; scalar/null rejection and lifecycle guards kept. RED 72 pass/1 fail -> GREEN 73; full 408 pass/2 skip.
- **Cross-session cancellation (`19e992c`):** the plugin called `sink.stop()` on any `session.error` or any session's first user update, so another session could discard pending narration. New optional `SpeechSink.stopSession(sessionID)` cancels only that session's queued jobs and the active job if it belongs to it; sinks without it, or errors without a session id, keep global `stop()`. RED 122 pass/6 fail -> GREEN 128; full 418 pass/2 skip. Proven defect, not proven to be the cause of the observed silence.
- **Spanish inverted punctuation (`3b7dd02`):** live replies exited the plan child with code 2 because the vocabulary lacks `¡ ¿ « » [ ] { }`. Fix as described under final-phoneme symbols. 26 synthesis tests (RED 5 fail/5 error), 68 narration tests green; production-argv child exit 2 -> 0 with a 1.9 s WAV; TS untouched.

## Acceptance gates and retained limits

- [x] Managed assets, provenance, doctor readiness and actual offline LID availability/integrity (separate from synthesis success).
- [x] Scoped actual TS/Python source/UTF16 fixture trace (emoji in omitted HTML).
- [x] One fixed voice across a bilingual block; exact cached Repeat without re-synthesis; real WPF Pause/Resume/Repeat; stale-revision rejection; pending-child cancellation; owned disposal.
- [x] Installed-host loaders point to this worktree; user confirmed audible narration (basic audibility only).
- [ ] Human ES/EN pronunciation quality of production audio, short and long, and Pause/Resume/Repeat by ear. The earlier scratch 15-phrase listening was accepted separately and does not certify production audio.
- [ ] Both base languages with negative controls: identifiers, API/HTTP, names, whole expressions, `>=`, versions, paths, URLs/links, numbers, commands/flags/variables, quotes, code/tables/images/HTML, ambiguous adjacent text.
- [ ] Observed 4000/510 outcomes and bounded full audio on long texts.
- [ ] Exhaustive UI/history invariance and cross-session/ownership/generation/error timing through the installed plugin; cancellation inside ONNX inference.
- [ ] Peak/sustained resource and whole-pipeline warm measurements.
- [ ] Graceful-degrade decision for unsupported symbols; path-to-main decisions above.

Limits: LID scores are uncalibrated and accuracy is not certified; no naturalness guarantee. Provenance checks assume ordinary controlled Python. Playback speed and Repeat remain separate preserved features.

## Tracking and review locator

- Authority: this repository document. Mirror: one full snapshot at Engram `agentvoz` / `odd/pronunciation-normalization/tasks` (#1680), prompt capture off, no nested wrappers.
- [Open-Vox overview](../../README.md)

## Local preparation context

Original SHAs, test results, host observations and branch states above are historical evidence, not fresh verification. The new local chain is tracked in [PN delivery preparation](pn-main-delivery.md); P3b/P4 remain deferred. No publication is authorized.
