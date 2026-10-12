# Pronunciation-oriented text normalization

**Status: IN PROGRESS — PN-I01 implemented and locally verified; owner review and commit pending (2026-10-11).** PN-I02–PN-I04 remain unimplemented. This document is the feature tracker, not proof of overall completion. Locator: `odd/tasks/pronunciation-normalization.md`, relative to the authoritative write root `C:/Users/pc/Documents/open-vox-pn-implementation`. Engram project: `agentvoz`.

## Current authorization and next action

On **2026-10-11**, the user explicitly authorized production pronunciation normalization (PN), the decisions below, and feature-branch-chain planning. This supersedes the earlier documentation-only constraint and PN-04's separate-approval wait. It does not complete any task. The earlier tracker update was **planning/tracking only, before the first production source write**: its restriction that only the task file could change applied to that historical pass, not to the authorized implementation that follows.

The user subsequently explicitly authorized an isolated worktree from the original reviewed base to avoid the concurrent playback checkout. The parent observed and verified `C:/Users/pc/Documents/open-vox-pn-implementation`, branch `feat/pn-implementation`, HEAD `975b447`, clean before this tracking update. These are parent-observed facts supplied to this writer; no commands were rerun here. The first boundary remains `975b447`.

**Worktree isolation:** all PN implementation writes belong in `C:/Users/pc/Documents/open-vox-pn-implementation`. The original checkout `C:/Users/pc/Documents/open-vox` is **read-only** for this work and contains concurrent dirty playback changes plus the earlier dirty PN tracker. Read its task document only as the approved tracking source; leave its old tracking and playback changes untouched. Do not mutate, restore, or copy source files there, or import concurrent source changes into the isolated worktree.

The earlier resumed tracking pass changed only `odd/tasks/pronunciation-normalization.md` in the isolated worktree and its authorized Engram mirror. Its pass-specific restriction did not rescind production authorization. The PN-I01 writer subsequently verified branch `feat/pn-implementation`, HEAD `975b447`, and only the approved tracker dirty before implementation. **Next action:** parent-owned ordinary review and commit for PN-I01 under the parent-reported RDD-off route, then PN-I02 against the exact approved candidate. No commit, remote push, PR, SDD artifact, Obsidian mutation, Kokoro-environment change, or model download was performed by the implementation writer.

## Approved scope and invariants

Build a non-mutating derived narration representation for Spanish and English technical text. Preserve meaning and the authoritative original; do not arbitrarily translate, paraphrase, summarize, or use an LLM. The earlier competitor/LLM premise remains user-reported and unverified, not a research finding or an implementation requirement.

| Area | Approved decision / required outcome |
| --- | --- |
| Base language and voice | Add an explicit configurable narration base language, initially `es`, supporting `es` and `en`. Select the existing corresponding ES/EN voice slot once per narration; hold that one voice constant across all bilingual segments. Existing voice controls retain their meanings. |
| Synthesis and LID | Use the installed Kokoro82M ONNX engine and contextual local LID from the approved sagorsarker checkpoint, pinned to revision `66d0e899b3fcf70d8727e4521c7a9c3f7a1fa73c`. No external inference or external text transfer. Managed provisioning is separate from inference; missing assets must yield explicit diagnostics, not an online inference fallback. |
| Representations | Keep separate, versioned JSON pronunciation policies and a versioned narration plan. Neither changes UI, history, or original source text. Preserve source traceability even when spoken content is omitted or normalized. |
| Input bounds | Retain the current 4000-character cap. Make over-limit behavior explicit and observable; never silently cut a technical token. No unlimited-input or pre-generation pipeline is approved. Verify the existing count/limit outcome before integration and record it in tests. |
| Phoneme bounds | Handle the raw-phoneme 510 limit through safe bounded synthesis units. Test the actual engine boundary; never silently truncate phonemes or split protected technical meanings to force a fit. An unsplittable unit requires an explicit safe failure/outcome. |
| Playback lifecycle | Preserve pause, instance/session ownership, generation guards, replay, and cache behavior. Cached Repeat reuses the exact stored audio and bypasses normalization and synthesis. |
| Other engines | Declare non-Kokoro capabilities and fallback behavior explicitly. Do not send a phoneme plan to an engine that does not support it or imply equivalent bilingual pronunciation. |

### Plan and source-offset wire contract

PN-I01 must define and test the wire contract before PN-I03 integrates it. Source references always address the **unchanged original**, never the normalized text, phoneme string, or omitted-content announcement. The wire must explicitly declare its offset unit, range convention, schema version, base language, structural units, source ranges, derived text/phonemes, and policy/decision trace. Do not infer offsets from transformed string lengths.

Record the existing source-offset convention after inspection and preserve compatibility. Define conversion at the TypeScript/Python boundary explicitly, including non-ASCII text, surrogate pairs, combining characters, repeated substrings, and omitted Markdown. Reject unsupported versions or invalid/out-of-range spans rather than inventing traceability. Until this contract is inspected and specified, its exact offset unit is an **open integration gate**, not a claimed existing API.

## Markdown narration policy

Support common Markdown plus GFM tables; preserve the original raw Markdown and trace every derived unit to it.

| Source construct | Narration behavior |
| --- | --- |
| Paragraphs, headings, list items | Preserve structural boundaries; retain ordered-list numbering. Punctuation and boundaries support pauses but do not guarantee natural phrasing. |
| Emphasis | Speak plain text, not formatting markers. |
| Technical inline code | Protect identifier, command, flag, version, path, number, and symbol meanings; apply only approved pronunciation rules. |
| Fenced/indented code blocks | Omit contents; announce `Bloque de código omitido` for `es`, `Code block omitted` for `en`. |
| GFM tables | Omit contents; announce `Tabla omitida` for `es`, `Table omitted` for `en`. |
| Links and raw URLs | Speak visible link text; omit destination URLs and raw URLs. Retain raw source and omission trace. |
| Images | Speak alt text when present; do not invent a description when absent. |
| Blockquotes | Speak their text with structural boundaries. |
| Thematic separators | Silent separation. |
| HTML and comments | Omit; do not expose markup or comment contents as narration. |

### Resolver priority and phoneme safety

Apply this order, with deterministic policy decisions taking precedence over detector evidence:

1. Acronyms: spell letters in the configured base language according to policy.
2. English identifiers: segment into English words without translation (for example, `getUserName` to `get user name`); preserve original meaning and source trace.
3. Known names: explicit policy for names such as `GitHub`, `TypeScript`, and `Docker`.
4. Whole known expressions: explicit whole-expression policy, such as `Open editor`; do not partially resolve a known expression.
5. Contextual English/Spanish evidence from the pinned local detector.
6. Configured-base-language fallback for unresolved or ambiguous text, including ambiguous names.

Do not extend an English decision to adjacent text merely because it is nearby. Protect versions, locale-sensitive numbers, paths, commands, flags/options, and symbols against meaning-changing expansion. Raw URL omission is a Markdown decision, not permission to alter the original URL.

Map angular quotes to ASCII quotes **only in final synthesis phonemes**, explicitly tracing the substitution while preserving raw source and intermediate evidence. Other unsupported phonemes fail explicitly; do not silently drop or generalize them.

## Historical tasks — retained, not completion evidence

The original PN-01–PN-05 IDs remain recognizable below. Their old documentation-only status described the earlier authorization, not today's authority. All remain unchecked; the active delivery checklist is PN-I01–PN-I04.

- [ ] PN-01 — Define language/context rules, ambiguity fallback, and protected technical tokens. Approved decisions now guide PN-I01 and PN-I02; production contracts/tests remain pending.
- [ ] PN-02 — Historical deterministic-versus-optional-LLM evaluation proposal. Superseded in scope by deterministic policies plus pinned contextual local LID; no LLM, provider selection, or external inference is approved. Remaining latency, resources, privacy, offline operation, reproducibility, and naturalness evaluation belongs to PN-I02 and PN-I04.
- [ ] PN-03 — Derived speech integration separated from the authoritative original, with pause, ownership, replay, and cache guards. Active work: PN-I01 and PN-I03.
- [ ] PN-04 — Historical instruction to await separate implementation approval. That wait was superseded by explicit production authorization on 2026-10-11; PN-I01 is now implemented but not owner-reviewed or committed. Active work: PN-I01–PN-I04.
- [ ] PN-05 — Regression and listening evaluations for meaning fidelity, pauses, and fluency. Active work: PN-I03 and PN-I04; no production improvement is claimed.

## Delivery strategy and review boundaries

- `delivery_strategy: auto-chain` — resolved user consent for chain planning, not permission to publish.
- `chain_strategy: feature-branch-chain` — do not switch to stacked-to-main delivery.
- Forecast: **1500–2500 authored changed lines including tests**; an estimate, not a measured diff. Review budget is advisory **400 additions + deletions per unit/slice** for this plan. Each unit may need cohesive sub-slices; do not code-golf or remove tests/docs to fit.
- Make one honest slicing pass when actual diffs exist. Record actual additions/deletions and explain cohesive overages; recommend an owner-approved exception if needed, without fabricating approval.
- First boundary: **`975b447`**, the parent-verified initial HEAD of `feat/pn-implementation` in the isolated worktree. Later boundaries must be exact candidate commits from the immediately preceding unit/slice, not the accumulated branch or a checkbox. No PN implementation commit identities beyond the initial boundary exist in this tracker.
- Local order: `975b447 -> PN-I01 -> PN-I02 -> PN-I03 -> PN-I04`. Each unit includes its behavior, tests, relevant docs, verification evidence, and rollback scope. Preparation and implementation use the isolated worktree, never the concurrent playback checkout.
- Future publication, if separately authorized, uses a draft/no-merge feature tracker and children targeting the tracker branch, then the immediate parent branch. No tracker PR, child PR, remote branch, or additional local slice branch is created by this update.

### Native RDD authority

Record the user-decided **global native RDD** route for all units. This pass does not inspect or change the runtime kill switch. Before a candidate review, the owner must verify the effective mode and use the **owner CLI only**; if disabled, report `disabled/unmanaged` rather than fabricating receipts. Bind any future review and lineage to the exact candidate and previous reviewed boundary. No review, approval, receipt, correction transaction, or delivery-gate success is claimed now. Delegation assigns preparation/implementation work, not review authority.

**Current corrective route (2026-10-12):** parent reports RDD off and requests one ordinary bounded correction. The global native route above is retained as historical authorization, not a claim that it ran. No native review/receipt is created or asserted; parent owns ordinary re-review and closure.

## Active work units — completion gates pending

Every unit uses a **delegated route** because it requires multi-file implementation and preparation. This tracker records the route only; no delegation is launched here. Tests and docs travel with their behavior. No unit is complete until candidate-bound verification and owner review evidence are recorded.

### PN-I01 — Markdown structure, contracts, policies, bounded text

- [ ] Define versioned JSON policy and narration-plan contracts, explicit source-offset wire semantics, and immutable-original traces.
- [ ] Implement common Markdown/GFM structural extraction and the approved omissions, announcements, numbering, and protected meanings.
- [ ] Cover the retained 4000 cap, explicit limit outcome, no technical cuts, and source-range conversion in bounded text tests.
- **Route:** delegated implementation prepared and verified below; owner review/commit still pending. Dependency/start: `975b447`; end: pending exact candidate.
- **Initial expected checks (historical):** focused `bun test` for new structure/contract/policy/text-boundary modules and `bun run typecheck`; concrete paths and observed results are now recorded below. Runtime boundary: preparation input to serialized narration plan; prove untouched originals and explicit over-limit behavior.
- **Rollback:** remove this unit's new parser/contracts/policies and preparation entry points with their tests/docs; restore the prior preparation behavior. If later units depend on these contracts, unwind dependents first, never leave an incompatible wire consumer.

#### PN-I01 implementation evidence — not owner review or completion

- **Independent API:** `createNarrationPlan(original, defaultLanguage = "es", policy = defaultNarrationPolicies)` in `src/markdown-narration.ts`; `validateNarrationPolicies`, `validateNarrationPlan`, `validateSourceRange`, and `flattenNarrationPlan` in `src/narration-plan.ts`. No active sink/plugin/settings imports were added. Existing `prepareSpeech` and its 4000-code-unit default remain unchanged; inspection found no pre-existing source-range wire in preparation.
- **Wire:** schema version 1; `offsetUnit: utf16`; `rangeConvention: end-exclusive`. Every segment/block/omission addresses the exact unchanged `original`. Blocks carry structural type, newline boundary, list depth and quote depth. Segments carry text/source/protection/kind and optional reason. Policy is a detached JSON snapshot. `languageStatus: unresolved` explicitly defers language decisions and phonemes to PN-I02; dictionaries are not yet a resolver.
- **Python boundary for PN-I02:** do not apply UTF16 offsets directly to Python code-point indices. Build cumulative UTF16 prefix lengths over the unchanged original (BMP scalar: 1 code unit; non-BMP scalar: 2); map both endpoints only at exact prefix boundaries. Reject mid-surrogate/out-of-range offsets and unsupported versions. Combining marks retain their own offsets; do not normalize Unicode or search for repeated labels. Conversion code and cross-runtime execution remain PN-I02 work, not claimed here.
- **Policies:** `resources/narration-policies.json` governs code/table announcement versus omission, image alt versus omission, visible links, URL/HTML/definition omissions, separators, and unknown-node omission versus failure. API/HTTP bilingual spellings, English names/whole expressions and explicit configured-language fallback are validated for PN-I02 reuse. Invalid schema/types/enums/counts/spans fail closed.
- **HTML safety (corrected):** paired block/inline HTML shares source-ordered suppression across AST blocks, including nested elements. Valid closing tags restore following Markdown text; unclosed/mismatched elements conservatively omit the remainder. Tag scanning is limited to AST-recognized HTML, respects quoted attributes/comments/processing instructions/CDATA and raw-text elements, and never renders or executes HTML. Unsupported GFM footnotes remain explicitly traced/omitted, or fail under the configured unknown-node policy.
- **Bounds:** flattened spoken input counts UTF16 code units including newlines, ordered numbering and announcements, at most 4000 (policy may lower, never raise it). Stop at lexical/segment boundaries, retain structural blocks, and trace the omitted source suffix. Inline code is literal and indivisible; an oversized technical unit yields `unsplittable`, while remaining-space exhaustion yields `truncated`. Neither technical tokens nor surrogate pairs are cut; there is no phoneme-510 or audio claim.
- **Parser/install:** public-registry `bun add --registry https://registry.npmjs.org mdast-util-from-markdown@2.0.3 mdast-util-gfm@3.1.0 micromark-extension-gfm@3.0.0` installed 90 packages including the already declared dev dependencies in this worktree, with `package.json`/`bun.lock` updated. No existing `node_modules` was present. Installed entrypoints and runtime namespace exports confirmed `fromMarkdown`, `gfmFromMarkdown`, and `gfm`; Context7's `gfmExtension` example aliases were not used. No ambient credentials were inspected, no private text sent to documentation services, and no ML assets installed.
- **Observed RED:** focused `bun test test/narration-plan.test.ts test/markdown-narration.test.ts` against callable scaffolds: 0 pass, 16 fail, 20 assertions. Failures included actual narration, bounds and rejection behavior, not only missing imports. Later targeted regressions exposed cross-paragraph HTML leakage and incomplete limit traces before their fixes.
- **Initial GREEN (historical):** `bun test test/narration-plan.test.ts test/markdown-narration.test.ts`: 25 pass, 0 fail, 142 assertions (117 ms). `bun run typecheck`: exit 0. `bun test`: 349 pass, 2 skip, 0 fail; 351 tests across 17 files, 1051 assertions (6.57 s). Later independent findings prompted the single corrective transaction below. No repository formatter/normalizer script is configured; no formatter was introduced. `git diff --check` passed with Git's existing LF-to-CRLF warnings only.
- **Runtime evidence:** deterministic tests exercise the actual maintained parser and serialized structural wire, Unicode/repeated-label source ranges, both announcement languages, protected literals, exact/over-cap cases, HTML and policy negatives. Existing legacy preparation regression tests pass. Actual Kokoro, local LID, playback lifecycle and listening checks are N/A for this disconnected unit and remain PN-I02–PN-I04 gates.
- **Initial authored budget (historical):** production modules/policy/tests/package manifest: 694 additions, 0 deletions; generated `bun.lock` excluded. Before correction, base-relative total including the tracking transplant and this evidence section: 853 additions + 43 deletions = 896 authored changed lines. Tracker then: 159 additions + 43 deletions; generated lock: 123 additions, reported separately. Parent's earlier tracker transplant is not newly authored production work by this writer.
- **One slicing pass:** contract/policy validation and parser/boundary behavior are conceptual review sections, but `test/narration-plan.test.ts` also exercises the actual parser/bounds and the wire snapshot travels with it. Keep PN-I01 cohesive with tests/docs; it exceeds 400 lines. Parent should authorize a cohesive-size exception or prepare candidate-bound review slices without deleting tests, minifying, or changing `feature-branch-chain`. No exception/review approval, branch, PR or commit is fabricated.
- **Exact rollback surface:** remove `src/narration-plan.ts`, `src/markdown-narration.ts`, `resources/narration-policies.json`, `test/narration-plan.test.ts`, `test/markdown-narration.test.ts`; revert only these parser dependency entries/lock changes and PN-I01 evidence in this tracker. Preserve the pre-existing approved tracker transplant and all playback work. No active speech preparation behavior needs restoring because it was never changed. Unwind later consumers first if subsequently integrated.

#### PN-I01 bounded correction — 2026-10-12, parent closure pending

- **Confirmed findings / RED:** new regressions reproduced block HTML leakage, lost visible postfix after cross-paragraph inline HTML, lexical joins after omissions, non-HTTP URI autolink speech, and protected inline-code whitespace trimming. Focused `bun test test/narration-plan.test.ts test/markdown-narration.test.ts`: 24 pass, 8 fail, 151 assertions before source correction.
- **HTML correction:** `htmlOmissions` computes merged original-source intervals from a shared tag stack over AST HTML nodes; extraction suppresses every covered block/inline unit. Nested outer elements remain hidden until their matching close. Valid closes restore following prose, while unclosed/mismatched markup remains conservative. Exact omission spans are validated and serialized; quoted `>` and `/>`, comments, processing instructions, CDATA and raw-text tags cannot introduce false opens/closes.
- **Separation / URL correction:** one pending-omission path inserts a source-traced space only between adjacent Unicode word characters, avoiding concatenation after HTML/comments, empty/omitted images, unknown footnotes and raw autolinks. Existing whitespace and punctuation are not gratuitously rewritten. All parser-recognized non-explicit autolinks (URI/email/GFM WWW) are omitted; explicit Markdown link labels remain spoken, even when a deliberate label is itself a URL. Windows/POSIX paths and protected code remain intact.
- **Protected whitespace / bounds:** flattening trims only unprotected layout whitespace, retaining the inline-code value after CommonMark's own whitespace normalization. This is not byte-for-byte preservation of raw code delimiters/spacing. Inserted separators and preserved protected spaces count toward the cap. An oversized announcement is safely omitted with `truncated` and `length-limit`; oversized inline technical code yields `unsplittable`. No announcement or technical token is partially cut.
- **Final verification:** focused command above: 32 pass, 0 fail, 201 assertions (132 ms); `bun run typecheck`: exit 0; one final `bun test`: 356 pass, 2 skip, 0 fail, 358 tests across 17 files, 1110 assertions (6.44 s); `git diff --check`: passed with existing LF/CRLF warnings only. Source follows existing formatting; no configured normalizer or new formatter. Active speech/audio/model runtime remains unchanged and unexercised by this structural correction.
- **Scope / rollback:** only the two narration modules, their two test files, and this tracker changed in the correction; no dependency/lock/resource changes or new modules. Revert these correction edits together to restore the pre-correction PN-I01 implementation; that rollback reintroduces the confirmed defects and is not a recommended shipping state. Original worktree, source/UI/history, Kokoro, models, commits and remotes remain untouched.
- **Current authored budget:** narration modules/tests/policy/manifest total 825 additions, 0 deletions against `975b447` (131 net new lines over pre-correction production artifacts). Full authored total including tracker transplant/evidence: 996 additions + 43 deletions = 1039 lines, excluding generated lock (unchanged 123 additions). Tracker: 171 additions + 43 deletions. The existing one-pass slicing/size-exception recommendation remains; no new slicing loop, native review, review approval, receipt or overall PN completion is asserted.

### PN-I02 — Python local detector and deterministic resolver

- [ ] Add pinned local contextual detector loading and resolver precedence, known names/expressions, ambiguity fallback, and no adjacent English extension.
- [ ] Add policy/trace tests for acronyms, identifiers, technical meanings, angular-quote final-phoneme substitution, and explicit unsupported-phoneme failure.
- [ ] Define explicit local-asset failure behavior, deterministic reproducibility, and offline inference; no hidden network fallback.
- **Route:** delegated; prepare Python adapter/model/policy boundaries. Dependency/start: PN-I01 exact candidate, pending; end: pending exact candidate.
- **Expected checks, not run:** Python `unittest` with an explicit new discovery runner (`python -m unittest discover -s <new-test-directory> -p 'test_*.py'`); resolve and record the concrete directory/interpreter before execution. Focused `bun test` for wire/adapter contracts and `bun run typecheck`. Runtime boundary: plan input through local resolver output, including offline/missing-asset negative controls.
- **Rollback:** remove this unit's detector/resolver/adapter additions with their tests/docs and restore the prior Python synthesis entry behavior; PN-I01 contracts may remain inactive. Unwind dependent integration first.

### PN-I03 — Plan-aware engine/sink, fixed voice, base language

- [ ] Integrate plan-aware engine and sink, one fixed voice from the configured base-language slot, and a new `es`/`en` base-language setting without redefining voice controls.
- [ ] Bound raw phonemes safely at 510; preserve structural pauses and explicit unsplittable/unsupported outcomes, without unlimited-input or pre-generation behavior.
- [ ] Declare non-Kokoro capability/fallback behavior and test it, rather than implying phoneme support.
- [ ] Prove pause/resume, cancellation, session/instance ownership, generation supersession, and exact cached Repeat with zero preparation/synthesis on repeat.
- **Route:** delegated; prepare lifecycle and engine/sink/settings impact map. Dependency/start: PN-I02 exact candidate, pending; end: pending exact candidate.
- **Expected checks, not run:** focused `bun test` for engine/sink/settings/cache/lifecycle modules, `bun run typecheck`, and the concrete Python unittest runner. Runtime checks must exercise the actual installed Kokoro path, bilingual fixed-voice output, bounded units, fallback engine, pause/resume, stale ownership/generation, and cached Repeat; mocks alone do not prove playback.
- **Rollback:** restore prior engine/sink/settings wiring and lifecycle behavior, removing this unit's base-language control and integration tests/docs; keep existing ES/EN voice meanings and cached audio compatibility. Earlier policies/resolver may remain disconnected, not partially wired.

### PN-I04 — Managed provisioning, doctor, docs, full evidence

- [ ] Add managed pinned model provisioning and doctor diagnostics for local readiness, exact checkpoint/revision, dependencies, and clear offline/missing-asset failures.
- [ ] Document settings, narration policy, capabilities, source/wire contract, limits, provisioning versus inference, and operational failure behavior.
- [ ] Run full regression and record exact candidate/commands/results, startup and warm narration latency/resource measurements, and production listening evidence for ES/EN fidelity, pauses, and fluency.
- **Route:** delegated; prepare provisioning/diagnostics/docs/verification surfaces. Dependency/start: PN-I03 exact candidate, pending; end: pending exact candidate.
- **Expected checks, not run:** full `bun test`, `bun run typecheck`, explicit Python unittest runner, managed provisioning/doctor scenarios, and actual-engine lifecycle/audio/latency evaluation. Provisioning network access must not be confused with external text inference; verify offline narration after provisioning.
- **Rollback:** remove this unit's provisioning/doctor additions and related docs/tests, restore prior managed setup behavior, and disable PN if required assets are no longer available. Do not uninstall the user's existing Kokoro installation or delete unrelated model assets. Roll back dependent integration as necessary.

## Evidence ledger and acceptance gate

| Evidence | Status / permitted conclusion |
| --- | --- |
| Scratch listening: 15 phrases | Historical preparation evidence reported positively by the user; not production fidelity, latency, integration, or lifecycle proof. |
| Scratch resolver tests: 13; adapter tests: 20 | Historical preparation results supplied for this plan; not rerun or independently audited here, and not proof of production integration. |
| Parent tracking baseline | Parent verified the isolated worktree on `feat/pn-implementation`, HEAD `975b447`, clean before the tracking transplant. The tracking writer did not rerun commands or inspect concurrent playback source; implementation writer checks are recorded above. |
| Earlier tracking-only update | Approved scope/history transplanted from the original checkout's task document into the isolated worktree. Planning only; no production writes, dependency/test edits, commands, functional tests, synthesis, or listening sessions performed in that earlier pass. Original checkout and its dirty tracker/playback changes left untouched. |
| Production candidates/reviews | No commits or reviews recorded. Authored-line counts are recorded above; exact candidates, owner CLI reviews, and receipts remain pending. |
| PN-I01 implementation | Independent structural API implemented and locally verified as above. Work-unit checkboxes remain unchecked pending parent-owned candidate review/commit. Active narration, resolver, models and playback wiring are unchanged. |

Future acceptance must cover both configured languages and negative controls, not just favorable samples:

- [ ] Original UI/history/source stays unchanged; versioned policy/plan validation and source offsets are explicit and correct across TypeScript/Python and Unicode cases.
- [ ] Approved Markdown behavior, acronym priority, English identifier segmentation, known-name/expression policy, contextual evidence, and configured fallback all match golden/contract cases without arbitrary translation.
- [ ] Cases include `getUserName`, `API`, `HTTP`, `>=`, `v1.2.3`, Windows/POSIX paths, raw URLs/links, locale-ambiguous decimals, commands/flags, angular quotes, code/tables/images/HTML, and ambiguous adjacent-language text.
- [ ] 4000-character and 510-phoneme boundaries produce explicit outcomes, preserve protected meanings, and do not introduce unlimited input or pre-generation.
- [ ] One configured voice stays constant across bilingual segments; base-language changes do not change the meaning of existing voice controls. Non-Kokoro behavior is explicit and tested.
- [ ] Exact cached Repeat causes no preparation or synthesis; real runtime evidence covers pause, ownership, sessions, generation supersession, cancellation, and failure recovery.
- [ ] Managed pinned assets/doctor and offline inference are verified, with no external inference, text transfer, paraphrase, or LLM.
- [ ] Full regressions, latency/resource measurements, and listening results are candidate-bound. Naturalness is judged by audio evidence, never guaranteed by structure or scratch success.

## Remaining preparation gates and tracking

Before the corresponding source changes, inspect the current offset/limit/lifecycle contracts and identify concrete module/test paths in the isolated worktree. Before provisioning, verify the exact approved sagorsarker checkpoint locator and artifact integrity alongside the pinned revision; do not guess a model ID. Record measurable latency/listening acceptance thresholds before claiming improvement. These gates refine execution; they do not reopen the approved scope or silently invent requirements.

- [Open-Vox overview](../../README.md)
- Authoritative current root: `C:/Users/pc/Documents/open-vox-pn-implementation`; branch `feat/pn-implementation`; initial reviewed boundary `975b447`.
- Engram full-document mirror: project `agentvoz`, topic `odd/pronunciation-normalization/tasks`, locator `odd/tasks/pronunciation-normalization.md` relative to the authoritative current root. Mirror observation identity/readback is recorded in the delivery report, not hard-coded before save.
- Original checkout `C:/Users/pc/Documents/open-vox` remains read-only; its earlier dirty tracking document and concurrent dirty playback work remain untouched.
- Private sprint notes and Obsidian files remain untouched. No SDD artifacts are created.
- Playback-speed (including nested PS-05) and Repeat remain separate existing features; only their preservation requirements are recorded here.
