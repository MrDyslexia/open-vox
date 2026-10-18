# Speak latest response

## Objective

Make the existing sidebar action show Speak when the latest eligible assistant response has no audio, and Repeat only when its own audio is available. Speak generates and plays that response; Repeat reuses its generated audio.

## Problem and scope

Originally cached audio lacked message identity; S1 added response ownership. Reuse the existing transport, synthesis and playback paths. Preserve observed-turn freshness for autoplay, cleanup, session isolation and stale-request rejection. The user subsequently approved manual recovery of the displayed session's latest eligible persisted response after restart or re-enabling. Recovery must never autoplay historical text; only an explicit Speak click may generate/play it. Keep service/Pause/busy gates. No remote operations or commits are authorized in this session.

## Authorized surfaces

- src/plugin.ts
- src/final-response.ts
- src/repeat-control.ts
- src/repeat-ui.ts
- src/speech-sink.ts
- src/audio-cache.ts
- tui/open-vox.tsx
- test/plugin.test.ts
- test/final-response.test.ts
- test/wiring.test.ts
- test/repeat-control.test.ts
- test/repeat-ui.test.ts
- test/speech-sink.test.ts
- test/audio-cache.test.ts
- README.md
- odd/tasks/speak-latest-response.md

## Tasks

- [x] S1: Implement latest-response-bound Speak/Repeat, regression coverage and user-facing documentation.
  - Route: delegated direct; the parent used one bounded general writer for preparation and multi-file implementation.
  - Acceptance: no matching audio means Speak; matching audio means Repeat without resynthesis; older response audio must not enable Repeat for newer text.
  - Preserve duplicate-action guards, service/pause gates and lifecycle invalidation. Failed generation must leave Speak retryable without false audio association.
- [x] S2: Verify focused and full tests, typecheck, diff integrity and independent checking when required by native risk assessment.
  - Independent read-only verification passed: 306 focused tests, typecheck and diff integrity. Parent repeated the Speak targets B regression: 1 pass, 0 fail. Native assessment was unassessable due to undeclared untracked files, so high-tier independent checking was used; no RDD lifecycle was started.
- [x] S3: Recover latest persisted response for explicit Speak after restart or re-enabling, without historical autoplay.
  - Route: delegated direct; multi-file implementation and write preparation.
  - Acceptance: a valid latest persisted response can enable Speak without a fresh completion event; discovery performs no synthesis/playback; explicit click targets that response safely; stale, deleted, errored, child/summary, newer-turn and session-switch races cannot speak obsolete text.
  - Bound and deduplicate history reads; never turn 250-ms UI polling into unbounded enumeration. Preserve ordinary fresh-response autoplay, Pause semantics and current audio ownership.
- [x] S4: Independently verify manual recovery, rerun focused/full checks and confirm whether installed TUI needs updating.
  - Independent read-only verification: 282 pass, 0 fail; typecheck and diff check passed. Parent recovery regression spot check: 31 pass, 0 fail. No confirmed blocking defect; installed TUI compatible without another patch. Mounted UI and audible playback remain unverified.

## Verification

Default test-first policy applies using Bun: observe relevant failing regression tests before implementation, then green tests. No strict-TDD configuration has been established. Run:

```text
bun test ./test/plugin.test.ts ./test/wiring.test.ts ./test/repeat-control.test.ts ./test/repeat-ui.test.ts ./test/final-response.test.ts
bun run test
bun run typecheck
git diff --check
```

TUI TSX is excluded from typecheck; cover syntax and wiring through existing tests and disclose that mounted UI/audio is not proven by them.

## Delivery and progress

- Delivery strategy: ask-on-risk. Observed tracked source/test/README changes: 278 insertions + 53 deletions = 331 changed lines across 13 files. Including this 87-line untracked task document gives approximately 418 candidate lines across 14 files. The per-task 400-line guidance is advisory, not a code-size target.
- RDD: off, clone-local; do not enable or launch review.
- Baseline branch: backup/open-vox-state-20261015. Pre-existing scripts/__pycache__/ and test/python/__pycache__/ remain untracked and untouched; this task document was parent-created and untracked before implementation.
- S1 implemented and locally checked. No staging, commits, branch changes, publishing, installation, real audio, or remote calls were performed. No commit identity exists for this work unit.
- S3 implemented through one bounded writer; S4 independently verified. Next: user restarts the OpenCode plugin host and qualifies restored-session Speak manually. No live audio, activation or publishing performed by the assistant.
- Recovery mirror: odd/speak-latest-response/tasks in Engram project pc.

## Implementation evidence

- The coordinator retains one validated latest manual target independently of consumable Pause pending text. Existing completion ordering, observed-turn guards, ordinary autoplay and no-history admission remain intact.
- Synthesis jobs and cached status carry message identity. Discovery exposes only the latest target's matching audio revision, never an older response's revision. Host actions revalidate session/message, nonce, TTL, service/pause state and shared bounded request deduplication.
- Speak reuses existing preparation, PN, engine and playback paths. An instance-local in-progress selection guard covers autoplay and manual preparation/generation; a failed attempt releases that guard for manual retry. Matching audio uses Repeat without synthesis, including restart during playback.
- Scoped cancellation/deletion and Pause invalidate asynchronous preparation before it can queue obsolete work. Off, new turns, errors, removal and disposal invalidate manual targets without resurrecting consumed Pause text.
- UI renewal propagates target identity and busy state; sameView includes Speak availability. The existing action slot shows Speak or Repeat. README documents ownership, gates and retry behavior.
- Existing direct-to-sink PN fixtures have no observed host response. Their exact-WAV replay tests now use the gated sink directly; separate host regression coverage verifies response-bound authorization and rejects cache-only host requests.

## Observed test-first and final checks

| Phase | Exact command | Observed result |
| --- | --- | --- |
| RED host regression | `bun test ./test/wiring.test.ts --test-name-pattern "Speak targets B"` | 0 pass, 1 fail, 145 filtered; old status advertised A's revision 1 instead of B with revision 0. |
| RED UI regression | `bun test ./test/repeat-ui.test.ts --test-name-pattern "response-bound renewal"` | 0 pass, 1 fail, 38 filtered; Speak availability was absent. |
| Final focused GREEN | `bun test ./test/plugin.test.ts ./test/wiring.test.ts ./test/speech-sink.test.ts ./test/repeat-control.test.ts ./test/repeat-ui.test.ts ./test/audio-cache.test.ts` | 306 pass, 0 fail; 1,170 assertions; 6 files; 3.78 seconds. |
| Final full GREEN | `bun run test` | 643 pass, 5 skip, 0 fail; 2,521 assertions; 24 files; 14.29 seconds. |
| Final types | `bun run typecheck` | `tsc --noEmit`, exit 0. |
| Final whitespace | `git diff --check` | Exit 0, no whitespace errors; Git emitted LF-to-CRLF working-copy warnings. |

Intermediate focused/typecheck runs exposed an incomplete coordinator edit and old cache-only host fixture assumptions; those were corrected before the final green commands. No required check remains failing. Source/test/README line endings were normalized to tracked LF before final checks, without a formatter or installation.

## S3 manual recovery evidence

- Changed only `src/plugin.ts`, `src/final-response.ts`, `src/repeat-control.ts`, `test/wiring.test.ts`, `test/final-response.test.ts`, `test/repeat-control.test.ts`, `README.md` and this task document. Prior S1/S2 changes and untracked Python cache directories remain intact. No staging, commits, branch changes, installation, remote execution, native review or live audio occurred.
- Manual discovery is separate from autoplay admission and consumable Pause pending text. Startup, idle and unobserved completion events do not enumerate history or invoke the sink. A sidebar status query can discover persisted text, but only an explicit action generates/plays it. Existing historical-autoplay tests were not weakened.
- Installed SDK declarations (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:2209-2243`) confirm `session.messages({ path: { id }, query: { directory, limit } })` returns message/part pairs. Context7 was consulted first for API documentation; local declarations resolve its different SDK signature. Recovery requests at most 100 messages and validates the root session, unique identities, latest user turn, latest assistant ordering, parent relationship, finality and permitted prose. Ambiguous, truncated, child, summary, error, compaction and reverted contexts fail closed; incomplete newer turns cannot fall back to older answers.
- One displayed-session slot coalesces in-flight reads, caches successful/negative/failed discovery for five seconds and aborts reads after 1.5 seconds. Streaming metadata invalidation preserves the cooldown. Explicit actions revalidate persisted eligibility and request expiry. Service/discovery/turn epochs reject delayed results after Off/On, Pause/Resume, new turns, errors, removal, deletion, compaction, disposal or session switching. Bounded invalidation tombstones prevent stale error/deletion snapshots from being rediscovered.
- Generation ownership is keyed by session/message identity, not a reconstructed selection object. Action selection is serialized through manual generation, failures remain retryable, and Repeat releases selection ownership before playback so another Repeat can restart the same WAV. Cached A audio cannot authorize Repeat for latest B. Discovery never populates Pause pending text.
- Final accumulated tracked candidate: 683 insertions + 64 deletions = 747 changed lines across 15 files, plus this untracked task document. This includes prior S1/S2 work and exceeds the advisory 400-line budget; no code compression or commit splitting was performed because commits are prohibited.

| S3 phase | Exact command | Observed result |
| --- | --- | --- |
| RED recovery regressions | `bun test ./test/wiring.test.ts --test-name-pattern 'persisted manual recovery'` | 8 pass, 10 fail, 147 filtered; restart/On status lacked the persisted message ID. An earlier invocation hit the 20-second harness timeout because race tests awaited an unavailable recovery hook; preconditions were added before recording this meaningful RED. |
| Final focused GREEN | `bun test ./test/plugin.test.ts ./test/wiring.test.ts ./test/repeat-control.test.ts ./test/repeat-ui.test.ts ./test/final-response.test.ts` | 282 pass, 0 fail; 1,141 assertions; 5 files; 2.23 seconds. |
| Final full GREEN | `bun run test` | 682 pass, 5 skip, 0 fail; 2,691 assertions; 24 files; 15.25 seconds. |
| Final types | `bun run typecheck` | `tsc --noEmit`, exit 0. |
| Final whitespace | `git diff --check` | Exit 0; only Git LF-to-CRLF working-copy warnings. |
| Line endings | `git ls-files --eol -- README.md src/plugin.ts src/repeat-control.ts src/final-response.ts test/wiring.test.ts test/repeat-control.test.ts test/final-response.test.ts` | Every edited tracked file reports index LF / working-tree LF. |

Intermediate S3 checks found a TypeScript narrowing error and a test-clock setup error (the control had captured Date.now before the spy). Both were corrected before the final green commands. Thirty-nine additional regressions cover recovery, bounds, coalescing, timeout/late results, manual retries, ownership, expiry, lifecycle races and unchanged autoplay admission. No required final check remains failing.

### S3 activation and remaining verification

- Read-only inspection confirms the installed TUI imports repository helpers directly and already has the dynamic Speak/Repeat action at lines 113-117. S3 needs no template or installed-file patch. The installed initializer omits optional `canSpeak`, but helper renewal supplies it and `sameView` compares it. No installed file was modified and no activation was performed; restart/reload the OpenCode plugin host after independent verification to load the updated backend.
- TUI TSX remains excluded from TypeScript checking. Full-suite transpilation/wiring checks passed, but mounted UI behavior and audible output remain unverified. The five skipped tests remain disclosed. History whose latest user turn lies outside the 100-message window is intentionally unavailable; failed discovery retries after the cooldown or a valid explicit action, and invalidated error/removal contexts wait for a new user turn.
- S4 completed: independent source/SDK/installed-file inspection found no confirmed blocking defect; 282 focused tests, typecheck and diff check passed. Parent separately reran all 31 persisted-recovery regressions successfully. Writer full-suite result remains 682 pass, 5 skipped, 0 fail; mounted/audio integration is not proven. No native/RDD review lifecycle was invoked. skill_resolution: requested exact skill paths were loaded; CodeGraph was unavailable and no index was created.

## Limitations and handoff

- TUI TSX is excluded from typecheck. Existing Bun transpilation and source/registration wiring tests passed; mounted UI behavior and audible output are not proven.
- Verification used deterministic fake processes, isolated WAV fixtures and attached fake transport. No runtime audio/listening qualification or remote execution occurred. The full suite reports five skipped tests.
- S2 completed with independent read-only inspection and focused checks plus the parent regression spot check. No blocking defect was found. One composed host-to-real-sink regression would strengthen coverage; current host, sink and cache boundaries are tested separately.
- skill_resolution: loaded work-unit-commits and cognitive-doc-design from the exact requested paths. Kept behavior, tests and docs together; explicit no-commit/no-delegation instructions override commit and delegation defaults. CodeGraph was attempted but unavailable because this checkout has no index; direct source reads were used without indexing.
- Rollback boundary: the six authorized src files, tui/open-vox.tsx, the seven authorized test files, README.md and this task document; preserve the pre-existing untracked Python cache directories. No unrelated surface was edited.
