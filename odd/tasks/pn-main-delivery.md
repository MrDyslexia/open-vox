# PN local delivery preparation

Prepare a sanitized local feature-branch chain for P1 -> P2 -> P3a -> PN. Revision 2 adds explicitly authorized dependency resolution and four test-harness locator changes. This is not publication consent, legal clearance, host activation or global erasure of existing history.

## Authority and boundaries

- Route: delegated, one bounded worker; no child delegation. RDD remains clone-local OFF; no review or configuration toggle.
- P3b (On/Off) and P4 (speed) are deferred. User-approved cohesive-unit size exceptions above 400 additions + deletions remain applicable; keep tests with behavior, never compress source to meet the budget.
- The user approved complete local preparation after the prior partial result. Run exactly `bun install --frozen-lockfile --ignore-scripts` once, only in the delivery checkout. Dependency downloads are authorized; no other installation, package/version/lock update, pip or lifecycle script is authorized.
- Authorized documentation: README.md, THIRD_PARTY_NOTICES.md, odd/tasks/playback-controls.md, odd/tasks/pronunciation-normalization.md, odd/tasks/repeat-renewal.md and this document.
- Additional authorized test surfaces: test/narration-onnx-assets.test.ts, test/setup.test.ts, test/setup-onnx.test.ts and test/python/test_narration_lid_onnx.py. Change locators only; preserve assertions, fixture meanings, test coverage and existing skip policy. No production API or other source/resource/test changes.
- Recreate all 25 original snapshots; all paths outside these ten surfaces must retain original objects and Git modes. Preserve line endings; no source-mutating normalization after freeze. Dependencies and incidental caches stay untracked and out of all trees.
- Only the worker-owned 16 delivery/pn-* refs may be regenerated, using an atomic exact-old-SHA compare-and-swap. Abort on any unexpected value; never blind force, delete branches or rewrite original/published refs. Tracker stays bootstrap-only above main, not terminal.
- No remote Git/GitHub operation, push, PR, merge, host/app-home change or activation. Existing assets/interpreters may be used read-only; test-owned temporary output is allowed.

## Reconciled checkpoints

| Checkpoint | SHA / observed state |
| --- | --- |
| main and cached origin/main | 5fe4faf5fb89d29d29152df785e49641eb12fbcb |
| original feat/pn-implementation | 20040db077177b2a3ea7396a1652a68e441788fb |
| cached origin/PN-01 | dfc130726227ee214a4508ea9a218c76cd19ae55 |
| original P4 branch | d40f0da678306e2b34a56af9e2e4021985692c42 |
| previous delivery tracker | 16052e9807d2c4143f39ae31d17183fb8ce9a6f9 |
| previous delivery final | f7a5e059db83600c5d0f4a1f41a7e0dec38d1b3e |
| delivery checkout at continuation entry | previous final, only untracked scripts/__pycache__/ |

The previous full document was read from the checkout and Engram #2305, topic odd/pn-main-delivery/tasks. Its complete original/fresh mappings, counts and partial verification remain in the prior commit and mirror revision history. The original playback checkout retains 11 unstaged paths; original PN retains its untracked cache. Preserve their HEADs, refs, tracked hashes and status exactly. The installed host remains attached to original PN.

## Historical evidence, not current verification

Prior fresh-checkout `bun test` failed due to absent dependencies: 245 pass, 9 fail, 9 errors; typecheck failed because tsc was unavailable. Python ran 121 tests OK/1 skip; whitespace checks passed. All 25 prior snapshots matched original non-document objects/modes. Four test locators remained outside the then-authorized edit scope. No new functional RED is claimed: this continuation uses a proportional locator-only harness exception and retains all assertions.

## Portable locator contract

OPEN_VOX_TEST_PYTHON selects a subprocess interpreter. TS fallback uses OPEN_VOX_HOME or LOCALAPPDATA/home-derived open-vox, with kokoro-venv for mocked probes and pn-venv for validator parity; platform-specific Scripts/python.exe or bin/python is appended. Python fallback is sys.executable. OPEN_VOX_TEST_ONNX_ASSETS points directly to the reference assets directory; fallback is the OS temporary directory's open-vox-reference-assets/assets. Verification supplies the existing reference directory through this process-only override so real model checks are not quietly skipped. No host environment is persisted. Required mocked probe checks still fail if the interpreter is unavailable; optional validator/model checks retain their prior absence behavior and every assertion.

## Stable checklist

- [x] R01 Reconcile prior final/ref/cache state and read prior document/full mirror.
- [ ] R02 Read back this expanded scope document and full mirror before test edits or installation.
- [ ] R03 Run the one frozen, ignore-scripts install; assert package.json and bun.lock bytes unchanged.
- [ ] R04 Apply locator-only edits to all relevant recreated snapshots, preserving all assertions and line endings.
- [ ] R05 Validate each snapshot's outside-scope objects/modes, privacy scan, child ancestry and original state before exact-SHA ref replacement.
- [ ] R06 From the final regenerated checkout, run bun test, bun run typecheck, managed Python -B unittest and working/base whitespace commands once in foreground.
- [ ] R07 Commit one final documentation-only record with revised mappings/counts/results; save and read back the full mirror.

## Verification, limits and rollback

New verification is pending. Historical target baseline is Bun 500 pass/2 skip, Python 121 tests OK/1 skip, tsc exit 0; report exact observed results rather than assume parity. Scan tracked documentation and the four tests across all new commits, excluding dependencies/runtime outputs/untracked caches. Generic absolute-path fixtures remain authorized and unchanged.

Model/checkpoint/base-model/dataset licensing chain, espeak-ng binary terms, libsndfile build terms and GPL applicability remain unresolved. No redistribution-only assurance or legal clearance is made. Historical short mixed-language listening acceptance does not establish long-text or separate Pause/Resume/Repeat acceptance; other unobserved gates remain open.

Rollback is bounded to the worker-owned delivery worktree/refs and requires separate authorization for removal. Existing commits remain intact and original worktrees are never reset, cleaned or rewritten. Separate authorization is still required for publication, integration or host repointing.

## Next action

Read back this scope document and its full mirror; then perform the single authorized install, read the four tests, regenerate validated snapshots and compare-and-swap only the owned delivery refs. Stop on install uncertainty or ref/source mismatch; do not retry blindly or expand fixture policy.
