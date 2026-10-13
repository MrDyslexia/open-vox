# PN-first playback unification

Preserve the delivered pronunciation-normalization (PN) pipeline while adding
instance-scoped service On/Off and playback rates in small, coherent work units.
The current bootstrap creates safeguards and this plan only. Next unit: **U01**.

## Objective and authorization

The original P3b/P4 playback work predates the delivered PN source-plan pipeline.
Copying the old plugin wholesale would lose scoped cancellation and PN behavior.
Port only the missing behavior onto the exact PN delivery baseline instead.

- Local source integration is authorized for subsequent units, not this bootstrap.
- Bootstrap edits are limited to `odd/tasks/unified-playback-narration.md`.
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
| [ ] U01 | Cache clear/invalidation and compatible mocks | 170–195 | baseline |
| [ ] U02 | Service wire and safe dispatch | 145–175 | U01 |
| [ ] U03 | PN sink enabled checks at admission, post-plan, pump, status, Repeat | 195–240 | U01–U02 |
| [ ] U04 | Enabled state / Off lifecycle wrapper; forward `stopSession` | 165–205 | U03 |
| [ ] U05 | Wire On/Off to actual PN instance; clear cache, cancel, combine counters | 300–375 | U01–U04 |
| [ ] U06 | Service UI confirmed state and TSX | 255–290 | U05 |
| [ ] U07 | Closed rate wire: 1 / 1.5 / 2 and safe dispatch | 165–190 | U06 |
| [ ] U08 | Existing-player rate regression tests only | 240–255 | U07 |
| [ ] U09 | Runtime rates preserve cached PN audio | 365–395 | U07–U08 |
| [ ] U10 | Confirmed rate UI | 280–310 | U09 |

U09 is the hardest ceiling: preserve all necessary regression tests. No source
materialization or implementation is part of bootstrap. All boxes remain open.

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
- Integration behavior and PN regression proof remain **pending U01–U10**.
- Bootstrap commit identity belongs in the memory receipt; this document cannot
  embed its own final hash. A future U01 update may record that observed SHA.

## Next step

Start U01 only after reconciling this repository-relative document with its full
Engram mirror at `odd/unified-playback-narration/tasks` in project `agentvoz`.
Recheck original preservation, prepare deterministic cache invalidation tests,
and retain the 400-line closing guard. Bootstrap stops before that source work.
