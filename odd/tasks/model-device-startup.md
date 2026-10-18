# Pre-load model device selection

## Objective

Detect usable GPU/runtime capabilities before loading the language decision model or Kokoro, choose CUDA when supported and otherwise CPU, and preserve safe CPU fallback.

## Problem and context

Before this feature, the decision detector forced CPU, and Kokoro relied on package defaults. Python workers are launched per utterance and can use different virtual environments, so selection belongs before model loading inside the actual worker, not in a stale global hardware-only flag. The host has an NVIDIA GPU but installed environments currently lack accelerated ORT providers. This feature must not pretend to enable GPU on those environments.

## Scope and constraints

- Shared model-free provider/device probe, reusable ONNX session construction, decision ONNX/Torch selection, and Kokoro session injection.
- Initial policy: usable CUDA first, CPU fallback. Do not add DirectML/CoreML support or user-facing settings in this slice.
- Probe before models load; preserve lazy loading, integrity validation, FP32 detector contracts, local-only assets and unchanged output/normalization behavior.
- Bounded capability detection and one CPU initialization fallback; report actual registered providers rather than claiming all nodes execute on GPU.
- Safe allowlisted diagnostics only: no input text, exception contents, credentials or absolute paths.
- No dependency installation, downloads, real model loads/inference, audible playback, global config changes, remote operations or GPU activation during development.
- Managed runtime provisioning remains unchanged; GPU package/provenance support is a separate prerequisite for actual acceleration.
- Existing snapshot committed as 2e1f29c before this work. No automatic commit of new GPU changes or push is authorized.
- User-approved follow-up: display per-model selected CPU/GPU runtime below the Open-Vox TUI title, pending before confirmation. Report last confirmed runtime, not utilization or a claim that workers remain loaded. Source and installed sidebar may be updated for this display only; no JSON configuration edits.
- Post-G6 live defect (fixed): the managed GPU worker was launched with `-I`, which ignores PYTHONUTF8/PYTHONIOENCODING, so planned narration read the plan from stdin with the locale code page. Accented text (for example Spanish) was mis-decoded, plan validation failed and synthesis exited with code 2, so nothing was spoken inside OpenCode. ASCII-only text passed, which is why G6 qualification and the earlier bun-side checks missed it. Fix: pass `-X utf8` in `src/kokoro-engine.ts` (regression asserted in `test/kokoro-engine.test.ts`). Verified with the real engine on three accented/markdown inputs: exit 0, `lid: gpu, kokoro: gpu`, about 5.4 s each. Bun 719 pass, 5 skip; typecheck clean. Gap: the qualification harness uses ASCII text and does not exercise the stdin launch path; accented-text coverage there remains a follow-up.
- G5/G6 authorization supersedes earlier development-only restrictions for this slice: the user explicitly approved public runtime package downloads (~2.6 GB estimate), two new sibling GPU environments, temporary qualification output, real local model inference without playback, and activation only after successful qualification. Preserve all CPU environments, existing model assets, global Python and driver. Reserve approximately 8–12 GB free; do not treat estimates as measurements. No new commits/pushes authorized.

## Authorized edit surfaces

- scripts/runtime_device.py (new)
- scripts/kokoro_say.py
- scripts/narration_lid_onnx.py
- scripts/narration_lid.py
- test/python/test_runtime_device.py (new)
- test/python/test_kokoro_say_backend.py
- test/python/test_narration_lid_onnx.py
- test/python/test_narration_lid.py
- README.md
- odd/tasks/model-device-startup.md (new)
- src/kokoro-engine.ts
- src/speech-sink.ts
- src/piper-engine.ts
- src/plugin.ts
- src/repeat-control.ts
- src/repeat-ui.ts
- tui/open-vox.tsx
- test/kokoro-engine.test.ts
- test/speech-sink.test.ts
- test/piper-engine.test.ts
- test/wiring.test.ts
- test/repeat-control.test.ts
- test/repeat-ui.test.ts
- test/installer.test.ts
- src/setup-gpu.ts (new if needed)
- src/gpu-runtime.ts (new if needed)
- src/setup.ts
- src/setup-onnx.ts
- src/narration-onnx-assets.ts
- src/narration-runtime.ts
- src/config.ts
- src/cli.ts
- resources/runtime-cuda13-windows.json (new)
- scripts/gpu_runtime_probe.py (new if needed)
- tools/qualify_gpu.py (new)
- test/setup-gpu.test.ts (new)
- test/gpu-runtime.test.ts (new)
- test/setup.test.ts
- test/setup-onnx.test.ts
- test/narration-onnx-assets.test.ts
- test/narration-runtime.test.ts
- test/narration-onnx-doctor.test.ts
- test/config.test.ts
- test/cli.test.ts
- test/python/test_qualify_gpu.py (new)
- test/python/test_gpu_runtime_probe.py (new if needed)

## Tasks

- [x] G1: Implement shared pre-load capability selection and wire both detector backends and both Kokoro paths, with deterministic regressions and documentation.
  - Route: delegated direct; preparation/multi-file writer triggers apply.
  - Acceptance: CPU-only environments remain functional; supported CUDA is requested before model loading; unavailable, rejected or silently-fallen-back CUDA yields truthful CPU outcome; corrupt assets are not misclassified as GPU failure; Torch model/tensors use the same device; no inference-time retry loop or duplicate synthesis.
- [x] G2: Independently inspect behavior and rerun focused fake-runtime checks, Bun tests, typecheck and diff integrity; report actual-GPU qualification as unverified.
  - Route: delegated verification plus one parent focused-command spot check.
- [x] G3: Carry confirmed per-process model-device diagnostics through lifecycle-safe status and display a muted line below the title.
  - Route: delegated direct; multi-file writer/preparation trigger.
  - Acceptance: per-model CPU/GPU/Pending, no GPU hardware-only inference; direct and planned Kokoro supported; cancelled, invalidated, stale configuration or malformed diagnostics cannot publish state; missing/legacy/partial snapshots remain honest and do not mix different runs.
- [x] G4: Independently verify status/display and update the installed sidebar copy without modifying its absolute import roots or other configuration.
  - Route: delegated checks and parent mechanical deployed-file sync; no live inference/audio.
- [x] G5: Add pinned, hash-verified CUDA13 Windows environment provisioning, profile-aware readiness and selection, managed DLL preloading and a real qualification harness (source and mock verification, independent pre-provisioning review, and the P1/P2 corrections are complete; real provisioning and qualification are recorded under G6).
  - Route: delegated direct; preparation/multi-file writer. Seal public wheel metadata before downloads, never co-install overlapping CPU/GPU ORT distributions; recognize only the narrow equivalent Kokoro runtime dependency. Keep existing CPU defaults/fallback intact. Dependencies-ready and inference-qualified are distinct states.
- [x] G6: Provision pn-onnx-gpu-venv and kokoro-gpu-venv, verify offline inference and actual CUDA node evidence, then activate the qualified GPU profile.
  - Route: separate bounded local provisioning/verification worker after source tests and independent review. Authorized roots: local app home sibling GPU environments and readiness/qualification markers; temporary qualification output under the pre-approved Temp/opencode directory; runtimeProfile only in local Open-Vox config. No OpenCode config/driver/global Python edits or playback. Preserve old CPU envs/assets; select CPU on failure.

## Verification

Default test-first policy: mock runtime/device dependencies, observe meaningful RED, implement GREEN, refactor with checks. No configured strict TDD mode is established. Do not run conditional real-asset inference tests.

```text
bun test
bun run typecheck
python -B -m unittest discover -s test/python -p test_runtime_device.py
python -B -m unittest discover -s test/python -p test_qualify_gpu.py
python -B -m unittest discover -s test/python -p test_gpu_runtime_probe.py
git diff --check
```

From test/python, run the existing mock-only classes:

```text
python -B -m unittest test_narration_lid.LidTests test_narration_lid_onnx.ManifestTests test_narration_lid_onnx.IntegrityTests test_narration_lid_onnx.LoadTests test_narration_lid_onnx.DetectTests test_kokoro_say_backend.ArgumentTests test_kokoro_say_backend.ToneArgumentTests test_kokoro_say_backend.LazyImportTests test_kokoro_say_backend.EndToEndStubTests
```

## Progress and delivery

- G1 and G2 complete; new device-selection changes remain uncommitted after snapshot 2e1f29c. Independent source and installed-API inspection found no blocking defect. Verifier reran 13 helper tests, 76 mock-only tests (75 pass, one skip), Bun (682 pass, five skips), typecheck and diff integrity successfully. Parent separately reran all 13 helper tests successfully.
- Shared immutable worker candidate: ORT capability plus one driver/device subprocess with a two-second timeout; Torch availability is checked only for the selected Torch path. No Torch import for ONNX/direct selection.
- Both Kokoro paths inject explicit file-backed sessions through the installed `Kokoro.from_session` API. ORT constructor fallback is disabled with `enable_fallback=False`; inference-time fallback is also disabled.
- Registered CPU-only sessions are accepted truthfully without a second initialization. Recognized accelerator initialization failures allow one fresh CPU initialization, independently for each model. Asset/graph errors and inference failures do not trigger synthesis retries.
- Torch uses explicit FP32, local-only safetensors, eval/no_grad, and matching model/input placement. Accelerator placement failure permits one fresh CPU model; unrelated loading/placement failures remain failures.
- Existing validation and lazy detector constructors remain compatible. Model-specific selection codes use the existing planned JSON diagnostics envelope; direct success remains quiet. No exception text, paths or input is included.
- Meaningful mocked RED: the CPU-only session implementation produced 5 failures and 1 error across 11 helper tests, including missing CUDA selection/fallback and provider validation. Initial missing-module RED was also observed, but is not the behavioral evidence.
- GREEN: `python -B -m unittest discover -s test/python -p test_runtime_device.py` ran 13 tests, all passing.
- GREEN: the exact mock-only class command above ran 76 tests successfully, with one unavailable-symlink skip. Conditional real-asset test classes were not run.
- GREEN: `bun test` ran 687 tests across 24 files: 682 passed, 5 skipped, 0 failed, 2691 assertions, 15.84 seconds.
- GREEN: `bun run typecheck` passed (`tsc --noEmit`). `git diff --check` passed; Git emitted only expected LF-to-CRLF working-tree warnings.
- Normalization: authorized edits were written with normalized LF endings through the patch tool before final checks; no arbitrary formatter was introduced. Python commands and the focused lazy-import subprocess use `-B`.
- Actual full diff including new files: 603 additions and 34 deletions, 637 changed lines across 10 authorized files (including this 82-line task document). Implementation/README/tests account for 555 changed lines. This exceeds the advisory 400-line review budget; tests were retained without compression.
- CPU remains the expected outcome on this host based on the parent's preflight evidence: all three installed ORT environments advertise Azure+CPU, not CUDA. No native runtime/driver qualification or real model session was performed by this writer.
- GPU provisioning remains a separate prerequisite: setup still requires CPU Torch and the pinned ORT distribution/provenance. No dependencies or readiness checks were altered to activate GPU.
- Delivery strategy ask-on-risk; no next commit/push requested for this feature.
- RDD off clone-local; preserve preference and do not start native review.
- Pre-existing scripts/__pycache__/ and test/python/__pycache__/ were preserved. No children/subagents, staging, commits, branch changes, installations, downloads, network calls, real inference, live audio or native review were initiated.
- Skill resolution: loaded work-unit-commits and context7 from the requested config paths, and cognitive-doc-design from the requested .agents path. Explicit no-commit/no-branch and no-network authorization overrides skill defaults; installed package source was inspected read-only instead of querying remote documentation. CodeGraph fallback was already authorized after prior index failures; no index operation was attempted.
- Next: separately authorized accelerator provisioning and real-runtime qualification if requested. Installed CPU-only environments continue to select CPU. Mounted/native integration, actual GPU sessions, latency, numerical parity and audio quality remain unverified; no installed UI/config update is required for this helper change.
- Recovery mirror: odd/model-device-startup/tasks, Engram project pc; full document plus relative locator.

### G3: Per-model sidebar runtime confirmation

- Implemented `LID: CPU/GPU/Pending · Kokoro: CPU/GPU/Pending` in a muted row immediately below the title and before the buttons. The formatter remains in repeat-ui, so the installer still rewrites only config and repeat-ui imports.
- Direct Kokoro now emits the existing bounded diagnostic JSON envelope only after audio write succeeds; it does not use or confirm LID. Planned synthesis retains both models' registered runtime codes, even when LID inference falls back. No extra synthesis, model load, capability probe or telemetry was added for status.
- Optional whole per-process snapshots propagate through the WAV wrapper, live engine, logged sink and pause wrapper. The sink copies/validates enums and commits only after successful, valid-generation narration completion, including cached playback. The status getter is separate from WAV availability and scoped to the displayed session.
- A new synthesis attempt clears the previous snapshot. Success replaces both fields, including missing values; legacy, malformed, unknown or contradictory provider codes cannot invent CPU/GPU confirmation. Stop, session invalidation/deletion, Off, disposal and observed engine/backend/settings changes clear status. Cancelled, timed-out, failed, rejected and stale completions cannot publish. Repeats preserve existing confirmation without reading another process or synthesizing again.
- Existing protocol/challenge/instance/session/TTL guards also govern devices. Renewal copies both fields, including absent values; expired, conflicting, Off or unconfirmed UI state shows Pending. The labels mean last confirmed selected runtime, not utilization, all-node acceleration, successful LID inference or still-loaded models.
- Meaningful RED before implementation: 163 passed and 3 failed across kokoro-engine, speech-sink and repeat-ui tests. Failures demonstrated missing per-process snapshots, missing lifecycle-owned status and missing device labels.
- Final focused GREEN: the seven requested Bun test files ran 376 tests, all passing, with 1502 assertions in 5.99 seconds. Coverage includes direct/planned parsing, invalid/partial/legacy/conflicting snapshots, per-model CPU/GPU, lifecycle/config invalidation, exact-process capture, wrapped engines, repeat preservation, protocol renewal/session/TTL, TSX row order/transpilation and actual-template installer import rewriting.
- Final full GREEN: `bun test` ran 708 tests across 24 files: 703 passed, 5 skipped, 0 failed, 2791 assertions, 15.56 seconds. `bun run typecheck` and `git diff --check` passed. The intermediate test-only unknown-type error was corrected before these final checks.
- Final Python GREEN: from test/python, `python -B -m unittest test_kokoro_say_backend.ArgumentTests test_kokoro_say_backend.ToneArgumentTests test_kokoro_say_backend.LazyImportTests test_kokoro_say_backend.EndToEndStubTests` ran 28 mock-only tests, all passing, in 0.420 seconds. No unrestricted discovery or conditional real-asset tests ran.
- All G3 source edits used normalized LF through apply_patch before final verification; no arbitrary formatter/install was used. Existing G1/G2 selector changes and both Python cache directories remain present. No staging, commits, branches, network, dependencies, installed-file edits, native review, real models or live audio were used. The combined change remains above the advisory 400-line budget; tests were not compressed or removed.
- G3 edit boundary: scripts/kokoro_say.py; src/kokoro-engine.ts, src/speech-sink.ts, src/piper-engine.ts, src/plugin.ts, src/repeat-control.ts, src/repeat-ui.ts; tui/open-vox.tsx; test/python/test_kokoro_say_backend.py; test/kokoro-engine.test.ts, test/speech-sink.test.ts, test/piper-engine.test.ts, test/wiring.test.ts, test/repeat-control.test.ts, test/repeat-ui.test.ts, test/installer.test.ts; README.md; this task document. Rollback must remove only G3 status additions, preserving the uncommitted G1/G2 selector work.
- Skill resolution for G3: loaded work-unit-commits from the requested .config path and cognitive-doc-design from the requested .agents path. Explicit no-commit/no-branch/no-network restrictions override workflow defaults. CodeGraph reported no index; direct source inspection was used without indexing or remote documentation.
- G4 complete: parent added `deviceLabel` to the installed repeat-ui import and inserted the muted row below the title, preserving both absolute import roots and all other installed content. Independent readback confirmed the deployed row at line 109 and compatible imports; no JSON edits or reinstall CLI. A pre-existing omitted optional `canSpeak: false` initializer and trailing blank line differ from the template but do not affect this feature.
- Independent G4 checks passed: seven-file Bun suite 376 pass, 0 fail; Python mock classes 28 pass; typecheck and diff integrity passed. Parent separately reran repeat-ui: 42 pass, 0 fail. No blocking functional defect found. Restart the OpenCode host to load updated backend and copied sidebar; no live activation or audio was performed.
- Mounted TUI rendering, native runtime/GPU qualification and actual audio remain unproven. Typecheck excludes the TSX template; the fake-source TSX transpile and ordering tests passed but are not a mounted UI test.

### G5: Source-only managed CUDA13 provisioning and qualification

- G5 source/mock implementation complete; G6 remains pending a separate independent check and provisioning actor. This writer performed public metadata research only: no wheels installed/downloaded, real models loaded/inferred, settings activated, audio played, migrations, native review lifecycle, staging, commits, branch changes or delegation. All prior G1-G4 changes and Python cache directories remain present.
- Sealed 38 CP313-compatible Windows AMD64/platform-independent wheels (23 common/direct, 15 additional LID). Re-fetched every exact public PyPI release JSON and matched filenames, versions, SHA256, sizes and URLs; independently evaluated the complete dependency closure for both roles against CPython 3.13 Windows AMD64 markers. No lock entries are pending. Compressed wheel totals: LID 1,323,058,107 bytes; direct Kokoro 1,314,347,191 bytes; combined 2,637,405,298 bytes (~2.64 GB), not a measured disk/transfer guarantee.
- New `setup gpu` validates the sealed lock, local paths, existing assets and 12 GiB free before reserving only `pn-onnx-gpu-venv` and `kokoro-gpu-venv`. Existing/partial destinations fail closed without cleanup, reuse or renaming. Base Python must be ordinary CPython 3.13 AMD64, not free-threaded. All failures stop; CPU environments/assets, global Python and driver remain untouched.
- pip uses explicit public wheel URLs/hash fragments, `--require-hashes`, binary-only/no-deps/no-cache mode and child-only isolation. The bootstrap disables ambient Requests proxies/netrc/authentication and constrains HTTPS redirects to PyPI/file hosts; installer scratch stays under the existing local Temp/opencode directory. No generic resolver or floating upgrades. Only pinned Kokoro 0.6.1's CPU ORT requirement receives the exact GPU-dist/import equivalence; other missing/incompatible requirements and overlapping ORT distributions fail readiness.
- `gpu_runtime_probe.py` verifies virtual interpreter/launcher/base identity, executable SHA256, all package pins/module origins and distribution roots, native RECORD hashes and NVIDIA namespace paths before required imports. Managed DLL directories derive from actual validated distribution files, including CUDA13 and cuDNN layouts. Preloading retains DLL directory handles, captures warnings/prose and checks loaded NVIDIA DLL provenance without global PATH changes or a hermetic-loader claim.
- `runtimeProfile` is the fixed enum cpu/cuda13, default cpu; the source backend default remains torch. Both GPU environments must have matching dependency and successful qualification records, unchanged package/asset stamps and hashed per-model CUDA compute evidence before either planned/direct dispatch selects them. Workers use isolated pre-import preflight and recheck native/package/interpreter provenance. Native preload failure selects CPU before provider enumeration; stale/unqualified profiles retain CPU fallback with bounded reasons. No GPU Torch installation is assumed. Existing CPU marker/provenance acceptance is unchanged.
- Activation is a separate `runtime-profile cuda13` command, requires the already-selected ONNX backend plus both qualifications and patches only the raw runtimeProfile field, preserving even unknown config keys. Invalid existing configuration is preserved rather than repaired. `runtime-profile cpu` explicitly rolls back without deleting environments/assets. Doctor separates dependency readiness, inference qualification and requested profile; per-process sidebar diagnostics still report actual selected providers, not utilization/all-node acceleration.
- `tools/qualify_gpu.py` is runnable with each new managed interpreter and a new output directory under local Temp/opencode. It enforces offline SDK flags/Python outbound-network rejection, validates unchanged local LID manifest/assets and Kokoro/voice fingerprints, runs synthetic bilingual LID/Kokoro inference with CPU sanity comparisons, writes finite nonempty WAVs without playback and requires each model's profiled CUDA compute kernel events. CPU nodes are counted separately; memory copies/provider advertisement are insufficient. Missing CUDA, partial inference or malformed evidence is nonzero and cannot publish qualification success.
- Qualification reports bind profile/interpreter/executable/packages/assets to dependency records. Filtered evidence aggregates repeated operator/provider events into bounded counts and hashes the original local trace; this avoids oversized reports for real graphs while retaining actual compute counts. Reports/evidence are published only after successful complete checks; partial output is preserved. Local markers are provenance, not signatures against a hostile local administrator.
- Meaningful RED: the existing runtime selector returned CUDA despite a mocked managed-preload failure (1 failure among 14 helper tests). Missing-module RED also occurred for the initial new test files; it is not the behavioral proof. The first GPU probe test run exposed absent base-interpreter packaging; tests now inject the base pip's bundled parser, while production still requires the provenance-checked locked packaging distribution. Final focused Bun: 116 pass, 0 fail across five files.
- Final GREEN after LF patch normalization and bounded-evidence changes: `bun test` 719 pass, 5 skip, 0 fail, 2,890 assertions across 26 files in 15.68 seconds (724 tests total); `bun run typecheck` passed; named Python suites: runtime_device 14/14, qualify_gpu 7/7, gpu_runtime_probe 9/9; `git diff --check` and whitespace checks for all nine new G5 files passed. Git emitted only expected LF-to-CRLF warnings. The existing explicit mock-only class command also passed 77 tests with one symlink skip. No unrestricted Python discovery or conditional real-asset tests ran.
- G5 edit boundary: src/setup-gpu.ts, src/gpu-runtime.ts, src/setup.ts, src/narration-runtime.ts, src/kokoro-engine.ts, src/config.ts, src/cli.ts; scripts/runtime_device.py, scripts/gpu_runtime_probe.py; tools/qualify_gpu.py; resources/runtime-cuda13-windows.json; test/setup-gpu.test.ts, test/gpu-runtime.test.ts, test/config.test.ts, test/cli.test.ts, test/kokoro-engine.test.ts; test/python/test_runtime_device.py, test/python/test_gpu_runtime_probe.py, test/python/test_qualify_gpu.py; README.md; this document. Removing G5 must preserve the earlier uncommitted selector/status additions in shared files.
- Size exceeds the advisory 400-line budget: the nine new G5 files alone initially measured 1,181 added lines before the final evidence-aggregation refinement, plus targeted integration/tests/docs. Tests and safety boundaries were not compressed to meet a line target. No commit or split is proposed/authorized now.
- Skill resolution: loaded the requested work-unit-commits/context7 config skills and cognitive-doc-design .agents skill. Consulted current Context7 ORT preload/profiling and pip isolation/hash documentation; installed package source and anonymous public metadata were authoritative for exact API/closure checks. Used the explicitly approved CodeGraph source fallback; no index operation or memory search. RDD remains off clone-local.
- Next actor: independently inspect source/tests first, then follow the exact PowerShell preflight/provisioning/qualification/activation commands in README under Optional managed CUDA13 profile. Expected external writes are the two new sibling environments and their dependency/qualification/evidence files, installer scratch and fresh qualification output under Temp/opencode, and only runtimeProfile in local Open-Vox config after both successful qualifications. Never rerun setup kokoro or install/migrate Open-Vox for this step.
- Remaining evidence: real pip/bootstrap compatibility, Windows native CUDA13/cuDNN loading, actual SM120 model sessions/node profiles, disk usage, per-utterance native hash-check overhead, latency and listening quality are unverified. G6 must stop on any failed preflight, dependency/native/asset check or qualification and remain on CPU. Full task mirror: Engram project pc, topic odd/model-device-startup/tasks, relative locator odd/tasks/model-device-startup.md.

### G5 correction: independent NOT-READY findings (P1 dlinfo import, P2 scratch confinement)

- P1 (confirmed): `gpu_runtime_probe.py` imported every non-null lock module, including `dlinfo` 2.0.0. On non-Darwin it selects the glibc backend (libdl), which crashes on Windows; the installed phonemizer espeak API deliberately never imports it there. Fix: explicit narrow policy `eager_import_applicable(wheel, platform)` returns False only for platform `win32` with name and module both `dlinfo`. `dlinfo` still gets its distribution/version pin, closure requirement, module-origin and file checks, and its pin is rechecked after the other imports. Lock mapping, seal and hash fixtures are unchanged.
- P2 (confirmed): `qualify_gpu.py` set only offline variables. phonemizer's espeak API calls `tempfile.mkdtemp`, which uses `tempfile.tempdir` independently of TEMP/TMP, so scratch could leave `--out`. Fix: `validated_output_path` (absolute, no `..`, no symlink/junction through `safe_path`, strictly inside LOCALAPPDATA\Temp\opencode and not the root) and `qualification_tempdir(out)` set TEMP/TMP and `tempfile.tempdir` to the new `--out` directory. The scope is entered in `run` before `inspect_environment` (the first third-party imports) and before model work. Prior TEMP/TMP values (including absent keys) and the tempfile cache are restored on success and failure, so the parent shell is never mutated. Rejected paths fail before any imports or environment change.
- Tests: `test_gpu_runtime_probe.py` gains the policy matrix plus real `inspect_environment` regressions (dlinfo not imported on Windows, pin and origin mandatory, pin rechecked after other imports). `test_qualify_gpu.py` gains restoration, redirected/traversal/outside-root rejection, and a run-level test asserting TEMP, TMP, `gettempdir()` and a real default `mkdtemp()` land in `--out` at both the dependency-import and model-import phases.
- RED (reproduced by temporarily reverting each fix, then restoring byte-identical, confirmed with `fc /b` against backups): P1 reverted gives `test_eager_import_exception_is_only_windows_dlinfo` FAIL (`True is not false`); P2 reverted (no-op scope) gives 3 failures in `test_qualify_gpu` (for example `'...\Temp' != '...\Temp\opencode\tmp...'`). Honest note: the fixes and tests were already present in the working tree when this correction session began, so RED is a mutation reproduction rather than a pre-fix run.
- GREEN: `bun test` 719 pass, 5 skip, 0 fail (724 tests, 26 files, 2890 assertions); `bun run typecheck` clean; `test_gpu_runtime_probe.py` 13/13; `test_qualify_gpu.py` 10/10; `test_runtime_device.py` 14/14; `git diff --check` exit 0 (only LF-to-CRLF warnings). No unrestricted Python discovery. Python baseline counts changed because new tests were added (9 to 13, 7 to 10).
- G6 command change: README qualification commands already pass a fresh `--out` under Temp/opencode; that directory is now also the child-only TEMP/TMP/tempfile scratch. Do not set parent TEMP/TMP. Leftover phonemizer scratch will be inside the `--out` directory.
- Not done in this correction: no installs, downloads, model loads, inference, activation, audio, staging, commits, branches or delegation. Python caches and all unrelated changes preserved.
- Remaining native-proof gaps: real Windows import behavior of the full locked closure without dlinfo (phonemizer espeak path), real CUDA13/cuDNN loading, SM120 sessions and node profiles, pip/bootstrap behavior, disk and latency, listening quality. `tempfile.tempdir` and env confinement cannot cover native code that calls Win32 GetTempPath after process start with a different source; ORT/espeak native temp use is unverified. G6 must stop on any failure and stay CPU.

### G6: Real CUDA13 provisioning, qualification and activation (executed)
- `setup gpu` exit 0 created pn-onnx-gpu-venv (1.82 GB) and kokoro-gpu-venv (1.79 GB) (wheel transfer ~2.64 GB locked). LID/planned qualification exit 0 (qualified true; 1224 CUDA compute nodes vs 246 CPU for LID, 3758 vs 364 for Kokoro; CPU sanity true) and direct Kokoro qualification exit 0 (qualified true; 3758 CUDA vs 364 CPU; two WAVs finite, nonempty, 1.71 s and 2.03 s at 24 kHz). doctor, config show (narrationBackend onnx) passed; `runtime-profile cuda13` exit 0, doctor reports qualified-cuda13 requested cuda13.
- CPU envs untouched (pn-onnx-venv providers still Azure+CPU); git status unchanged vs before. ORT emitted benign Memcpy/ScatterND warnings on stderr. Output kept under Temp/opencode (open-vox-cuda13-*).
- Rollback: `bun .\src\cli.ts runtime-profile cpu`.
- Unverified: live OpenCode session, audible output/listening quality, latency, numerical CPU-vs-GPU parity.