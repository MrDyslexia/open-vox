# Repeat availability during status renewal

## Objective and problem
Keep Repeat enabled while a healthy background status renewal is pending and the last validated, session-bound audio status remains unexpired. Current renewal clears valid status, restarts settlement and shares a sending gate with Repeat actions, causing periodic unavailability.

## Scope and constraints
- Authorized source: `src/repeat-ui.ts`.
- Authorized tests: `test/repeat-ui.test.ts`.
- Tracking: this document and Engram topic `odd/repeat-renewal/tasks`.
- Preserve pause, expiry, session isolation, transport correlation, conflicting-instance detection and duplicate-action safety.
- Preserve all pre-existing playback-control changes and untracked files on `feat/playback-controls`.
- No installation, narration, remote operations or commits authorized for this correction.

## Tasks
- [x] RR-01 implementation: Add deterministic renewal regressions, observe RED, implement stable validated availability, and verify GREEN with safety regression coverage. Native review and live UI proof remain pending; task closure belongs to the parent.

## Route and checks
RR-01 uses delegated direct implementation: preparation for writing and non-trivial source/test changes require one bounded writer.
Test-first applies using `bun test test/repeat-ui.test.ts test/repeat-control.test.ts`; observe the healthy-renewal regression failing before source edits.
After normalization, run focused tests, `bun test`, `bun run typecheck`, and `git diff --check`. A full-suite failure caused by concurrent playback work must be reported, not fixed in this scope.
Independent checks and native review follow the actual candidate and existing repository changes; do not claim review of an isolated Repeat candidate when unrelated changes are included.
Live UI behavior remains unverified without an authorized restart/runtime probe.

## Delivery and rollback
Forecast: approximately 100–200 authored changed lines, one coherent behavior/test unit. Strategy: ask-on-risk if scope expands; no PR or commit requested.
Rollback boundary: only this task's changes to `src/repeat-ui.ts`, `test/repeat-ui.test.ts`, and this tracking document. Never reset the worktree.

## Progress and next step
Implementation and bounded correction completed with deterministic functional proof. Parent repeated the final focused tests (17 passed, 0 failed, 103 assertions), passed diff checking and inspected the expiry correction. Native review could not start because the untracked-selection request was rejected; no approval or receipt exists. Next: resolve native selection and verify live UI after a separately authorized reload. Task closure remains pending; the recovery mirror reflects this state.

## Implementation and evidence
- Root class: new bug in renewal lifecycle coupling. Discovery previously discarded an accepted lease and shared Repeat's publication gate.
- Accepted status now retains its original expiry while a correlated renewal candidate settles. Discovery and Repeat publication have independent bounded in-flight gates; duplicate Repeat actions remain blocked.
- Candidates require matching challenge, session and expiry, successful hello publication and the existing 250 ms settlement. Conflicting instances, explicit paused/zero-revision replies and transport rejection invalidate accepted availability. Route/session invalidation runs even during unresolved publication.
- Inspected the real consumer in `tui/open-vox.tsx`: the 250 ms poll calls `refresh(session())` and `available(session(), paused())`; `onChange` also recomputes availability, and the click guard checks it again. No renderer or consumer edits.
- CodeGraph was attempted with the exact project path and reported no index; used local source reads without initializing an index.

### Observed checks
- RED, before production edits: `bun test test/repeat-ui.test.ts test/repeat-control.test.ts` — 10 passed, 5 failed, 56 assertions. The healthy-renewal test expected availability immediately after an unresolved renewal hello and received false. The session/route regression also exposed invalidation being skipped during publication.
- Initial implementation run: the same focused command — 14 passed, 1 failed. The second-cycle test still left its fake hello unresolved past the old lease expiry; corrected the fake transport to resolve that healthy cycle, without relaxing production expiry checks.
- GREEN before and after the small guard refactor: `bun test test/repeat-ui.test.ts test/repeat-control.test.ts` — 15 passed, 0 failed, 87 assertions.
- `bun test` — 252 passed, 1 skipped, 0 failed; 592 assertions across 15 files.
- `bun run typecheck` — passed (`tsc --noEmit`).
- `git diff --check` — passed; Git emitted existing LF-to-CRLF working-copy warnings, not whitespace errors.
- Regression coverage includes unresolved healthy hello, repeated healthy renewal, original lease expiry without replies, stalled transport, malformed/stale/wrong-session/wrong-expiry replies, conflicts before/after settlement, local/backend pause, zero revision, session/route changes, disposal, transport rejection and duplicate Repeat publication.

### Scope, size and remaining proof
- Changed only `src/repeat-ui.ts`, `test/repeat-ui.test.ts`, and this task document. Concurrent playback files were not edited, staged or reset.
- Source/test diff: 140 additions and 15 deletions (155 changed lines). Task-document edits relative to its writer-entry content: 24 additions and 2 deletions (26 changed lines). Total authored size: 181 changed lines, within the 100–200 forecast.
- No formatter, installation, deployment, reload, network operation, real audio, live plugin probe or commit performed.
- Native review is pending. Live renderer behavior and currently loaded helper bytes remain unverified. Parent owns final review, closure and the existing Engram task mirror.

## Bounded correction after independent verification
- Parent independent verification found one source-traced regression: an accepted instance A expired at 3000 but still conflicted with sole replacement B during discovery started at 3250.
- Corrected only the accepted-status comparison: it participates in responder conflict detection only while unexpired. Same-challenge responder comparison remains unconditional; no new state or relaxed correlation/settlement guards.
- Added deterministic first-cycle replacement coverage at exact expiry (3000) and after expiry (3250), plus live-A/sole-B and expired-A/B-plus-C same-challenge conflict checks.
- RED before this source correction: `bun test test/repeat-ui.test.ts test/repeat-control.test.ts` — 16 passed, 1 failed, 96 assertions; replacement remained unavailable after settlement (expected true, received false).
- GREEN: `bun test test/repeat-ui.test.ts test/repeat-control.test.ts` — 17 passed, 0 failed, 103 assertions.
- `bun test` — 254 passed, 1 skipped, 0 failed; 608 assertions across 15 files.
- `bun run typecheck` and `git diff --check` — passed; Git reported LF-to-CRLF warnings only.
- Review status supplied by parent: native preflight `invalid_request` for selection JSON, `mutation_outcome: not_started`; no native review approval. Correction implemented and tested, not reviewed or closed.
- Preserved concurrent playback commit HEAD `03a13e8`; edited only the three authorized surfaces. Correction size: source +2/-1, tests +26/-0, tracking +12/-0 = 41 changed lines. Cumulative combined Repeat diff: source/tests 182 changed lines plus tracking 38 = 220 changed lines, above the original forecast but below the advisory 400-line budget.
- Live UI/loaded-byte proof remains pending. No child delegates, staging, commits, installation, deployment, runtime probe or network operation; parent owns final review and mirror.
