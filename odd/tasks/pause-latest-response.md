# Pause retains the latest completed response for Resume

**Status: PARTIAL ÔÇö implementation and fake test checks observed; final typecheck closure and independent acceptance pending.**
Project: `agentvoz`. Locator: `odd/tasks/pause-latest-response.md`.
Engram mirror: `odd/pause-latest-response/tasks`; pending. Both the discovery save and the single full-document mirror attempt returned `ambiguous_project` with unrelated projects. None were searched or selected; no retries were made. This local document remains authoritative.


## Port to `main` (2026-10-13)

The feature was re-applied on top of `main` (b5bdcdb), which already contains PN narration, playback speed and service On/Off; the original execution record below was written against the older P4 branch and its counts do not apply to `main`. Differences in the port:

- Session-scoped cancellation uses `main`'s existing `SpeechSink.stopSession`; no new `cancelSession` sink method was added, and `src/speech-sink.ts` is unchanged. Retention and Resume arbitration live in `createCoordinator`/`createOpenVox` in `src/plugin.ts`.
- The independent user-turn tracker in `createOpenVox` was removed: coordinator-validated events now drive cancellation, so invalid and duplicate user updates no longer reach the sink.
- Message removal now also cancels the affected session's work (previously only the coordinator generation was invalidated).
- Observed on `main` before the port: `bun test` 576 pass, 5 skip, 0 fail; `bun run typecheck` clean. After the port: `bun test` 611 pass, 5 skip, 0 fail (35 added tests); `bun run typecheck` clean. Opt-in real-host smoke tests were not run; no audio or live OpenCode session was exercised.
- The ledger below is the original record from the pre-port branch and is kept for history; its typecheck failure was in test code that is corrected in the ported tests.

## Authorized execution and handoff (2026-10-13)

PLR-I01 and writer-side PLR-V01 were explicitly authorized after the preparation below. README was additionally authorized only to reconcile paused-response semantics. This execution record supersedes preparation-only language elsewhere in this document; it does not authorize delivery or live acceptance.

**Implemented:** the coordinator owns one validated latest selection per instance, above both paused admission gates. Completion time determines freshness; synchronous eligible-event claim order breaks ties. A watermark survives slot consumption, and a consumed sequence boundary also rejects older fetches claimed before Pause. Session generations, service epoch, enabled checks and disposal guard every asynchronous SDK completion. Resume consumes once, stops obsolete frozen ownership before changing the paused flag, then admits the selected text without awaiting audio. With no pending selection, the existing same-handle Resume is unchanged.

**Lifecycle:** accepted fresh user turns, scoped errors, message removal and assistant errors clear affected text and cancel affected queued/active/frozen work without forgetting cached Repeat. Session deletion additionally forgets owned cache. Unscoped errors clear all pending ownership. Off invalidates the service epoch and clears pending text before existing stop/cache cleanup; On restores nothing. Disposal clears text and invalidates late fetches. Invalid and duplicate user updates no longer reach an independent cancellation tracker. `cancelSession` reuses stop's active/frozen cleanup while preserving other sessions' queued jobs.

### Observed checks

| Phase | Exact command | Observed result |
| --- | --- | --- |
| Focused baseline | `bun test ./test/plugin.test.ts ./test/wiring.test.ts ./test/speech-sink.test.ts ./test/repeat-control.test.ts ./test/repeat-ui.test.ts ./test/audio-cache.test.ts` | 237 pass, 0 fail, 0 skip; 896 assertions; 6 files. |
| Focused RED | Same exact focused command | 251 pass, 17 expected missing-behavior failures, 0 skip; 948 assertions; 6 files. |
| First focused GREEN | Same exact focused command | 268 pass, 0 fail, 0 skip; 968 assertions; 6 files. |
| Minimal refinement / focused check | Same exact focused command | 272 pass, 0 fail, 0 skip; 975 assertions; 6 files. Added pre-Pause fetch guards and scoped queue preservation. |
| Full suite, once | `bun test` | 443 pass, 4 skip, 0 fail; 1429 assertions; 447 tests across 15 files. |
| Typecheck, once | `bun run typecheck` | FAILED: TS2339 at `test/wiring.test.ts:30`, `:115`, `:185`; the newly added fixture assignments used `time.completed` before assistant-role narrowing. |
| Whitespace, once | `git diff --check` | Passed with no whitespace errors; only existing LF-to-CRLF conversion warnings. |

The three typecheck errors are introduced test-code errors, not claimed baseline failures. Assistant-role guards were added after the observed failure. **That final test correction has not been re-run:** the authorized once-only closure run was consumed. Source bytes were unchanged after the passing focused/full checks. Final corrected test bytes require parent typecheck and focused/full confirmation. Unexpected failure therefore forces a PARTIAL handoff, not verified completion.

RED evidence included default-state paused narration of A/B, injected-state loss of B, reversed session/response/parent fetch resurrection, completion-time ordering, Off/On resurrection, stale-user cancellation, cross-session cancellation and absent coordinator/sink lifecycle methods. Fourteen added cases already passed in RED because they protected existing invariants; no RED failure is claimed for them. The two replacement/ack cases were strengthened into full fake coordinator-to-sink integrations before GREEN. Four supplemental cases (three pre-Pause fetch races and one other-session queue case) were added after first GREEN and passed the refinement check; no independent RED is claimed for those four.

### Acceptance evidence and review locations

| Criteria | Fake-driven evidence |
| --- | --- |
| AC-01 / AC-02 | `test/wiring.test.ts`, `latest completed response during Pause`: A then B, duplicate completion/Resume, reversed SDK stages, reversed completion timestamps, equal-time tie and pre-Pause claim races. `test/plugin.test.ts`, paused coordinator: single slot and one consumption. |
| AC-03 / AC-07 / AC-09 | `test/speech-sink.test.ts`, replacement before synthesis with acknowledged/pending pause, zero obsolete resumes, released old holds, new session cache ownership, rejected old-session Repeat. |
| AC-04 | Existing real-pause fake tests: same handle, one synthesis, frozen holds, no-audio Resume and unsupported fallback no-op. No new same-position fallback claim. |
| AC-05 / AC-06 | Wiring invalidation matrix: new turn, scoped/unscoped errors, deletion, removal, assistant error, Off and disposal; each pairs retained B with delayed A. Stale/duplicate users preserve pending work. Service-epoch coordinator regression. |
| AC-07 / AC-08 | Other-session invalidation matrix, two-instance nonce targeting, disabled/incapable negative controls, consumed rejecting fake narration, scoped queue preservation and existing failure/ack cleanup tests. |
| AC-09 closure | Focused and full suite checks observed as above; typecheck failed and final correction is unverified. Independent parent review and live acceptance remain pending. |

The four real-host tests at `test/player.test.ts:1014,1044,1077,1116` require `OV_PLAYER_SMOKE=1`; the environment was unset and all four skipped. CLI setup/install/download paths use in-memory injected fakes; engine/player cases inject fake processes. The existing capable-plugin tests only create isolated temporary cache/config state and exchange injected metadata, never synthesize or start a host. No real audio, network, installs, loader edits, reload or host smoke was performed. `package.json` has only test/typecheck scripts and no configured mutating formatter; none was run.

### Preservation, delivery and next checks

Before any repository write, captured byte snapshots and SHA-256 hashes of all 47 tracked/untracked files, plus complete binary tracked and staged diffs, at `C:\Users\pc\AppData\Local\Temp\opencode\plr-baseline`. Original tracked dirty diff: 11 files, +1038/-100 (1138 authored lines); branch remained `feat/playback-controls-p4-speed`. Verification compares the candidate with those exact bytes, not HEAD. The saved `incremental.diff` isolates this unit; unchanged files and the staged diff are checked independently. Allowed overlapping files contain only targeted retention/cancellation/README additions or replacements; preexisting P4/PN/control/UI hunks were not rewritten.

Final incremental delta: README +11/-5; plugin +72/-26; sink +12/-4; plugin tests +31/-0; sink tests +74/-0; wiring tests +189/-0; this tracker +59/-4. Total **+448/-39 = 487 changed lines**, excluding the preexisting 1138-line dirty diff. All 40 baseline files outside the seven changed paths remain byte-identical; all eight preexisting dirty paths outside README/plugin/wiring are unchanged; the staged diff remains identical. The isolated source/test diff was read back, and the final test-role correction is explicitly pending re-execution.
The advisory 400-line budget is exceeded; retain readable tests and documentation. `delivery_strategy: ask-on-risk` applies before any future isolated commit, not this authorized edit. No staging, commit, branch change, push or reset occurred. The seven exact authorized paths are listed in the scope section. Whitespace was checked before this ledger-only outcome update; no formatter or subsequent source changes occurred.

- [x] PLR-I01 source/test read, observed RED, GREEN and minimal lifecycle refinement.
- [x] PLR-V01 focused baseline, fake behavior checks, one full suite, one typecheck and incremental readback.
- [ ] PLR-V01 final corrected test bytes pass typecheck and repeated focused/full checks (parent).
- [ ] Independent parent source/ownership/negative-control spot-check.
- [ ] User-authorized reload and live acceptance; process-loaded bytes and audible behavior remain unverified.
- [ ] Isolate overlapping dirty work and authorize an exact work-unit commit; commit remains blocked.
- [ ] Engram full-document mirror; do not select unrelated recovery projects.

Skills loaded from the requested `.agents/skills/work-unit-commits/SKILL.md` and `.agents/skills/cognitive-doc-design/SKILL.md`. CodeGraph absence was reconfirmed; per server instructions no index was created, and bounded source/test reads were used. Clone-local RDD stayed OFF; no lifecycle or receipt was invoked and no child agents were launched.

## Objective, problem, and why

While Pause is active, retain only the latest valid completed response, without narration. On Resume, narrate that response instead of continuing obsolete frozen audio. If no new response exists, continue the same frozen audio from the same position only when it remains valid. This is explicitly user-approved behavior, not a proposal awaiting a product decision.

Currently completed responses can be permanently lost during Pause: `src/plugin.ts:223-226` returns from `withPause` without forwarding the selection, while the coordinator already claims completed messages before asynchronous fetches (`src/plugin.ts:83-96`). Resume cannot rediscover those claimed messages. The sink independently rejects paused admissions (`src/speech-sink.ts:267-268`). Retaining one selection closes that gap without replaying every intermediate response or changing the written reply.

## Approved scope and constraints

- One bounded, in-memory latest-response slot per plugin instance, carrying session and freshness ownership; no persistent history, shared pending state, or FIFO backlog.
- Store only a successfully validated completed response. Do not retain partial text, tool messages, rejected selections, or startup history; do not synthesize or play retained text during Pause.
- A newer valid completion replaces the retained one. Older asynchronous fetches must not overwrite a newer completion; define and test deterministic freshness ordering at the coordinator boundary before writing production code.
- Resume consumes the valid retained response once, discards obsolete frozen playback before new narration, and does not briefly thaw the obsolete audio. Repeated Resume and duplicate completion updates do not replay it.
- With no new valid retained response, preserve the existing same-file, same-position Resume when the frozen handle is valid. Nothing valid means no playback, not a restart or re-synthesis of old audio.
- A new user turn invalidates obsolete pending text and frozen audio. Preserve duplicate/stale-user rejection and existing session ownership; do not invent cross-session authority or let a session-targeted invalidation restore or consume another session's response.
- Session errors, deletion, message removal, assistant errors, service Off, and disposal must invalidate affected pending ownership as appropriate. Unscoped session errors invalidate all pending ownership. Off/On and disposal/recreation never resurrect retained text.
- Preserve enabled/capable gates, exact cached Repeat, cache holds/deletion, failure containment, confirmed control state, instance targeting, and playback-speed behavior. The non-pausable fallback remains stop-on-pause; never claim same-position fallback Resume.
- Preserve all preexisting P4/PN dirty changes. No source implementation, tests, installs, staging, commits, branches, pushes, child agents, audio, or runtime lifecycle actions are authorized in this preparation pass.
- Live installation, reload, and listening are not yet authorized. No dependencies, engine changes, normalization changes, control-protocol expansion, or UI changes are planned.

## Inspected evidence and proposed boundaries

CodeGraph absence was already observed by the parent. Preparation used bounded existing task/source/test reads, not indexing or a broad repository survey.

| Evidence | Consequence for this unit |
| --- | --- |
| `odd/tasks/playback-controls.md`, D6 and P3a/P3b | Preserve real frozen playback, cancellation, Off cleanup, and per-instance controls; this feature refines paused completed-response handling only. |
| `odd/tasks/pronunciation-normalization.md`, lifecycle invariants | PN remains independent and untouched; cached Repeat must still bypass new preparation/synthesis. |
| `src/plugin.ts`, coordinator and `createOpenVox` | Keep claims/generation guards and cancellation events coherent with retained ownership, including asynchronous fetch invalidation. |
| `src/plugin.ts`, `withPause` and plugin construction | Both the paused admission gate and production/default Resume wiring need inspection before implementation; changing only the gate is insufficient. |
| `src/speech-sink.ts`, pause/resume/stop/pump | Existing frozen operations are serialized, stop aborts frozen acknowledgements, and the pump releases audio holds. Supersession must use those lifecycle boundaries rather than introduce a second playback path. |
| `test/plugin.test.ts` | Existing harness covers duplicates, two sessions, delayed fetches, invalidation, and failure containment. Extend it for retained freshness and no resurrection. |
| `test/wiring.test.ts:222-355` | Existing tests encode blocked paused narration and pass-through Resume; update only assertions superseded by retention, keeping silent Pause and control isolation. |
| `test/speech-sink.test.ts:309-479` | Existing fake pausable handles cover hold ownership, same-handle Resume, cancellation, and fallback. Extend for replacement before thaw and late acknowledgement races. |
| `package.json:5-7` | Runner is `bun test`; `bun run typecheck` invokes `tsc --noEmit`. No explicit strict-TDD configuration is known. |

**Exact authorized changed path set for this implementation:**

- `src/plugin.ts`
- `src/speech-sink.ts`
- `test/plugin.test.ts`
- `test/wiring.test.ts`
- `test/speech-sink.test.ts`
- `README.md` (paused-response semantics only; explicitly added by parent authorization)
- `odd/tasks/pause-latest-response.md`

The control/UI/cache tests below are regression checks, not edit surfaces. Player, protocol, UI, P4 tracker and PN tracker changes remain outside this unit. The preparation pass changed only this document; the separately authorized implementation uses the seven paths above.

## Acceptance criteria

- [ ] AC-01: While paused, completing A then B produces no synthesis/playback; Resume narrates B once and never A. Replaced slots are released rather than queued.
- [ ] AC-02: Reversed asynchronous fetch completion cannot replace newer retained B with older A; duplicate events cannot repeat the retained narration.
- [ ] AC-03: With a retained response, Resume stops obsolete frozen audio before starting new synthesis/playback; no old-audio thaw occurs, including a still-pending pause acknowledgement.
- [ ] AC-04: With no new response, valid frozen playback resumes through the same handle/file/position without synthesis; invalid or absent frozen playback stays silent. Unsupported fallback does not restart.
- [ ] AC-05: A new user turn invalidates obsolete retained text; delayed old completions cannot restore it. Repeated/stale user events do not incorrectly clear valid current work.
- [ ] AC-06: Session error (scoped and unscoped), deletion, message removal, assistant error, Off, and disposal cannot resurrect pending text through late fetches, late acknowledgements, Resume, or On.
- [ ] AC-07: Two sessions and two plugin instances remain isolated. Session-targeted cleanup cannot transfer ownership; a pending response never becomes another session's cached audio or Repeat target.
- [ ] AC-08: Repeated Pause/Resume, disabled/incapable instances, Resume without pending work, and contained synthesis/player failures remain safe and bounded. Retention does not create retries or hang the event hook.
- [ ] AC-09: Exact cached Repeat, playback-speed controls, cache hold cleanup, and silent Pause remain intact; all prescribed checks have candidate-bound results before implementation is declared verified.

## Stable tasks and route

### PLR-I01 ÔÇö Implement latest-response retention and atomic Resume arbitration

- [ ] Read current source/tests and identify freshness, invalidation, default-state wiring, wrapper wiring, and frozen-handle boundaries before any source write.
- [ ] **RED:** Add focused fake-driven tests for AC-01 through AC-08; record the expected missing-behavior failures separately from dirty-baseline failures.
- [ ] **GREEN:** Add bounded retained selection ownership and lifecycle clearing; coordinate Resume to choose retained narration or valid frozen continuation, never both. Preserve existing failure/cache contracts.
- [ ] **REFACTOR:** Simplify only this unit's ownership/guard logic with focused tests kept green; do not refactor P4, PN, unrelated protocol, or UI code.
- **Route:** delegated, one coherent implementation unit including its tests and this tracker. Trigger: multi-file source plus tests and required preparation reading before writing. This records the route; no child agent is launched by preparation.
- **Policy:** default ODD test-first **RED -> GREEN -> REFACTOR**, runner `bun test`. Strict TDD is not explicitly configured and must not be inferred.
- **Boundary:** start from the exact pre-implementation dirty baseline, recorded by the owner; end candidate and actual incremental diff pending. Existing P4/PN changes are not part of this unit.

### PLR-V01 ÔÇö Verify the unit and record delivery evidence

- [ ] Capture the current dirty baseline with focused/full checks before implementation, then repeat the commands after PLR-I01; report exact results and classify preexisting failures.
- [ ] Demonstrate all acceptance criteria with injected fake SDK/engine/player handles, deferred promises, and session/instance negative controls; no real audio or process-host smoke is authorized here.
- [ ] Read back the incremental source/test/doc diff, measure authored additions plus deletions excluding the existing diff, and confirm unrelated dirty files remain unchanged.
- [ ] Update this tracker with evidence and unresolved risks; retain the work-unit commit as pending until the owner can isolate overlapping P4 changes and explicitly authorizes committing.
- **Route:** delegated verification of PLR-I01, not a separate source implementation unit. Parent readback and spot-check remain required.

## Forecast and delivery strategy

Forecast **300-460 incremental authored lines (additions + deletions)**: source approximately 80-130, tests 120-190, and this document approximately 100-140. This is an estimate, not a measured candidate diff; exclude all existing P4/PN changes and do not count an unchanged baseline as authored work.

`delivery_strategy: ask-on-risk`. The advisory review budget is about 400 authored changed lines. Ask the owner if the measured unit exceeds the budget or freshness/session integration requires scope expansion; keep cohesive tests and documentation rather than compressing them to meet a number. No chain strategy, branch, PR, or budget exception is newly authorized.

**Work-unit commit: PENDING / NOT AUTHORIZED.** `src/plugin.ts` and `test/wiring.test.ts` already contain overlapping P4 dirty changes; accidental inclusion is a delivery blocker. Preserve those changes and PN tracking rather than staging whole files or committing the accumulated worktree. Record any future exact isolated candidate only after owner authorization; no commit identity is claimed here.

Clone-local RDD is **off**, as supplied and recorded in the existing playback tracker. Do not invoke RDD lifecycle, mode changes, assessment, lineage, or review commands. No receipt or approval is claimed.

## Verification ledger and baseline considerations

**All checks below are NOT RUN for this feature.** Historical P4 results (408 pass, 4 skip) in the playback tracker are context only, not a current baseline or feature evidence. Preparation inspected source/tests without executing behavior. Real installed playback and audible correctness remain unverified.

```sh
bun test ./test/plugin.test.ts ./test/wiring.test.ts ./test/speech-sink.test.ts ./test/repeat-control.test.ts ./test/repeat-ui.test.ts ./test/audio-cache.test.ts
bun test
bun run typecheck
git diff --check
```

Run future automated tests with fake processes and no opt-in real-host smoke. A full-suite runner does not authorize live installation, reload, audio, or children; inspect its runtime boundaries before execution under that restriction. Record failures with exact command/case and whether they reproduce on the preserved dirty baseline. `git diff --check` covers the whole current worktree, so distinguish old warnings from this unit's own whitespace issues.

Preparation observed these preexisting modified paths: `README.md`, `odd/tasks/playback-controls.md`, `odd/tasks/pronunciation-normalization.md`, `src/plugin.ts`, `src/repeat-control.ts`, `src/repeat-ui.ts`, `test/player.test.ts`, `test/repeat-control.test.ts`, `test/repeat-ui.test.ts`, `test/wiring.test.ts`, and `tui/open-vox.tsx`. They must remain unchanged by this pass. Git reported LF-to-CRLF conversion warnings during read-only diff inspection; this is not a whitespace-check result.

## Rollback and next action

- **Preparation rollback:** remove only the newly authored `odd/tasks/pause-latest-response.md`; leave every preexisting file and dirty hunk intact.
- **Future unit rollback:** undo only this unit's incremental retention/arbitration changes and paired tests/tracker updates in the exact proposed set. Restore the prior drop-while-paused behavior while preserving existing frozen Resume, P4 speed controls, PN work, and cache ownership. Never reset whole overlapping files or the worktree.
- **Next action:** parent reads this document and reconciles the proposed boundary with existing dirty work before separately authorizing PLR-I01. Preparation does not authorize implementation or a commit.
- **Mirror:** attempt the full document under project `agentvoz`, topic `odd/pause-latest-response/tasks`, with `capture_prompt: false`. If project recovery fails, retain this full local artifact and report mirror pending; never select unrelated projects or block on an unrelated question.
