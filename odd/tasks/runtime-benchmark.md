# CPU vs GPU runtime benchmark

## Objective

Measure how the narration pipeline performs on CPU and on GPU so we can decide with data whether the GPU profile is worth keeping: input size, time per pipeline step, total time per utterance, and derived ratios.

## Problem and context

The plugin launches a fresh Python worker for every utterance, so every utterance pays process start-up, DLL preload, model loading and session creation before any inference. For short texts that fixed cost may dominate and hide any GPU benefit; for long texts inference may dominate. A fair comparison therefore has to separate fixed cost from per-text cost and report cold (per-utterance, what the user experiences) and warm (steady-state inference) numbers separately.

Hardware: AMD Ryzen 7 9800X3D (8 cores / 16 threads), NVIDIA GeForce RTX 5070 Ti (16 GB), driver 610.88. CPU profile uses pn-onnx-venv and kokoro-venv (ONNX Runtime 1.31 CPU). GPU profile uses pn-onnx-gpu-venv and kokoro-gpu-venv (ONNX Runtime GPU 1.31, CUDA 13, cuDNN 9.14).

## Scope and constraints

- Read-only measurement of existing environments and assets. No installs, downloads, package changes, runtimeProfile or other persistent config changes, global Python/driver changes, commits or pushes.
- The benchmark must select the interpreter explicitly per run. It must never toggle the user's active profile.
- Real local inference is authorized. Audio is written to temporary WAV files under the approved scratch directory and is never played. Delete or keep only bounded artifacts there.
- Synthetic text only. Never read or record user conversation content.
- Report only safe aggregate data: counts, sizes, durations, provider names, hardware facts. No input text in reports.
- Production code paths stay unchanged unless a defect is found; if one is found, report it instead of silently changing behavior.
- Deliver measurements honestly: state variance, sample size and thermal/load caveats. Do not claim audio quality or numerical parity.
- The B1 measurement-correction pass is tools/mocks only: no real inference, audio, delegation, staging, branch changes or commits. Real B2 execution belongs to a separate runner.

## Measurements

Per run record:

- Input: language, characters, words, plan blocks, narration characters after planning, resulting audio duration and sample count.
- Steps, each as wall time in milliseconds:
  1. Python interpreter start-up to first line of the worker.
  2. GPU DLL preload and capability probe (GPU only; record CPU probe cost too).
  3. Plan load and validation.
  4. Language detector (LID) model and tokenizer load, including session creation.
  5. LID inference and plan resolution.
  6. Kokoro model and voices load, including session creation.
  7. Phonemization.
  8. Kokoro inference (synthesis).
  9. Waveform assembly and WAV write.
  10. Total worker wall time, measured by the parent from spawn to exit, and the engine-level end-to-end time through the real TypeScript engine.
- Derived: real-time factor (processing seconds per audio second), fixed overhead versus per-character cost, GPU speed-up per step and in total, cold versus warm.
- Process peak memory is UNAVAILABLE (`venv_launcher_not_inference_process`); the Windows launcher handle does not measure inference memory. Ignore legacy numeric peaks. GPU before/after queries are coarse global memory deltas, not workload peaks.
- Keep actual both-model CPU/CUDA device codes for every successful job and every warm iteration. Missing, ambiguous or mismatched evidence invalidates the job and excludes all its timings from comparisons. Registered CUDA + CPU providers do not establish all-node CUDA usage.
- Report instrumented cold wall, unmodified Python production-worker wall, real TypeScript engine synthesis pipeline, and engine parent wall separately. Engine runs call the real default engine with in-memory injected ONNX/profile/voice/speed settings and the same shared plan, never a disk config change or playback. The pipeline timer excludes Bun import and shared planner time; it is not whole-UI latency.
- Cold exclusive steps plus signed `untimed_worker` and `unattributed` reconcile parent wall per run. Totals overlap steps; per-step medians need not sum to the median total. Negative residuals are visible, not clamped away.

Input matrix: Spanish and English, at roughly 40, 120, 300, 700 and 1500 characters, plus one markdown-heavy sample. Include accented text so the stdin path is exercised.

Statistics: discard documented warm-up runs for warm figures, but keep the first-ever GPU run as a separate cold-start figure. At least 5 measured repetitions per cell for cold (per-process) runs and at least 10 for warm in-process runs; report min, median, mean, p95 and standard deviation. Interleave CPU and GPU runs so drift affects both equally.

## Authorized edit surfaces

- tools/bench_runtime.py (new)
- tools/bench_report.py (new)
- test/python/test_bench_runtime.py (new)
- test/python/test_bench_report.py (new)
- README.md (short section)
- odd/tasks/runtime-benchmark.md (new)

## Tasks

- [x] B1: Build the benchmark tool with per-step timing for both profiles, safe aggregation and a report generator (JSON plus Markdown tables), with mock-based tests. Reopened after smoke inspection, then corrected and reverified on 2026-10-17 for memory attribution, per-run device evidence, production/real-engine comparisons and worker residual accounting.
  - Route: delegated direct writer; reuse the production modules' own functions so the measured steps match what the worker does.
  - Acceptance: explicit interpreter selection; no persistent config change; no input text in reports; step timings sum plausibly to the measured total; cold and warm kept separate; results reproducible from the stored raw JSON.
- [x] B2: Execute the benchmark on this machine, store raw results and a generated report under the scratch directory, and summarize. Completed and validated on 2026-10-17; full evidence below.
  - Route: separate bounded execution worker after B1 review. Forecast: several minutes of CPU and GPU load; the user should not trigger narration meanwhile.
- [x] B3: Interpret the results: where time goes, when GPU wins or loses, and a recommendation (keep GPU, keep CPU, or choose by text length) with caveats.
  - Route: parent synthesis.

## Verification

Mock-based tests for the tool (timer plumbing, aggregation, report rendering, refusal to persist text). Run:

```text
python -B -m unittest discover -s test/python -p test_bench_runtime.py
python -B -m unittest discover -s test/python -p test_bench_report.py
bun test
bun run typecheck
git diff --check
```

No unrestricted Python discovery.

## Progress and delivery

- B1 done (2026-10-17, single bounded writer, mocks only, real benchmark NOT run). Files: tools/bench_runtime.py,
  tools/bench_report.py, test/python/test_bench_runtime.py (34 tests), test/python/test_bench_report.py (19 tests), README short section.
- B1 checks: both Python suites OK (RED first: ModuleNotFoundError before the modules existed); bun test 719 pass, 5 skip, 0 fail;
  bun run typecheck exit 0; git diff --check exit 0. Safe smokes only: `--preflight` all OK, `--dry-run` printed 11 samples and
  commands and created nothing, bun plan builder returned a complete plan, ProductionSeams.import_modules imports in the CPU venv.
- Design facts for B2: per-step timing wraps the same production functions (kokoro_say.build_detector/load_kokoro, narration_resolver.resolve_plan,
  narration_synthesis.load_plan/raw_phonemizer/synthesize_envelope). LID load is split from inference by calling OnnxDetector._load() (the call detect() makes first).
  Phonemize, Kokoro inference and WAV write are separated by wrapping the phonemize callable, kokoro.create and soundfile.write inside synthesize_envelope; the rest is `synthesis_overhead`.
  `untimed_worker` covers worker setup and other untimed work before the worker elapsed anchor ends. `unattributed` covers remaining parent-wall work, including diagnostics/environment collection, process exit/teardown and runpy overhead. GPU memory per cold run and inference-process peak memory are not measured.
- Delivery strategy ask-on-risk; no commit or push is requested for this work. RDD is off for this clone.
- Prior GPU work (G1 to G6 plus the UTF-8 launch fix) remains uncommitted after snapshot 2e1f29c.
- Next: B2 (review B1 first).
- B2 smoke completed in bench-smoke-20261017 under approved scratch: 14 successful records, zero failed; CPU/GPU cold and warm paths work. Single cold sample is not statistical evidence.
- Before full B2, correct measurement defects within the existing benchmark-only edit surfaces: do not report the Windows launcher working set as inference memory; retain per-run device evidence including warm/production runs; include Python production-wall comparisons; add the specified actual TypeScript engine end-to-end comparison. Reconcile exclusive step totals with an explicit worker residual. Production plugin/models/config remain unchanged.
- Recovery mirror: odd/benchmark-runtime/tasks in Engram project pc.

## Interpretation and recommendation

- Parent spot-checked the generated report against the returned tables. The full study completed 266 successful jobs in 2079.52 seconds; zero failures or device mismatches. Eleven cells used five measured fresh-process repetitions and ten warm iterations per profile; separate production and TypeScript engine comparisons used three repetitions, not the report boilerplate's default of one.
- With the current fresh-worker-per-utterance implementation, CPU won nine of eleven cells. GPU won only the two largest prose samples: Spanish 1459 characters (10.493 s CPU versus 7.867 s GPU) and English 1467 characters (11.694 s versus 8.257 s). The exact crossover was not measured; a linear fit is not a routing threshold.
- The current GPU preparation/probe stage costs approximately 2.65 seconds per process. LID loading costs approximately 1.0 seconds and Kokoro loading approximately 0.6–0.7 seconds on either profile. GPU accelerates substantial Kokoro synthesis, but this fixed preparation cost dominates short utterances. These are implementation-specific observations, not a general limitation of GPUs.
- With models already loaded, GPU won every cell by approximately 2.42–3.40x. This is evidence for exploring a persistent worker, not a claim that the current plugin already obtains warm latency. Loaded-model reuse would require separate design, cancellation/isolation checks and implementation authorization.
- Recommendation for the current implementation: prefer CPU for short/medium narration on this machine; GPU helps long responses. Do not implement an automatic character threshold from this sparse matrix. The next useful optimization study would isolate GPU preparation overhead and/or evaluate safe persistent model reuse. No runtime profile or production behavior was changed during this study; the user's active cuda13 profile remains unchanged.
- Results describe synthetic English/Spanish text and these assets/voices on Ryzen 7 9800X3D / RTX 5070 Ti. They do not certify listening quality, numerical equivalence, whole-UI latency, thermal control, all-node GPU placement or performance on other hardware. Small sample counts limit tail estimates. Retained WAVs consume approximately 382 MB and were not played.
- Report artifacts: results.json, report.md and report.csv under the approved scratch directory bench-full-20261017-v2. Per-step tables and raw records allow reproduction; report JSON/CSV/Markdown do not contain the input sentences.
- B1 correction proof: initial regression RED was 2 runtime assertion failures + 3 runtime errors (43 tests including 4 temporary inherited duplicates), and 3 report assertion failures (22 tests). Final suites: 45 runtime tests, 23 report tests, all PASS. Duplicate inherited tests were removed; final counts are unique tests.
- Exact final checks passed: both Python commands above; `bun test` (719 pass, 5 skip, 0 fail, 15.12 seconds); `bun run typecheck` (exit 0); `git diff --check` (exit 0, existing LF/CRLF conversion warnings only). Source patches use English artifacts and normalized LF lines. HEAD remains 2e1f29c; existing GPU work/caches were not edited or removed, nothing staged or committed, RDD remains off.
- Engine proof is mock-only: Bun executed the inline script against in-memory mock modules, verified injected settings/deep copies, stdin plan, synthesis-only handle/devices and error suppression. Real engine/model behavior remains B2 work. New optional schema-1 fields retain compatibility; legacy missing device evidence is explicitly excluded and legacy numeric memory is ignored.
- Fresh runner commands (PowerShell from repository root; NOT executed here, only dry-run planning):

  ```powershell
  $smoke = "$env:LOCALAPPDATA\Temp\opencode\bench-smoke-20261017-v2"
  python -B tools/bench_runtime.py --out $smoke --sizes 120 --langs es --cold-reps 1 --warm-reps 2 --warmup 1 --prod-reps 1 --engine-reps 1
  python -B tools/bench_report.py --raw "$smoke\results.json" --md "$smoke\report.md" --csv "$smoke\report.csv"
  $full = "$env:LOCALAPPDATA\Temp\opencode\bench-full-20261017-v2"
  python -B tools/bench_runtime.py --out $full
  python -B tools/bench_report.py --raw "$full\results.json" --md "$full\report.md" --csv "$full\report.csv"
  ```

- Verified dry-run counts: smoke 18 jobs (6 cold including 2 first-ever, 4 production, 4 engine, 4 warm workers with 4 iterations each); full 178 jobs (112 cold including 2 first-ever, 22 production, 22 engine, 22 warm workers with 13 iterations each). Dry runs created no output directories. Assumption-based forecast: about 5 minutes smoke / 59 minutes full, not measured durations. `--engine-reps` and `--prod-reps` default to 1 (preliminary), cold to 5, warm timed iterations to 10.
- Skill resolution: loaded the requested work-unit-commits and cognitive-doc-design files; the explicit no-commit/no-branch instruction overrides skill commit guidance. Authorized CodeGraph source fallback used; no index initialization or memory searches. Rollback boundary is only the benchmark tool/test/documentation additions, never existing GPU production work.
- B2 and B3 remain pending; review the corrected B1 tool before separate execution.

### B2 execution attempt: stopped before preflight (2026-10-17)

- Status: blocked at step 0; B2 and B3 remain pending. No benchmark, inference, report generation or retries were started, and there are no new study results.
- Initial read-only snapshot: HEAD `2e1f29c0897f7b5c20f06b85b6f8eaf2ef2c3188`; existing modified/untracked GPU, benchmark and cache files were present and preserved. Approved scratch parent exists; free space was 1,302,490,558,464 bytes; both requested `-v2` output directories were absent. The process query returned no Python/Bun benchmark processes.
- Failure class: runner environment / safety-baseline command. The initial foreground PowerShell snapshot failed because `Get-FileHash` was unavailable (`CommandNotFoundException`). The proposed config hash was not obtained; the config path was not verified. This is not evidence of a benchmark-tool or model failure. Exact command elapsed time and a native exit code were not supplied by the terminal tool.
- Applied the explicit stop-on-first-failure rule: did not run `python -B tools/bench_runtime.py --preflight`, the corrected smoke, the full matrix or either report command. No partial benchmark artifacts exist from this attempt. No measured performance or device claims can be made.
- No source, tests, production code, profiles or configuration were edited. Only this task evidence was appended; no staging, commits, branches, remote operations, installations, downloads, playback or child agents were used. Configuration byte identity could not be established because the initial hash failed.
- Resume requires a fresh authorized attempt with a supported read-only config fingerprint mechanism and the actual config location verified before preflight; recheck process state, free space and output-path absence. Do not treat the obsolete first smoke as corrected evidence.
- skill_resolution: loaded `work-unit-commits` and `cognitive-doc-design`; explicit no-commit/no-branch and stop-on-first-failure instructions take precedence. RDD remains off.

## Key Learnings

1. This runner's PowerShell environment did not provide `Get-FileHash`; do not assume that cmdlet is available for the configuration safety baseline.
2. The corrected smoke and full matrix have not executed in this attempt. The failure is a runner precondition failure, not a measured CPU/GPU result.

### B2 authorized retry: real smoke completed, full gate blocked (2026-10-17)

- The user explicitly authorized retrying the preparatory baseline. The earlier preparatory failure is not a failed inference. Actual config `C:\Users\pc\AppData\Local\open-vox\config.json` was read before and after: identical content, `runtimeProfile=cuda13`, `narrationBackend=onnx`. No hashing dependency was added. Both output paths were freshly absent and no active Python/Bun benchmark process was found.
- Commands executed sequentially in the foreground from the repository root, with 600000 ms timeouts:
  ```text
  python -B tools/bench_runtime.py --preflight
  python -B tools/bench_runtime.py --out C:\Users\pc\AppData\Local\Temp\opencode\bench-smoke-20261017-v2 --sizes 120 --langs es --cold-reps 1 --warm-reps 2 --warmup 1 --prod-reps 1 --engine-reps 1
  python -B tools/bench_report.py --raw C:\Users\pc\AppData\Local\Temp\opencode\bench-smoke-20261017-v2/results.json --md C:\Users\pc\AppData\Local\Temp\opencode\bench-smoke-20261017-v2/report.md --csv C:\Users\pc\AppData\Local\Temp\opencode\bench-smoke-20261017-v2/report.csv
  ```
- Preflight passed all required checks. Smoke raw `complete=true`, 18 successful jobs, zero failures, zero excluded/device-invalid jobs; both LID and Kokoro device evidence matched the selected CPU/CUDA profile for all jobs and all 16 warm iterations. Cold n=1 per profile/cell (plus separate study-first run), warm n=2 after first inference plus one warm-up; production and engine n=1, preliminary. Commands returned normally; the terminal interface did not expose numeric command exit codes or exact top-level phase elapsed. Printed child-wall times sum to 108.293 seconds, not the top-level smoke elapsed.
- Safe artifacts are `results.json`, `report.md`, `report.csv` in approved scratch `bench-smoke-20261017-v2`. Report tables include production worker, real TypeScript engine pipeline and engine parent wall. The report contains counts/provider evidence/timings, not synthetic sentences. WAV and plan directories were inspected and are empty after default cleanup.

| Smoke sample | Actual chars / words | Audio seconds (instrumented) | Cold CPU / GPU ms | Warm CPU / GPU ms | Production CPU / GPU ms | Engine pipeline CPU / GPU ms | Engine parent CPU / GPU ms |
|---|---|---|---|---|---|---|---|
| es-120 | 110 / 18 | 5.8453 | 2703 / 5247 | 593 / 186 | 2720 / 5254 | 2726 / 5284 | 2775 / 5334 |
| markdown-es | 683 / 112 | 34.7480 | 5866 / 6682 | 3677 / 1532 | 5761 / 6645 | 5755 / 6696 | 5808 / 6747 |

- Instrumented audio counts were 140288 and 833952 samples at 24000 Hz, respectively. Cold GPU DLL preload/probe cost 2640/2660 ms; LID load CPU/GPU 1009/1044 and 1013/1067 ms; Kokoro load 620/684 and 627/693 ms. Cold Kokoro inference CPU/GPU 573/353 and 3595/1646 ms. Cold RTF CPU/GPU 0.462/0.898 and 0.169/0.192; warm RTF 0.102/0.032 and 0.106/0.044. These are smoke observations, not full-matrix conclusions.
- STOP at mandatory smoke validation: nonempty WAV byte sizes/audio counts for the real engine jobs cannot be established from retained artifacts. `tools/bench_runtime.py` lines 48-69 emit only engine pipeline time, devices and diagnostics after exit success; lines 769-783 retain no engine/production audio size or duration, and lines 802-806 delete WAV/metrics. This is missing validation evidence, not an observed empty WAV, device mismatch or nonzero inference exit. Successful exit alone must not be presented as measured nonempty engine WAV size.
- Full matrix/report commands were NOT launched; `bench-full-20261017-v2` remains absent. No inference reruns, source fixes or tests were performed. B2 remains unchecked because the complete validated study is not available; B3 remains pending for the parent. Preserve this smoke without overwriting it.
- Final git status paths match the initial snapshot and HEAD remains `2e1f29c0897f7b5c20f06b85b6f8eaf2ef2c3188`; only this authorized task evidence was appended. No source/config/package/profile mutation, playback, install, staging, commit, branch, remote operation, child agent or native review. RDD remains off.
- Caveats: process peak RAM unavailable; GPU before/after deltas are coarse global values, not peaks or load sampling. Thermal/background load and page cache uncontrolled. Study-first runs are not machine-cold boots. Provider evidence is not all-node placement or audio-quality parity. Engine timings are tested synthesis-pipeline timings, not whole-UI latency.
- skill_resolution: reused loaded `work-unit-commits` and `cognitive-doc-design`; no-commit/no-source-edit instructions prevail. No CodeGraph index exists; targeted source reads were used only to investigate missing retained WAV evidence, with no index initialization or code changes.

### Key Learnings from the authorized retry

1. The actual config is under LocalAppData/open-vox, and dedicated before/after reads establish unchanged content without requiring an unavailable hashing cmdlet.
2. Corrected real smoke selected CPU/CUDA for both models and produced positive instrumented audio samples; GPU inference was faster, but GPU cold wall was slower for both smoke samples.
3. The harness discards engine/production WAV-size evidence before the required post-smoke check. Do not launch the full matrix or claim nonempty engine WAV validation from successful exit alone.

### B2 complete: full retained-artifact study (2026-10-17)

- Parent explicitly accepted all 18 successful smoke jobs and resolved the retention-only gate; authorized FULL ONLY with `--keep` and production/engine repetitions increased to 3. No smoke was repeated and no tools were edited.
- Exact foreground command, timeout 5400000 ms:
  ```text
  python -B tools/bench_runtime.py --out C:\Users\pc\AppData\Local\Temp\opencode\bench-full-20261017-v2 --langs es,en --sizes 40,120,300,700,1500 --cold-reps 5 --warm-reps 10 --warmup 2 --prod-reps 3 --engine-reps 3 --keep
  ```
- Immediately captured `$LASTEXITCODE=0`; Stopwatch elapsed 2079.5184634 seconds (34 minutes 39.5 seconds). One foreground run only; no detach, background jobs, polling, sleep or retries.
- Exact report command, timeout 600000 ms:
  ```text
  python -B tools/bench_report.py --raw C:\Users\pc\AppData\Local\Temp\opencode\bench-full-20261017-v2/results.json --md C:\Users\pc\AppData\Local\Temp\opencode\bench-full-20261017-v2/report.md --csv C:\Users\pc\AppData\Local\Temp\opencode\bench-full-20261017-v2/report.csv
  ```
- Immediately captured `$LASTEXITCODE=0`; Stopwatch elapsed 0.1214998 seconds. Raw/report/CSV are retained under approved scratch `bench-full-20261017-v2`; obsolete smoke directories were neither merged nor overwritten.
- Independent read-only diagnostic validation exit 0: `complete=true`, 266 successful records, zero failures/exclusions/device-invalid jobs. Modes: 112 cold (110 measured plus 2 study-first), 66 production, 66 real TypeScript engine, 22 warm workers. Every cell/profile has cold n=5, warm n=10 timed (plus first inference and 2 warm-ups), production n=3 and engine n=3. All 286 warm iterations, including 220 timed iterations, have matching both-model CPU/CUDA evidence. Finite nonnegative exclusive timings, positive parent walls, signed residuals preserved.
- Every record mapped to its retained `kind-profile-sample-rep.wav`. All 266 WAVs, including all 132 production/engine runs, parsed successfully using standard-library `wave`: positive frames, mono PCM16 at 24000 Hz, complete frame bytes and file size greater than header. Instrumented WAV frame counts/durations match raw metrics. No playback. No waveform-quality or numerical-parity test was performed. Retained files total 383366846 bytes (WAV files 382301112 bytes); no cleanup/deletion was performed. Synthetic plans remain private scratch artifacts, not report content.
- Privacy validation: raw forbidden-field check passed; raw JSON/Markdown/CSV contain zero matches for generated complete synthetic texts or source sentences. No synthetic input was printed in diagnostics. Config before/after dedicated reads match exactly: `runtimeProfile=cuda13`, `narrationBackend=onnx`. Final git status paths match the baseline and HEAD remains `2e1f29c0897f7b5c20f06b85b6f8eaf2ef2c3188`; only this task document was edited by the runner.

All paired values below are CPU / GPU; timing units are milliseconds. Cold median/p95 n=5, warm median n=10, production and real-engine pipeline median n=3 (still preliminary). Audio duration is the median across mapped retained files. Cold p95 uses linear percentile interpolation.

| Cell | Actual chars / words | Audio s | Cold median | Cold p95 | CPU/GPU speed-up | Warm median | Production wall | Engine pipeline |
|---|---|---|---|---|---|---|---|---|
| es-40 | 40 / 6 | 2.1547 | 2382 / 5176 | 2395 / 5208 | 0.46x | 254 / 86 | 2394 / 5194 | 2372 / 5225 |
| es-120 | 110 / 18 | 5.8453 | 2750 / 5284 | 2780 / 5297 | 0.52x | 607 / 185 | 2737 / 5298 | 2748 / 5285 |
| es-300 | 264 / 42 | 13.9187 | 3614 / 5539 | 3642 / 5578 | 0.65x | 1449 / 466 | 3548 / 5552 | 3553 / 5570 |
| es-700 | 683 / 109 | 37.8400 | 6028 / 6409 | 6092 / 6422 | 0.94x | 3801 / 1256 | 5934 / 6368 | 6014 / 6428 |
| es-1500 | 1459 / 235 | 80.1693 | 10493 / 7867 | 10532 / 7990 | 1.33x | 8327 / 2705 | 10313 / 7864 | 10271 / 7930 |
| en-40 | 38 / 6 | 2.1120 | 2409 / 5180 | 2426 / 5226 | 0.47x | 277 / 91 | 2383 / 5215 | 2393 / 5213 |
| en-120 | 116 / 22 | 7.1253 | 2884 / 5311 | 2897 / 5332 | 0.54x | 773 / 227 | 2862 / 5332 | 2891 / 5331 |
| en-300 | 291 / 48 | 17.6307 | 4002 / 5620 | 4015 / 5679 | 0.71x | 1822 / 576 | 3920 / 5654 | 3947 / 5640 |
| en-700 | 674 / 113 | 40.6133 | 6472 / 6531 | 6544 / 6548 | 0.99x | 4148 / 1347 | 6402 / 6514 | 6453 / 6541 |
| en-1500 | 1467 / 247 | 89.2147 | 11694 / 8257 | 11778 / 8305 | 1.42x | 9190 / 2996 | 11521 / 8253 | 11558 / 8244 |
| markdown-es | 683 / 112 | 34.7480 | 5836 / 6659 | 5882 / 6710 | 0.88x | 3670 / 1515 | 5844 / 6680 | 5862 / 6639 |

- Observed GPU cold wins: 2/11 cells, both largest prose samples; CPU remained faster at the measured 674/683-character prose cells. Exact crossover was not measured. Report linear-fit crossover around 718 narration characters is illustrative, not an observed threshold or recommendation. GPU warm median wins all 11 cells, 2.42x to 3.40x.
- Representative cold step medians CPU/GPU for es-120, es-300, es-1500: DLL preload/probe approximately 0/2653, 0/2642, 0/2650; LID load 1015/1051, 1012/1058, 1008/1059; LID inference/resolution 16/113, 35/121, 242/224; Kokoro load 630/683, 631/691, 620/678; Kokoro inference 611/355, 1423/605, 7959/2681 ms. GPU fixed startup dominates short cold work; CPU Kokoro inference dominates long work. Full per-step tables and engine parent walls are in report.md.
- RTF es-120/es-300/es-1500 cold CPU/GPU: 0.471/0.904, 0.260/0.398, 0.131/0.098; warm: 0.104/0.032, 0.104/0.033, 0.104/0.034. Median unattributed gap 3.3%, p95 4.1% (110 measured cold runs); maximum exclusive-step reconciliation error 1.82e-12 ms, signed untimed-worker range 4.00 to 47.53 ms.
- Caveats: one machine/session, Ryzen 7 9800X3D and RTX 5070 Ti (driver 610.88); no controlled thermal/background-load or page-cache baseline. No hardware load time series; GPU memory deltas are coarse global observations, peak RAM unavailable. Cold n=5, warm n=10 within one worker/profile/cell and production/engine n=3 limit tail/generalization claims. Study-first is not machine-cold boot. Registered CUDA plus CPU providers do not establish all-node GPU placement. No sound-quality parity or whole-UI latency claim. Report boilerplate mentions default n=1; actual production/engine table counts are n=3.
- B2 is complete and validated; B3 remains pending for parent interpretation. No source/tests/config/packages/profiles were edited, no source tests/research/smokes repeated, no installs/downloads/playback/children/staging/commits/branches/remotes/native review. RDD remains off. skill_resolution: reused loaded `work-unit-commits` and `cognitive-doc-design`; explicit execution-only and no-commit constraints prevail.

### Key Learnings from the full study

1. Retaining exact full-run WAVs closes the smoke evidence-retention limitation without changing production code or replaying the smoke.
2. GPU inference gains do not imply lower per-utterance latency: roughly 2.65 seconds of GPU preload/probe overhead reverses the short-text cold result.
3. Only the largest measured prose cells demonstrated a cold GPU win; warm results assume reusable loaded models, unlike the current fresh-worker-per-utterance production path.
