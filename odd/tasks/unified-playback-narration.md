# PN-first playback unification

Preserve the delivered pronunciation-normalization (PN) pipeline while adding
instance-scoped service On/Off and playback rates in small, coherent work units.
Bootstrap and U01–U06 are complete; confirmed service UI is bound. Next: **U07**.

## Objective and authorization

The original P3b/P4 playback work predates the delivered PN source-plan pipeline.
Copying the old plugin wholesale would lose scoped cancellation and PN behavior.
Port only the missing behavior onto the exact PN delivery baseline instead.

- Bootstrap was document-only; subsequent authorization permits U01 source work.
- U01 edits: `src/audio-cache.ts`, `test/audio-cache.test.ts`, compatible cache
  mocks in `test/speech-sink.test.ts` and `test/wiring.test.ts`, and this tracker.
  `odd/tasks/playback-controls.md` was allowed but unchanged in U01.
- U02 completed protocol and explicit pause/resume dispatch without runtime binding.
- U03 completed PN sink gates and promise preparation without runtime binding.
- U04 completed state/lifecycle/wrapper helpers without actual-instance binding.
- U05 completed actual PN instance service binding and cache lifecycle checks.
- Current authorization: U06 repeat UI/TSX, focused tests, README and task evidence
  only. Voice/theme semantics stay intact; no playback-rate work. Stop before U07.
- No network, publication, PR edits, push, main merge, rebase, destructive reset,
  original checkout changes, host/config/environment changes, downloads, installs,
  package/lock writes, or writes through the dependency junction are authorized.
- Preserve the published frozen PN draft chain, PRs 1–16, its refs and documents.
- RDD remains clone-local off; do not toggle it or initiate RDD review.
- This is ODD, not SDD. No project registry or SDD artifacts are introduced.
- One bounded writer performs bootstrap; no child delegates are launched.

## Baseline and portable provenance

| Role | Git locator | Commit |
|---|---|---|
| Integration baseline | `delivery/pn-15-license-notices` | `4c080cb35feabd3966e705a669f82ee413381a97` |
| Original PN | `feat/pn-implementation` | `20040db077177b2a3ea7396a1652a68e441788fb` |
| Original dirty P4 parent / P3b record | `feat/playback-controls-p4-speed` | `d40f0da678306e2b34a56af9e2e4021985692c42` |
| P3b behavior donor | commit | `7ab8374` |
| Earlier documentation provenance | commit | `5847572` |
| Unchanged main | `main` | `5fe4faf5fb89d29d29152df785e49641eb12fbcb` |
| New integration branch | `feat/unified-playback-narration` | starts at exact baseline above |

The remaining integration scope is P3b On/Off and the dirty P4 rate delta.
Donor branches, old PN task documents, and backup commits are not integration
ancestors. Do not transplant the original plugin or rewrite frozen PN records.

## Durable backups and recovery

All names below share prefix
`refs/backup/open-vox-unification-20261013-43bdd15fd55c-`.
Each fresh ref was created with an expected absent value, without overwriting refs.

| Ref suffix | Protected commit | Tree |
|---|---|---|
| `pn-original` | `20040db077177b2a3ea7396a1652a68e441788fb` | `2b82c6f3a3e9091595336ffc0743f6cdf9e01238` |
| `pn-delivery` | `4c080cb35feabd3966e705a669f82ee413381a97` | `b40763ca0842a2545bcd355d53a037b34906b26b` |
| `p3b-provenance` | `d40f0da678306e2b34a56af9e2e4021985692c42` | `a1b8f00a572243ff16df0122b8dac3b5a953c2dc` |
| `p4-filtered` | `483bbcc3cc1c08c893eb91ef87083613cb300041` | `0a7b5ce8e34d5652fbf61828439127e701bd0471` |
| `p4-raw-bytes` | `6b0263e82748a477399114536564dd5a56f26fa2` | `0a7b5ce8e34d5652fbf61828439127e701bd0471` |

Both P4 snapshots include all eleven modified tracked paths. Fresh isolated
indexes were seeded from `d40f0da`; neither the original index nor checkout was
changed. The filtered snapshot uses normal Git staging. The second uses
`hash-object --no-filters -w` and original file modes through `update-index`.
Raw blob contents and SHA-256 hashes matched working bytes before and after,
including line endings. The two trees happened to be identical; the raw-byte
check, rather than an assumption about filters or CRLF, establishes recovery.

Read-only inspection: `git diff <parent> <backup-ref> -- <relative-path>`.
Exact bytes: `git show <raw-backup-ref>:<relative-path>` or identify the blob
with `git rev-parse <raw-backup-ref>:<relative-path>` and read `git cat-file blob
<blob-id>`. For recovery into a separately approved destination, capture binary
stdout using a byte-preserving API; avoid text pipelines and shell encoding
conversion. No restore was executed. Never reset or checkout the originals.
These private backup commits protect objects from GC but are not review units.

## Delivery policy

`delivery_strategy: auto-chain`; `chain_strategy: feature-branch-chain`.
The user selected **at most 400 authored additions + deletions per unit** with
**no size exceptions**. This is not a heuristic override. Future publication
requires separate authorization; the chosen chain does not authorize PR creation.

Each unit includes its tests and relevant documentation. Estimates below include
15–25 lines of documentation/test overhead; they are forecasts, not evidence.
Record observed A+D against the immediately preceding unit before closing it.
An over-budget unit remains open and blocked; never prune tests, remove useful
documentation, compress code, or claim an exception to meet the ceiling.

## Stable implementation checklist

| Task | Coherent outcome | Estimated authored A+D | Dependencies |
|---|---|---|---|
| [x] U01 | Cache clear/invalidation and compatible mocks | 170–195 forecast; observed below | baseline |
| [x] U02 | Service wire and safe dispatch | 145–175 forecast; observed below | U01 |
| [x] U03 | PN sink enabled checks at admission, post-plan, pump, status, Repeat | 195–240 forecast; observed below | U01–U02 |
| [x] U04 | Enabled state / Off lifecycle wrapper; forward `stopSession` | 165–205 forecast; observed below | U03 |
| [x] U05 | Wire On/Off to actual PN instance; clear cache, cancel, combine counters | 300–375 forecast; observed below | U01–U04 |
| [x] U06 | Service UI confirmed state and TSX | 255–290 forecast; observed below | U05 |
| [ ] U07 | Closed rate wire: 1 / 1.5 / 2 and safe dispatch | 165–190 | U06 |
| [ ] U08 | Existing-player rate regression tests only | 240–255 | U07 |
| [ ] U09 | Runtime rates preserve cached PN audio | 365–395 | U07–U08 |
| [ ] U10 | Confirmed rate UI | 280–310 | U09 |

U09 is the hardest ceiling: preserve all necessary regression tests. Bootstrap
contained no source materialization; U01–U06 are complete. U07–U10 remain open.

## Future routes and verification

These are future delegated work routes, not permission to spawn children now.
No repository-specific testing registry exists; do not invent one.

| Trigger | Route and preparation | Multi-file boundary |
|---|---|---|
| Start any U01–U10 implementation | `work-unit-commits`: inspect actual baseline, define behavior and focused tests first | One coherent behavior with tests and task evidence |
| Plan/close any delivery slice | `chained-pr`: retain auto-chain / feature-branch-chain, measure observed A+D | Immediate preceding boundary only; no frozen PN edits |
| Edit task evidence / user-facing guidance | `cognitive-doc-design`: lead with outcome, expose evidence and next step | Keep documentation alongside the relevant behavior |
| PN lifecycle, runtime, UI cross-boundary work | Prepare instance ownership, cancellation and confirmation contract before writing | Sink, wrappers, wire/UI and focused tests scoped to the current unit |

Applicable future units use deterministic **RED → GREEN → refactor**: run the
focused failing test, implement the minimum behavior, rerun it and refactor while
green. Do not infer test-first policy merely from framework presence. U08 is an
existing-player regression-only boundary: record what it proves and do not
manufacture a product defect to force RED. Use repository runners `bun test`
for focused tests and `bun run typecheck`; inspect exact existing test paths
before selecting commands. Record commands, exact outcomes and observed counts.

Bootstrap uses structural checks, not artificial RED. Runtime harness: N/A for
this passive document and Git safeguard boundary. Future runtime units must
record actual harness scenario/outcome or an explicit boundary-specific N/A.

## PN and rollback invariants

- Keep the PN source plan bounded at 4000 UTF-16 units and the offline ONNX
  nine-label backend, manifest/source invariants and 510-phoneme limit.
- Preserve protected tokens and colon, hyphen and slash corrections; keep voice
  fixed per synthesis and synthesis speed separate from player playback rate.
- Preserve scoped `stopSession` forwarding through wrappers, generation ownership
  and cache promotion checks, Pause position, and exact cached Repeat with zero
  parser, resolver or synthesis calls.
- On/Off owns the actual PN instance. Off cancels only that instance and clears
  retained audio; enabling again does not resume discarded audio. Never cancel
  another instance's work.
- A stored rate preference, missing host acknowledgment or fallback is not proof
  of audible rate success. Keep those limitations explicit in UI and evidence.
- Roll back a future unit only at its recorded dependency boundary after review;
  preserve baseline PN behavior and never restore donors over the PN plugin.
- Bootstrap rollback boundary is this new task document only. Keep backup refs
  and original worktrees intact; no destructive rollback is authorized here.

## Bootstrap evidence and pending proof

- Verified original dirty P4 has exactly eleven unstaged tracked paths and no
  staged/untracked paths; binary diff fingerprint remains
  `192d7d31cb262051d889c4cd1841622254d5307c`.
- Checkpointed all original tracked-file SHA-256 hashes, index hashes, refs,
  statuses, worktrees and code baseline before backup; unchanged after creation.
- Created a fresh worktree/branch from exact PN baseline, not stale PN or P4.
- Reused existing delivery dependencies with a new ignored `node_modules`
  directory junction. `package.json` and `bun.lock` are byte-identical; no install
  or writes through the junction are permitted.
- From the new checkout, `bun run typecheck` passed (`tsc --noEmit`, exit 0).
  No full tests, host activation, backend provisioning or runtime proof ran.
- At bootstrap, integration and PN regression proof remained pending U01–U10.
- Bootstrap commit identity belongs in the memory receipt; this document cannot
  embed its own final hash. A future U01 update may record that observed SHA.

## Next step

Stop after U06. Next is U07 closed playback-rate wire and safe dispatch.
Reconcile this tracker with full Engram mirror `odd/unified-playback-narration/tasks`
in project `agentvoz`; preserve the 400-line closing guard for every later unit.

## U01 evidence

- Prior boundary: bootstrap `a7288890fa48bcd8c559a26c3d9a27b84dca6dc4`.
- `AudioStore.clear()` removes retained eligibility, retires owned candidates,
  rejects late promotion, preserves monotonic revisions and defers held deletion
  until the final release. Vanished files no longer consume candidate slots.
- Deterministic cache harness checks multiple/idempotent releases, stale candidates,
  Repeat without synthesis/playback, fresh promotion, foreign ownership, non-file
  safety and existing forget/dispose behavior. PN product files are unchanged.
- RED: `bun test test/audio-cache.test.ts test/speech-sink.test.ts test/wiring.test.ts`
  produced 133 pass / 5 fail (missing `clear`), 334 assertions, exit 1.
- GREEN: same command produced 138 pass / 0 fail, 374 assertions, exit 0.
- `bun run typecheck` passed after correcting a test-only nullable assertion;
  `git diff --check` passed. No full suite ran; real audio/host proof is N/A for
  this cache boundary. No product refactor was needed.
- Rollback boundary: U01 cache contract/implementation, its tests/mocks and this
  task evidence only; preserve baseline PN, bootstrap and durable backup refs.
- Observed authored A+D: production 14, tests/mocks 119, documentation 43; total
  176 <= 400. The U01 memory receipt records the actual behavior commit identity.

## U02 evidence

- Prior boundary / U01 commit: `12a9841a839105ac907640629806c205593d3001`.
- Added closed `enable`/`disable` actions and boolean confirmed `enabled` status;
  absent flags/readers default to true. Disabled Repeat is consumed, not deferred.
- Kept nonce correlation, instance/TTL checks, shared bounded request history and
  failure containment. The plugin dispatches only explicit pause/resume; unbound
  service actions neither resume paused audio nor falsely report runtime Off.
- RED: `bun test test/repeat-control.test.ts test/wiring.test.ts` produced
  88 pass / 7 fail, 218 assertions, exit 1 (missing protocol/state/gate behavior).
- GREEN: same command produced 95 pass / 0 fail, 249 assertions, exit 0.
- `bun run typecheck` passed after a test-only literal-union correction;
  `git diff --check` passed. No full suite or real audio; runtime proof is the
  deterministic wire/plugin harness, not host or service lifecycle qualification.
- Rollback boundary: U02 protocol, plugin dispatch callback, its focused tests and
  task evidence only. PN source-plan/stopSession/generation paths remain unchanged.
- Observed A+D: production 19, tests 95, docs 31; total 145 <= 400. Commit SHA is in the U02 receipt.

## U03 evidence

- Prior boundary / U02 commit: `f4a2d6c278c62b2c606a6d9dce847dfc6e47507c`.
- Optional `isEnabled` defaults true and combines with static `enabled`. Off gates
  admission before parsing, PN post-preparation, pump validity, pause/resume,
  status and Repeat. Observed Off stops work and invalidates its generation.
- PN preparation now accepts a plan or promise without delaying the synchronous
  path. Existing plan, language, policy, session stop and promotion checks remain.
- Active processes observe the predicate every 20 ms, including frozen playback;
  the observation timer ends with the process. Re-enabling never revives cancelled
  work. A false pulse entirely between observations is not observable; later Off
  lifecycle wiring supplies explicit cancellation. Cache clearing remains U05.
- RED: `bun test test/speech-sink.test.ts` yielded 48 pass / 6 fail, 143 assertions,
  exit 1 (missing gate/promise support; queued-work regression timed out at 5 s).
- Initial GREEN: 54 pass / 0 fail, 161 assertions. Final expanded race/error
  coverage: 56 pass / 0 fail, 169 assertions, exit 0 with the same command.
- `bun run typecheck` and `git diff --check` passed. Deterministic harness proves
  async preparation races, late successful cancellation, queue invalidation,
  frozen hold release, protected cache retention and new-work-only execution.
  Real audio/host proof is N/A; no full suite, service binding or plugin edits.
- Rollback boundary: U03 sink gate/promise preparation, focused tests and evidence;
  retain U01/U02, PN source plan/scoped cancellation and bootstrap backup refs.
- Observed A+D: production 37, tests 126, docs 38; total 201 <= 400. Commit SHA is in the U03 receipt.

## U04 evidence

- Prior boundary / U03 commit: `2071fb7085e9c9a4015eb77365196ab3073d02ed`.
- State defaults enabled when capable. Off updates enabled/paused before callbacks,
  clears pause without resume and invokes disable once per edge. On flips only
  enabled; unsupported static capability cannot be overridden by runtime enable.
- `disableService` attempts stop before cache clear and contains each failure.
  `withPause` gates narration/status/Repeat with a default-true enabled reader;
  lifecycle forwarding and optional `stopSession` are retained unchanged.
- RED: `bun test test/wiring.test.ts` produced 82 pass / 6 fail, 177 assertions,
  exit 1 (missing state/helper/disabled wrapper gates). GREEN: same command
  produced 88 pass / 0 fail, 199 assertions, exit 0.
- `bun run typecheck` and `git diff --check` passed. Deterministic state/helper
  harness verifies flag/callback ordering, containment, no resurrection, static
  capability and scoped stop forwarding through existing `stopFor`; duplicate user
  events and unscoped-error global cancellation retain their behavior.
- No full suite or real audio/host proof; N/A for this helper-only boundary.
  Actual plugin binding, speed and source-plan/sink changes are outside U04.
- Rollback boundary: U04 state/lifecycle/wrapper helpers, focused tests and evidence;
  preserve U01–U03, PN scoped cancellation and all bootstrap safeguards.
- Observed A+D: production 41, tests 92, docs 35; total 168 <= 400. Commit SHA is in the U04 receipt.

## U05 evidence

- Prior boundary / U04 commit: `f97d195213559001528cdfabed7ed87a246ac421`.
- Actual factory resolves cache capability before creating state, then shares one
  enabled reader with PN sink, Repeat control and wrapper. Explicit On/Off actions
  update state before owned stop/cache clear; transport remains available while Off.
- PN plan generation, derived synthesis, language/voice/backend selection, async
  post-plan validation and both scoped-stop wrapper paths remain intact. Only a
  four-line preservation note was added to the current PN tracker, not a donor copy.
- RED: `bun test test/wiring.test.ts test/speech-sink.test.ts test/audio-cache.test.ts`
  produced 154 pass / 6 fail, 447 assertions, exit 1 (binding absent). Initial GREEN
  was 160 pass / 0 fail, 479 assertions; final expanded checks yielded 162 pass /
  0 fail, 489 assertions, exit 0. Typecheck and diff checks passed.
- Silent actual-factory tests prove static capability, transport, state isolation
  and no persistence. Temporary fixture environment is restored; factory caches
  use the owned fixture root, never existing host caches. No player host starts.
- Composed actual PN sink/cache/wire tests prove Off preparation/synthesis races,
  late success rejection, frozen hold release, physical cache deletion, no stale
  Repeat after On, short/long bounded plans and scoped cancellation/isolation.
- Exact Repeat keeps file/revision/bytes with zero extra parser, fake plan-engine
  dispatch or synthesis calls. Real resolver/model inference was not exercised;
  no audibility, production model, host activation or full-suite claim is made.
- Rollback boundary: U05 plugin binding, focused tests and task evidence only;
  preserve U01–U04, authoritative PN source plan, defaults and bootstrap backups.
- Observed A+D: production 20, tests 210, docs 43; total 273 <= 400. Commit SHA is in the U05 receipt.

## U06 evidence

- Prior boundary / U05 commit: `29c57244b6156b5c3d307d9cb0e9620c643f509c`.
- Sidebar enabled state is neutral until confirmed. Explicit On/Off requests use
  the confirmed instance/nonce/TTL; clicks never optimistically change the state.
  Off keeps service control available, but gates Pause/Repeat. Voice is unchanged.
- Renewal copies enabled state immediately for the accepted instance without
  extending its old lease until settlement. Wrong/malformed/stale/conflicting
  replies and failed transport cannot confirm state; fresh discovery can recover.
- Title icon uses theme success/error/textMuted and a confirmed click guard;
  default button styling, voice config/dialog mouse-up behavior and route binding
  remain intact. No transient service state is written to config or rate UI added.
- Historical attempt (not rerun): focused RED 124 pass / 10 fail, 455 assertions,
  exit 1; GREEN 134 pass / 0 fail, 510 assertions, exit 0 with the command below.
- `bun run typecheck` and `git diff --check` passed. Existing Bun TSX transpilation
  proves syntax, and the extracted registration callback checks public slot props;
  tsc excludes TSX. Source guards cover theme/Voice wiring, not a mounted renderer.
  No full suite, actual-host visual, audibility or model proof is claimed.
- Rollback boundary: U06 sidebar controller/TSX, tests, README and task evidence;
  retain U01–U05 PN lifecycle, defaults and all bootstrap safeguards.
- Recovery preserved the interrupted 217-line partial diff without rewriting code.
  Only this evidence was reconciled; the earlier done marker was not commit proof.
- Fresh: `bun test test/repeat-ui.test.ts test/wiring.test.ts` yielded 134 pass /
  0 fail, 510 assertions, exit 0. Typecheck and closing diff check passed (exit 0).
  No RED was recreated. TSX/slot proof remains syntax/extracted-callback only.
  U06 closes locally with its commit receipt; U07 requires the next bounded writer.
- Observed A+D: production 58, tests 114, docs 51; total 223 <= 400. Commit SHA is in the U06 receipt.
