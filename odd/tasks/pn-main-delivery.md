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

## Revision 2 final local evidence (2026-10-13)

**Status: COMPLETED within authorized local preparation scope.** Licensing and listening acceptance remain unresolved; completion does not grant publication permission. The bootstrap sections above retain their then-pending checklist/next action; this section records the observed completion and replaces that next action. Expanded scope file and full mirror #2305 were read back before installation/test edits. Mirror revision history retains both prior preparation evidence and the scope expansion.

### Installation and portable test changes

The single authorized `bun install --frozen-lockfile --ignore-scripts` returned exit 0: 90 packages installed in 7.10 seconds. No lifecycle scripts, pip, package additions, version updates or fallback installation were run. Raw Git object hashes before and after are identical: bun.lock `f4ca949de23a9ac145a2d9d4d3c1098884fe20f8`, package.json `4711d733becaa412ee50ab57a544ad3ebb672e3e`. node_modules remains ignored/untracked and absent from every prepared tree.

Only locator imports/constants/subprocess arguments changed in the four tests. All assertion, test-declaration and skip-condition lines were mechanically compared with original snapshots and remained identical. Original blob EOL style and terminal-newline presence were preserved, including the Python file's absent terminal newline. No production behavior or generic absolute-path fixture policy changed. No source-mutating normalization occurred after source freeze. Required mocked-probe tests still execute; optional validator/model absence behavior remains unchanged.

### Regenerated provenance and ref safety

All 25 original commits were recreated in order with original author identities/dates and meaningful Conventional Commit subjects. Sanitized documentation from the first preparation was retained. The expanded scope document was carried unchanged throughout the recreated trees. New bootstrap tracker is `812dc348555e26fbc76c1849232d222a4d4bfea6`, directly above main; it was not advanced to terminal. Last recreated source snapshot is `c31c32c054a566541215acb55aacc1ea461d8993`. Final workspace is attached to delivery/pn-15-license-notices, which includes one final conventional documentation-only evidence commit. Its own SHA is resolved from that ref rather than embedded in its content.

All 16 owned delivery refs were checked against exact prior full SHAs and replaced in one Git update-ref start/prepare/commit transaction. No blind force, branch deletion or original/published-history rewrite occurred. Previous delivery commit objects and prior mirrors remain available as historical evidence. Production/resources/locks/other tests at each recreated snapshot retain the exact original objects and modes outside the ten authorized paths.

| Original full SHA | Revision 2 recreated full SHA |
| --- | --- |
| a517ec421bcceb09aac0a1f443f4d3d0b0af5ac0 | aae92efd01268384a91cfdbb9f62a564da042d5d |
| 03a13e84e0ac563809fb921a9fa73d3adef67cfc | 0b90a75a606873c7f742ccbea3e648517c89f1ca |
| 74b9644b8ebf555bc2ebd6ea469348d9cd5c92a3 | c5271464df2118c649e84b96e9674782e386cc33 |
| d3f3ff663224751bb8515e2bf112fc6a59d722b0 | 520b2d8874ec30e762575485ffc463739ad521d6 |
| 5804e007e68ec4de9b66d861615d2fd0bd6327f4 | edce99f2c8e94e3b19c554e31f81b585be89a47a |
| 9dcca5a577947730eadc2d3acafaf467197c93e5 | 2befb854d18ec5ee6434b91f1c110a09176c7196 |
| 975b447cf81e7a73523be9f1c5b87f05cdc38412 | 03a609290186c8fc3034f46e0b3f1ae7dd5ee2e3 |
| db77b0bc80b9bb80dbfd27663554e7eb80aa1d30 | 296aa7b50ae99601750f3ff1d9e06665c4ae5268 |
| a7c9db9bbd11d18c9c8cf1b201341e895d8b0328 | 951214dbf5ed933cd809dd008396c52ebb65bb92 |
| 966a1823487c83a163b932094138e1b3c9ef8cfe | c9b983b01ed3f509c138bc16a0856d5f29e1480d |
| f43c3db3aae7008dd17ad8b963dfe63808aed37e | 10c6d9228d309b55efd792656c3cb0c0acb557f7 |
| f3d9025190633a08940eb15fae2fc82ee9973320 | dfa8abaaeb075f3eec302cfaf41b02e5f9696260 |
| 95d6faf88df262bde77c2fff1fe46f1a5f9f0e6e | 5b1cdd6c2dc8611a9b330b672b897c3d21c6517d |
| 3338f0aa032d1cfb27e0abbd4f8403537dafe4a7 | 8b4fb971e74d2c95e685ea607563bb214acd6806 |
| 19e992cc5959fe37155cb9a52977ee7837124fd4 | dc792d20f90f12b24b9eb4b46f77b9a5944af880 |
| 3b7dd02879aa8f366ecafe99ffac0cf4e8d96ba7 | a5fae98c7163d18d0c5b835a7368339809822d0a |
| dfc130726227ee214a4508ea9a218c76cd19ae55 | 6cc327e67310f325036da91b824d77b432926c1d |
| 1d50fde9827f5e6f218b1bb097baeb93f4bf4cb2 | 251c2cd18f9061395116bef5b7a0413176af4252 |
| f162e19bc9d3a031547c14b5423bfc6e3166d1ba | 8d076445171ee084d3bfa7a8fa455c5601a90a3d |
| c7bbe0b1a8ceb4887dfea71142ffc771dc2c4b5b | ad1cd8e314012df2e17fe79b0bc1ecafa48ef3fc |
| 3d21fd13d460842f2b0bec53512ae2157e45492f | d5e2f1bdb021e8d54bc47a9c26752d70a85cc1a6 |
| 4c45067cc749374ce546d92c80f0381bee3fa31f | 304d87cc90313d010d4aab78476017f7a6ba2217 |
| 1843e94c5b9be1cb1ad4f3bc54193c86853e27cf | 01e8df661beaafdc242c179e6aa31868323e1257 |
| 08d33337643f0249cfed1e2782f3c82f156f20ba | 401fc7a7e73fc4be45f822fa65460ec13bea6d73 |
| 20040db077177b2a3ea7396a1652a68e441788fb | c31c32c054a566541215acb55aacc1ea461d8993 |

### Adjacent local review endpoints

Every name has the delivery/ prefix; each child targets and contains its previous row, with D01 targeting tracker. Counts are actual endpoint additions + deletions, including docs/generated locks, not estimates. Bootstrap's 58 lines are separate and are not re-added in child diffs. D04 includes 123 generated bun.lock changed lines. The last row includes final evidence. Each unit keeps behavior/tests together, depends on prior children, and has the next row as follow-up; P3b/P4 are excluded. No PRs or independent per-child runtime/review-time guarantees are claimed.

| ID / ref suffix | Original boundary | Fresh endpoint | Fresh base | A+D |
| --- | --- | --- | --- | --- |
| D01 pn-01-player | 74b9644 | c527146 | 812dc34 | 1419+11=1430 |
| D02 pn-02-pause-state | 9dcca5a | 2befb85 | c527146 | 839+169=1008 |
| D03 pn-03-pause-resume | 975b447 | 03a6092 | 2befb85 | 1088+57=1145 |
| D04 pn-04-plan | db77b0b | 296aa7b | 03a6092 | 1119+43=1162 |
| D05 pn-05-resolver | a7c9db9 | 951214d | 296aa7b | 1194+19=1213 |
| D06 pn-06-synthesis | 966a182 | c9b983b | 951214d | 950+230=1180 |
| D07 pn-07-provisioning | 95d6faf | 5b1cdd6 | c9b983b | 1036+55=1091 |
| D08 pn-08-host-fixes | 3b7dd02 | a5fae98 | 5b1cdd6 | 399+17=416 |
| D09 pn-09-delivery-record | dfc1307 | 6cc327e | a5fae98 | 122+176=298 |
| D10 pn-10-onnx-backend | 1d50fde | 251c2cd | 6cc327e | 746+0=746 |
| D11 pn-11-onnx-assets | f162e19 | 8d07644 | 251c2cd | 736+1=737 |
| D12 pn-12-onnx-setup | c7bbe0b | ad1cd8e | 8d07644 | 568+5=573 |
| D13 pn-13-backend-selection | 3d21fd1 | d5e2f1b | ad1cd8e | 602+18=620 |
| D14 pn-14-prose-routing | 08d3333 | 401fc7a | d5e2f1b | 226+4=230 |
| D15 pn-15-license-notices | 20040db | local ref (c31c32c + evidence) | 401fc7a | 421+33=454 |

Explicitly approved cohesive size exceptions apply to D01-D08, D10-D13 and D15 including evidence; no code golf or dropped tests. The original unit/scope boundaries were retained, not repeatedly resliced.

### Exact observed verification

The following ran once in foreground from the regenerated checkout after source freeze. OPEN_VOX_TEST_ONNX_ASSETS was set only for that tool process to the existing read-only reference assets; no host/persistent environment was changed. Interpreter overrides were not needed: TS managed-home fallbacks and Python sys.executable worked. Real reference checks remained available rather than being silently skipped.

| Command | Observed result |
| --- | --- |
| bun test | Exit 0; 500 pass, 2 skip, 0 fail; 1774 assertions; 502 tests across 23 files; 10.75 s. |
| bun run typecheck | Exit 0; tsc --noEmit. |
| & <app-home>/pn-venv/Scripts/python.exe -B -m unittest discover -s test/python -p 'test_*.py' | Exit 0; 121 tests, OK (skipped=1), 3.252 s. Existing unsupported-symbol U+2603 negative diagnostic printed. |
| git diff --check | Exit 0. |
| git diff --check 5fe4faf HEAD | Exit 0; no inherited or newly introduced whitespace errors in prepared base-to-tip diff. Final documentation delta checked separately before commit. |

### Identity, privacy and preservation

Every recreated snapshot was validated against its original source: all objects and Git modes outside the ten allowed paths are identical, and diff name lists contain only allowed paths. Original production/config/locks/resources and other test bytes therefore remain unchanged at each boundary. Original refs plus both original checkout HEADs/status/tracked hashes were checked before replacement and at final closure; main/PN/P4/cached refs retain the checkpoint table values. The installed host remains untouched and attached to original PN.

All new snapshot docs and four tests were scanned for personal absolute paths and identified scratch locators; none matched. Generic absolute-path fixtures remain by design. Public upstream documentation URLs are retained. No node_modules, venv, model/audio/binary asset or blob over 10 MB appears in regenerated trees. Tests left only the known untracked scripts/__pycache__, preserved/excluded rather than staged or cleaned. Prior caches and original dirty files were never edited. This bounded locator scan is not a guarantee against every possible private datum; base-inherited history and previous/public commits are not erased or globally sanitized.

### Completion and remaining acceptance

- R01-R06 completed: authority/readback, one frozen install, locator-only regeneration, snapshot/ref/state checks and exact regression commands succeeded. No artificial functional RED or new skip was introduced.
- R07: one final documentation-only commit records this evidence; full mirror/readback is recorded in the worker return. Previous evidence survives in old commit objects and mirror revisions.
- Licensing remains unresolved exactly as stated above and in THIRD_PARTY_NOTICES.md; no legal assurance, additional research or package-policy change.
- Listening remains bounded to historical short mixed-language acceptance; long texts, separate Pause/Resume/Repeat coverage and other unobserved host/resource gates remain open. No audio or runtime activation occurred in this unit.

Next action: stop at the prepared local chain. Publication, PR creation, merge/integration, native review or host repointing still require separate authorization. No automatic continuation is authorized.
