# Pronunciation-oriented text normalization

**Status: IN PROGRESS — I01 locally closed at `db77b0b`; I02 locally closed at `a7c9db9`; I03 implementation and scoped inference-packing correction verified, pending parent ordinary validation/commit (2026-10-12).** I04 managed provisioning, actual-player lifecycle closure and listening acceptance remain pending. This tracker is not overall completion evidence.

Locator: `odd/tasks/pronunciation-normalization.md` in `<pn-worktree>`. Engram project/topic: `agentvoz` / `odd/pronunciation-normalization/tasks`. This current document consolidates obsolete per-attempt details for a bounded full-document memory snapshot; it does not remove completed items or change review budgets. Historical implementation details remain in Git and separate discovery/session observations.

## Authorization, isolation and next action

- Production PN was explicitly authorized on 2026-10-11, superseding the earlier documentation-only and PN-04 approval-wait constraints. No LLM, external text inference, translation, paraphrase or arbitrary summary is approved.
- Authoritative write root: `<pn-worktree>`, branch `feat/pn-implementation`. Initial boundary `975b447`; I01 end/I02 start `db77b0b`; I02 end/I03 start `a7c9db9`. Parent independently validated all original I01/I02 findings as resolved and committed both. I03 initially observed clean HEAD `a7c9db9`; this correction observed the same HEAD with the existing uncommitted I03 candidate.
- Original checkout `<playback-worktree>` and its concurrent playback/OnOff work are outside this unit. Neither inspected nor changed by I03 or this correction. No user environment/assets/dependencies were modified, no downloads, child agents, commits, remote publication, SDD/Obsidian artifacts or autoplay.
- Correction edit scope: only `scripts/narration_synthesis.py`, `test/python/test_narration_synthesis.py` and this tracker. Parent owns Git and ordinary validation/commit against `a7c9db9`. CodeGraph mapper failure/no index was supplied; authorized direct file reads were used, without initialization.
- Native RDD: parent verified off for `clone_local`. Historical global native-route authorization does not assert that it ran. No native review, receipt, lineage or delivery-gate success is fabricated; this writer does not change the mode.
- **Next action:** parent ordinary validation/commit of corrected I03, then I04 provisioning and runtime closure.

## Approved contracts and policies

| Area | Required behavior |
| --- | --- |
| Original/source | Narration is derived; original UI/history/source remains unchanged. Versioned policies, structural plan and resolved envelope are separate representations. Source ranges always address the unchanged original. |
| Base language/voice | Explicit `es`/`en` narration base, initially `es`. Select one existing corresponding voice slot once per synthesis and keep it constant across all languages. Existing voice controls retain their meanings. |
| Engines | Kokoro ONNX supports language-specific G2P/raw phonemes. Piper/SAPI receive bounded flattened text and configured language, never JSON/phonemes; reduced pronunciation is explicit, not equivalent bilingual support. Actual availability selection remains Kokoro/Piper/SAPI. |
| Input/expansion | Retain <=4000 UTF16 narration units, including structural separators, numbering and announcements. Explicit cap outcome/omission trace; no technical-token cuts or unlimited input. Resolver expansion over cap fails readiness without cutting. |
| Inference | Pack adjacent G2P fragments within each block into <=510 final raw phonemes, counting inserted boundary spaces. Language-run boundaries are not automatic model boundaries. Never split protected technical units to force a fit; indivisible oversize fails. |
| Local LID | Approved `sagorsarker/codeswitch-spaeng-lid-lince`, revision `66d0e899b3fcf70d8727e4521c7a9c3f7a1fa73c`. Existing local assets only, no inference downloads/external transfer. Missing assets/dependencies yield diagnostics and deterministic policy/base fallback. Provisioning and integrity remain I04. |
| Lifecycle | Preserve queues, accepted ownership, instance/session guards, generation supersession, stop/pause, candidate promotion and cache hold/discard/error handling. Exact cached Repeat has no text/preparation/resolution/synthesis. |

### Markdown behavior

| Source construct | Narration |
| --- | --- |
| Paragraphs/headings/lists/quotes | Speak text, retain structural boundaries/list numbering/depth. Pauses support structure but do not guarantee natural prosody. |
| Emphasis | Plain text without formatting markers. |
| Inline technical code | Preserve protected identifiers, commands, flags, versions, paths, numbers and symbol meanings; only approved rules apply. CommonMark's own code whitespace normalization is not raw-byte preservation. |
| Fenced/indented code | Omit contents; announce `Bloque de código omitido` / `Code block omitted`. |
| GFM tables | Omit contents; announce `Tabla omitida` / `Table omitted`. |
| Links/raw URLs | Speak explicit visible labels, omit destinations/raw autolinks; retain source/omission traces. |
| Images | Speak supplied alt text only; no invented description. |
| HTML/comments/definitions | Omit; paired/nested HTML suppression follows original source intervals, including across paragraphs. Valid closes restore prose; unclosed/mismatched markup is conservative. |
| Thematic separators/unsupported nodes | Silent separation; unknown nodes are traced/omitted or fail according to policy. |

Resolver precedence: configured acronym spelling; eligible English identifiers without translation; known names; whole known expressions; contextual ES/EN evidence; configured-base fallback. Deterministic policy decisions precede detector evidence. Do not extend English to adjacent text. Dictionary expressions cannot enter, leave or bridge protected units. Ordinary `(API)`/`(HTTP)` preserves parentheses and applies spelling; attached calls/commands remain protected. Dollar/environment references remain unchanged. Missing/gapped/conflicting/nonbinary evidence uses explicit fallback, not guessed accuracy.

Angular quotes map to ASCII quotes only in final synthesis phonemes. Preserve original/raw/intermediate evidence and substitution offsets. Other unsupported phonemes fail explicitly; no silent vocabulary filtering or invented replacements.

### Wire and trace references

- I01 schema 1: `NarrationPlan`, `offsetUnit: utf16`, `rangeConvention: end-exclusive`, `languageStatus: unresolved`, base language, detached policy, structural blocks/segments/omissions, bounded length and complete/truncated/unsplittable outcome. `createNarrationPlan`, validators and `flattenNarrationPlan` are maintained APIs.
- Python converts UTF16 endpoints through cumulative scalar prefixes; rejects mid-surrogate/out-of-range/unpaired-surrogate input. Combining marks are not normalized; offsets are never recovered by substring search.
- I02 resolved schema 1 retains an unchanged detached `structuralPlan`. Units preserve containing-original-segment `source`, UTF16 segment-text `derivedRange`, original derived text/spoken text/language/reason/protection and raw detector evidence. `decisionRange` and detector offsets address block-derived Python codepoints, not original offsets. `synthesisReady` and `resolutionOutcome` gate expansion/unsplittable input.
- I03 packed chunks preserve block identity and `runs[]`: block/run indices, language, run-local codepoint text range, unit/source/derived references, raw/adapted phonemes, run-local mappings, inserted `separatorBefore`, and chunk-local codepoint `phonemeRange`/`rawPhonemeRange`. Aggregate mappings are rebased to chunk phoneme offsets. These are trace boundaries, not fabricated exact original-token ranges. Quote mapping is one-to-one, so raw/final range lengths agree.

## Delivery and historical tasks

`delivery_strategy: auto-chain`; `chain_strategy: feature-branch-chain`. This is chain planning, not publication authorization. Advisory review budget is 400 additions+deletions per unit/slice, never code-golf or permission to remove tests. Preserve tests/docs with behavior. One slicing pass identified Python adapter/helper/tests and dependent TS integration/tests; parent should use candidate-bound review sections or approve a cohesive-size exception. No new branches/PRs or approval are invented.

Local dependency order: `975b447 -> I01 db77b0b -> I02 a7c9db9 -> I03 uncommitted -> I04 pending`. Future separately authorized publication would use a draft/no-merge tracker and children targeting the tracker, then immediate parent. Native review authority belongs to the owner, not delegation.

Historical PN-01–PN-05 remain recognizable, not completion evidence:

- [ ] PN-01 — Language/context, ambiguity fallback and protected meanings; active implementation is I01/I02.
- [ ] PN-02 — Earlier optional-LLM proposal superseded by deterministic policies/local LID; resource/accuracy evaluation remains I04.
- [ ] PN-03 — Derived integration and lifecycle/cache preservation; active implementation is I01/I03.
- [ ] PN-04 — Earlier separate-approval wait superseded by production authorization; not proof of delivery.
- [ ] PN-05 — Fidelity/fluency/listening evaluation remains I03/I04; no production quality improvement claimed.

## Active work units and retained evidence

### PN-I01 — Structure, contracts, policies and bounded text

- [x] Versioned contracts, explicit source offsets and immutable-original traces.
- [x] Common Markdown/GFM extraction, omissions/announcements/numbering and protected meanings.
- [x] Retained 4000 cap with explicit outcomes and safe source conversion.
- **Closure:** parent ordinary local commit `db77b0b` against `975b447`, independent corrections validated, native RDD off. Initially inactive; I03 now integrates it.
- **Retained correction evidence:** RED 24 pass/8 fail; final focused structural Bun 32 pass/0 fail/201 assertions; typecheck exit 0; full 356 pass/2 skip/0 fail. Fixed cross-paragraph HTML suppression/postfix recovery, joins after omissions, non-HTTP autolinks and protected-code whitespace. No active audio/model proof was asserted for this structural unit.
- **Budget/history:** authored I01 boundary 1039 changed lines, plus generated lock changes; prior install of maintained Markdown dependencies belongs to I01, not I03. Existing lock/dependencies remain untouched now.
- **Rollback:** unwind consumers first; remove I01 parser/contracts/policy/tests and its dependency entries together, preserving unrelated playback and approved tracking.

### PN-I02 — Local detector and deterministic resolver

- [x] Strict actual-wire validation, source conversion and detached resolved envelope.
- [x] Deterministic policy priority, protected meanings, known expressions/names, evidence-based identifier routing and configured fallback.
- [x] Existing-local-only contextual detector, bounded evidence/windows and explicit missing-asset/dependency failure behavior.
- [x] Text/policy/trace coverage; final-phoneme angular-quote/unsupported tests are supplied by I03, not claimed as I02 synthesis.
- **Closure:** parent ordinary local commit `a7c9db9` against `db77b0b`, all original findings independently resolved. Historical correction concerned protected dictionary boundaries, prose-parenthetical acronyms and dollar/environment references.
- **Retained tests:** corrected Python 37 pass; earlier 30 actual TS plans across ES/EN plus three corrected actual-wire repros; structural Bun 32 pass and typecheck exit 0. Python wire validation checks policy/schema/order/protection/cap/omission metadata and exact UTF16 boundaries. No TS/contracts changed in the I02 correction.
- **Detector:** lazy Torch/Transformers imports against present config/safetensors/tokenizer assets; absolute local path, `local_files_only=True`, `trust_remote_code=False`, CPU/eval/no-grad. Exact BERT token-classification label/config/logit shapes are validated; <=512 actual tokens per nontruncated window. Oversized indivisible atoms degrade evidence explicitly. Raw finite softmax scores are uncalibrated; revision declaration is not weight/hash attestation.
- **Historical live LID:** 118 tokens, one window, available, 4.166s including load, using the separate read-only scratch interpreter/model with offline flags and blocked sockets. Torch 2.14.1/Transformers 5.19.0; observed label counts en45/spa25/other41/ne4/unk3. Not rerun in I03/correction; no accuracy, warm/resource or hash claim. Mistral-regex heuristic warning and unexpected pooler weights require I04 compatibility attention; assets were not altered.
- **Rollback:** remove I02 validation/detector/resolver and their three Python tests after unwinding consumers. Existing Kokoro installation stays intact.

### PN-I03 — Plan-aware fixed-voice bounded synthesis

- [x] Plan-aware engine/sink with explicit `es`/`en` configuration and unchanged voice-slot meanings.
- [x] Bounded unfiltered per-language G2P, within-block raw-phoneme packing, fixed voice, explicit protected/unsupported/expansion failures and block pauses.
- [x] Explicit text-only non-Kokoro capability/fallback, actual-selected-engine live dispatch and tests.
- [ ] Parent ordinary validation/commit of the corrected uncommitted candidate.
- [ ] Actual-player lifecycle and listening closure; controlled sink/transport regressions are not observed real audio events.

**API/runtime contract:** callable `Engine(text, language)` and legacy `synthesize(text, language, wav)` remain; optional `speakPlan(plan)`/`synthesizePlan(plan, wav)` consume I01 plans. Sink reads base once per selection, contains parser/configuration failures, reports cap outcomes/retains omissions, skips empty omission-only plans, and guards preparation/promotion against generation changes. `liveEngine` selects actual available engine at execution; reduced text-only fallback is diagnosed once per engine identity. CLI `say` still shares the sink; `open-vox language es|en` writes explicit `Config.narrationLanguage` (default/reset `es`). Voice/speed snapshot once per synthesis, 0.5–2 speed range, killable 120s process budget.

**Python/artifact contract:** strict one-document JSON stdin and resolved-envelope readiness/trace validation; adjacent lexical/neutral units merge before language G2P. Unfiltered phonemizer output is validated before Kokoro tokenization; installed tokenizer methods otherwise silently drop unknown characters. Oversized runs split iteratively only at safe lexical/punctuation boundaries outside protected units. Valid fragments then pack across language boundaries within the same block, counting required source-boundary spaces before accepting <=510. Do not invent spaces without source whitespace or duplicate existing raw spaces. Structural block boundaries remain distinct and add conservative 0.18s silence; engine sentence/clause pause options are zero to avoid another explicit pause. No prosody guarantee. One reused Kokoro model/style per utterance, one raw `create` per packed chunk, sequential bounded audio (600s memory ceiling), one final mono 24kHz PCM16 WAV write only after all inference succeeds. Failed final write removes the candidate; sink retains cache ownership/cleanup.

**Local/privacy contract:** compatible legacy `kokoro_say.py` plus `--plan-json`; existing interpreter/model/voices reused unchanged. Future LID path `<app-home>/lid/codeswitch-spaeng-lid-lince/<REVISION>` reuses I02's revision constant. Offline/telemetry/bytecode flags, bounded validated helper diagnostic stdout, generic failure stderr without prose. Missing LID assets degrade evidence without disabling Kokoro. Managed interpreter/assets/hash readiness is I04.

#### Retained pre-correction evidence

- Initial behavioral/API RED: focused Bun 116 pass/5 fail; Python scaffold 44 tests, 6 failures/2 errors (one trailing-layout fixture mismatch disclosed). Old config/code-announcement expectations were corrected, not removed.
- Final prior TS evidence: `bun test test/speech-sink.test.ts test/kokoro-engine.test.ts test/wiring.test.ts test/config.test.ts test/cli.test.ts`: 127 pass/0 fail/366 assertions; `bun run typecheck`: exit 0; one full `bun test`: 367 pass/2 skip/0 fail, 1154 assertions. Prior Python: 50 pass. TS focused/typecheck/full results are retained, not rerun in this Python-only correction.
- Controlled coverage includes parser containment/parsing-stop race, Unicode/UTF8/offline diagnostics, settings snapshots, flattened fallback, stale successful synthesis rejection, exact Repeat bypassing preparation/synthesis callbacks, held-old-artifact pause sequencing, safe long chunks/protected oversize/expansion failures, unsupported/empty phonemes, angular mappings, model/style reuse and no partial artifact on inference/write failure. Installed tokenizer accepts510/rejects511 without inference.
- Historical actual Markdown runtime: ES phrase/known EN expression/acronyms across multiple blocks, five G2P runs incorrectly emitted as five chunks/five ONNX inferences, one `em_alex` style read; 2.082s execution, 6.269s mono24k PCM16 audio, missing-local-assets/detector-unavailable. This remains execution evidence, NOT correct mixed-run packing proof. Earlier test counted G2P/model-per-emitted-chunk, but did not assert one inference for a short mixed block.
- Historical outputs retained untouched: `<reference-assets>/synthesis.wav` and `synthesis-verification.json`. No autoplay/listening/LID accuracy claimed. Pre-correction authored candidate was 792 changed lines; that is historical, not this correction's current count.

#### Scoped correction — mixed-language inference packing (2026-10-12)

- **Confirmed root defect:** `prepare_chunks` equated each language G2P run with a model chunk. `Hola local, Open editor y seguimos.` produced three mocked `create` calls despite fitting one <=510 input. A fixed voice did not solve unnecessary inference boundaries.
- **Meaningful RED:** installed base Python `-B -m unittest discover -s test/python -p test_narration_synthesis.py`: 16 tests, 3 failures, 0 errors (0.700s); explicit model-create counter observed3 instead of1, packing/trace tests observed3 chunks instead of1.
- **Correction:** added within-block `pack_block`; preserves each run's raw/adapted phonemes, block/run identity, source/derived/run ranges, per-run/aggregate angular mapping offsets and exact separator accounting. It never merges blocks or cuts protected units. New tests distinguish G2P calls from model calls, exact combined510 versus511, source/non-source spacing, no duplicate raw space, shifted adaptation ranges and mixed-block pauses. Existing long/protected/unsupported/expansion/failure tests remain.
- **GREEN, once after refactor:** `<app-home>/kokoro-venv/Scripts/python.exe -B -m unittest discover -s test/python -p test_narration_*.py`: **56 tests pass (0.732s)**. Includes old37 + corrected synthesis19. No TS changes: prior focused127/typecheck0/full367+2skip retained without rerunning unchanged modules. No source mutation/formatter after final Python tests.
- **Actual production-boundary check, one invocation:** actual TS `createNarrationPlan` JSON via UTF8 stdin -> production I02 policy resolver -> actual unfiltered G2P -> installed Kokoro `em_alex`, offline flags and blocked Python socket connections. Original synthetic Markdown: `Hola local, Open editor y seguimos.`. Report proves one structural block (index 0), ES/EN/ES runs (indices 0/1/2) packed into **one 38-character raw input**, **one `create(is_phonemes=True)` call**, **one ONNX inference**, exactly **one `em_alex` style read**. Chunk phoneme ranges `[0,12)`, `[13,26)`, `[27,38)` preserve two inserted spaces. Execution **2.027s**; WAV **2.176s**, mono **24000Hz PCM_16**; no player invoked.
- **New authorized outputs only:** absent checks passed before generating `<reference-assets>/synthesis-packed.wav` and `synthesis-packed-verification.json`. JSON read back includes original fixture, structural block count, block/run indices, raw/adaptation/source/range metadata, exact combined length and actual call counters—not generic aggregate proof. Old outputs preserved.
- **Limitations:** helper explicitly emitted `detector-unavailable` and `missing-local-assets`; unchanged existing environment used deterministic policy/base fallback. No live managed LID, speech-quality, long-utterance acoustic fidelity, actual pause/resume/replay event or model-integrity claim. This is scoped packing execution proof, pending parent validation/commit.
- **Correction rollback:** remove only packing helper/call and six new regression methods to restore the prior I03 candidate; that restores the confirmed defect and is not recommended. Full I03 rollback removes the new adapter/synthesis test and reverts only prior allowed I03 TS/helper/test edits together, leaving I01/I02 inactive and installed assets/unrelated playback untouched.

### PN-I04 — Managed provisioning and operational closure

- [ ] Managed pinned local LID/interpreter/dependency provisioning and doctor readiness/hash diagnostics, with explicit offline/missing-asset failures.
- [ ] Operational docs for settings, policy/capabilities, source/wire references, limits and provisioning versus inference.
- [ ] Full candidate-bound regressions, cold/warm latency/resource measurements, real-player pause/ownership/session/generation/cancellation/replay/failure recovery and ES/EN fidelity/fluency listening.
- Dependency/start: corrected I03 exact parent candidate/commit, pending. Managed model warnings/dependency compatibility and artifact integrity remain open. No implicit download during narration; no alternative model or fake bilingual fallback.
- Rollback removes only I04 provisioning/doctor/docs additions and unwinds dependent integration if needed; never uninstall user's existing Kokoro installation or delete unrelated assets.

## Acceptance gates and retained limits

- [ ] End-to-end original UI/history/source invariance and exact wire/source trace behavior, including emoji/combining/repeated labels and omissions.
- [ ] Both base languages and negative controls: identifiers/API/HTTP/names/whole expressions, `>=`, versions, paths, URLs/links, numbers, commands/flags/variables, angular quotes, code/tables/images/HTML and ambiguous adjacent text.
- [ ] Observed 4000/510 outcomes/protected semantics and bounded full audio; mocks and short-runtime execution are not long-utterance listening acceptance.
- [ ] One voice across bilingual input, explicit reduced non-Kokoro capability, and exact cached Repeat without preparation/resolution/inference.
- [ ] Real-player lifecycle evidence and managed pinned offline LID readiness/integrity, not inferred from successful synthesis.
- [ ] Candidate-bound full regression/resource/listening acceptance; naturalness is judged from audio evidence, not structure or scratch success.

Historical scratch15-phrase listening and scratch13 resolver/20 adapter tests remain preparation-only reports, not production certification. Playback-speed/Repeat are separate existing features preserved here. Private notes/Obsidian and original concurrent work remain untouched.

## Tracking and review locator

- Current authority: this repository document; parent reviews the uncommitted corrected I03 candidate against `a7c9db9`.
- Engram mirror: save this full current document only at `agentvoz` / `odd/pronunciation-normalization/tasks`, with prompt capture disabled; no nested historical-memory wrappers or duplicate snapshots. Prior root#1680/continuation#1925 are historical bookkeeping, not the current full snapshot after refresh. Record new readback in the delivery report.
- [Open-Vox overview](../../README.md)

## Local preparation context

Original SHAs, test results, host observations and branch states above are historical evidence, not fresh verification. The new local chain is tracked in [PN delivery preparation](pn-main-delivery.md); P3b/P4 remain deferred. No publication is authorized.
