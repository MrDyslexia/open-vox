# Local Kokoro voice lab

Status: VL-01 through VL-04 implemented; deterministic checks and independent real-model synthesis passed; VL-05 browser interaction remains unverified. Display project: Open-Vox; canonical memory project: `agentvoz`.

## Outcome and boundaries

A standalone local web laboratory for comparing Kokoro styles on a short Spanish sentence. It does not integrate with the plugin, change installed configuration, modify model/voice assets, clone reference audio, or upload text/audio. Existing uncommitted tone-blend work must be preserved.

The model synthesizes a new sample on each explicit Generate action. Sliders do not alter an already-playing waveform. No claim of perceptual resemblance is made from acoustic statistics.

## Work units

- [x] VL-01 — Implement loopback-only Python backend using the existing Kokoro ONNX environment and model assets; load the model once, serialize inference, validate and bound every request, return WAV bytes without writing synthesis files.
- [x] VL-02 — Implement a simple browser panel with sentence, language, base/donor voices, independent timbre/prosody blend weights, speed, Generate/play, reset, and preset JSON download/import.
- [x] VL-03 — Provide an explicitly experimental advanced editor for all 256 style components. Use bounded per-component offsets applied along the final tensor axis; identify these as offsets, not semantically labelled voice controls. Reset must restore zero offsets. Keep cached source arrays unchanged.
- [x] VL-04 — Write deterministic stdlib unittest coverage for blend math, shape/dtype preservation, validation, loopback/host/origin boundaries, busy handling and WAV responses. Follow observed RED then GREEN.
- [ ] VL-05 — Verify a real Spanish synthesis, backend HTTP endpoints and browser interaction. Record failures, skips, runtime cost and limitations; do not claim auditory acceptance.

## Authorized edit scope and route

Delegated implementation: `tools/voice-lab/server.py`, `tools/voice-lab/index.html`, `tools/voice-lab/test_server.py`, `tools/voice-lab/README.md`; tracking: this document. New files are authorized only in `tools/voice-lab/` and this exact task locator. Preparation/multi-file writer triggers require one bounded writer; verification uses a fresh read-only worker.

## Checks and constraints

- Original boundary: no additional dependencies/framework installation. **Scoped authorized exception:** `odd/tasks/voice-lab-comparator.md` permits optional packages only in ignored `tools/voice-lab/.venv-comparator/`, and one verified public checkpoint only in `.models/`. Root manifests/locks, plugin environments/source, live settings, commits and publishing remain prohibited. Historical verification below refers to the original synthesis-only work.
- Bind only `127.0.0.1`; no configurable public bind, CORS wildcard, remote assets, arbitrary filesystem routes or model paths from browser requests.
- Reject foreign hosts/origins, oversized input, invalid donors, nonfinite/out-of-range numbers and malformed preset data. One inference at a time; no unbounded job queue.
- Independent timbre/prosody blend weights operate on separate style halves, but their audible effects need not be physically independent.
- `python -B -m unittest discover -s tools/voice-lab -p test_server.py` using the installed Kokoro venv; existing full Bun and Python regressions must remain green.
- Foreground verification may launch a tracked loopback test server and stop only its own process. Browser playback policy may require an explicit user click.

## Progress and delivery

Initial authored-line estimate: several hundred including UI, safety tests and docs; the approximately 400-line heuristic is not a hard limit and does not justify omitting tests. Route is standalone delegated direct, not SDD. No commit, PR or publish is authorized by this task.

Engram mirror `odd/voice-lab/tasks`: pending due to existing MCP project ambiguity. Local document is authoritative; never use either status-provider project as a substitute.

Next: launch the lab from a user-owned terminal and verify browser controls and listening. VL-02/VL-03 checkboxes record implementation, not observed browser or auditory acceptance.

## Observed writer verification

The task document and the three required skills were read before the first source write. `skill_resolution: paths-injected`:

- `<skills-root>/work-unit-commits/SKILL.md`
- `<skills-root>/cognitive-doc-design/SKILL.md`
- `<skills-root>/context7/SKILL.md`

Route: standalone delegated direct, not SDD. No staging, commits, branches, configuration updates, installs or publishing. Existing dirty plugin/tone/test files and preexisting caches were outside the writer's edit scope. The advisory size heuristic did not reduce coverage or force code minification.

Observed commands from `<project-root>`:

| Check | Result |
| --- | --- |
| Installed venv `python.exe -B -m unittest discover -s tools/voice-lab -p test_server.py` before backend creation | RED: one import error, missing `server.py`; process exit 1 |
| Same focused command after initial implementation | GREEN: 19 tests, 3.286 s, exit 0 |
| Same focused command after additional boundary/concurrency tests | GREEN: 22 tests, 4.320 s, exit 0 |
| Installed venv `python.exe -B -m unittest discover -s test/python -p test_*.py` | 143 tests, 4 skipped, 1.556 s, exit 0 |
| `bun test` | 621 passed, 5 skipped, 0 failed; 626 tests across 23 files, 13.31 s, exit 0 |
| `bun run typecheck` | `tsc --noEmit`, exit 0 |
| `git diff --check` | Exit 0; only existing dirty-file LF/CRLF warnings; this Git command does not inspect untracked new files |

Additional `git diff --no-index --check -- /dev/null <path>` checks covered all five authorized files: no whitespace-error diagnostics; exit 1 for each because the file differs from the empty baseline, plus LF/CRLF warnings. Final `git status --short` retained the same preexisting modified files and cache entries, with the new standalone `tools/` surface added.

The full Python/Bun/typecheck regression sequence ran once. Focused tests used fake model outputs and ephemeral loopback HTTP servers, closed in teardown. They verified both allowed local origins, foreign/missing/wrong-port Host rejection, foreign Origin rejection, duplicate headers and JSON keys, strict routes, oversized/malformed JSON, 429 during active inference, responsive metadata, sanitized inference failure, lazy successful model reuse, all three explicit languages, PCM16 WAV framing, float32 blend/offset math and cached source preservation. No persistent server or actual ONNX inference was launched by the writer.

## Independent launch and remaining acceptance

```powershell
& "<local-kokoro-python>" -B tools/voice-lab/server.py
```

URL: **http://127.0.0.1:8765/**. Optional `--port` changes the port only. Ctrl+C stops the foreground process. Startup loads trusted voice arrays with `allow_pickle=False`, not the model; first Generate loads Kokoro once, warm requests reuse it. Consult `tools/voice-lab/README.md` for the exact request/preset schema and limits.

Independent backend verification: 22 tests passed; actual listener was verified at `127.0.0.1:8765`. Root/index and metadata returned HTTP 200, with 54 voices. Foreign Host/Origin probes returned 403. A 58-character Spanish request using `em_alex`, `am_onyx`, timbre/prosody weights 0.25/0.35 and offset 0 set to 0.01 returned a valid PCM16 mono 24 kHz WAV: 92,672 frames, 3.861333 seconds, finite samples. Initial model loading plus synthesis and HTTP round trip took approximately 1.49 seconds on this host; this is not a latency guarantee. Voicepack SHA256 matched before and after synthesis. No severe candidate-caused backend flaw was found in the inspected scope.

Browser automation navigation and subsequent snapshot each timed out; no interface, preset round-trip, playback or listening acceptance is claimed. A later parent HTTP check found the temporary server was no longer listening. Do not rely on a persistent background launch: run the documented command in a user-owned terminal and keep that terminal open. No service or autostart was installed.

Pending VL-05 evidence: browser layout and advanced control interactions, reset and preset round-trip, audio/download, and autoplay fallback. No perceptual resemblance or auditory quality claim is made. Large experimental offsets may degrade speech. Browser waiting has a 120-second deadline; aborting does not cancel inference, which has no hard model deadline. Loopback defenses do not authenticate other local processes. Engram writes remain blocked by the existing project ambiguity; no unrelated status-provider project was selected. Memory/document mirror remains pending.
