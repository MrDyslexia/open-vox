# Open-Vox

An OpenCode plugin that reads the agent's final answer aloud. Windows-first and
local-only: neural voices run on your machine (Kokoro, then Piper), with the
built-in Windows voices as a fallback. No cloud service and no sherpa-onnx.

## Quick start

```powershell
bun install --ignore-scripts
bun link                      # makes the `open-vox` command available globally
open-vox setup kokoro         # venv + model download (about 340 MB)
open-vox install              # registers the plugin and the sidebar block
open-vox doctor               # checks everything
```

Then restart OpenCode. Requirements: Windows, [Bun](https://bun.sh), and Python 3
(only for `setup kokoro`).

## Terminal commands

Settings live in `%LOCALAPPDATA%\open-vox\config.json` and apply immediately, with
no restart, even while OpenCode is running.

| Command | What it does |
| --- | --- |
| `open-vox install [--no-tui]` | Register the plugin and the sidebar block in OpenCode |
| `open-vox uninstall` | Remove both (settings and downloaded voices are kept) |
| `open-vox setup kokoro\|piper` | Download a local neural voice engine |
| `open-vox setup narration` | Explicitly prepare pinned contextual ES/EN detection in a separate CPU environment |
| `open-vox setup narration-onnx --lid-source <dir>` | Explicitly provision the inactive standalone ONNX FP32 detector from a local model directory (does not activate it) |
| `open-vox doctor` / `status` | Check the installation / show current settings |
| `open-vox voices` | List the voices (`*` marks the current ones) |
| `open-vox voice <id>` | Change the voice, e.g. `voice em_alex`, `voice bm_george` |
| `open-vox tone` / `tone es` / `tone en` | Show both tone settings or the selected language |
| `open-vox tone es am_onyx 0.75` | Set an experimental Kokoro tone donor and weight for Spanish |
| `open-vox tone es off` | Clear the Spanish donor and reset its weight to zero |
| `open-vox speed <0.5-2>` | Speaking speed |
| `open-vox engine auto\|kokoro\|piper\|sapi` | Speech engine |
| `open-vox language es\|en` | Set the narration base language; preserve both voice slots |
| `open-vox say <text>` | Speak a test sentence with the current settings |
| `open-vox config path\|show\|reset` | Inspect or reset the settings file |

Defaults: Spanish `em_alex`, English `af_heart`. Voices whose id starts with `b`
(for example `bm_george`) are British and use British phonemes automatically.

`em_blocktype` is a custom Spanish male voice bundled with open-vox (see
[`resources/voices`](resources/voices/README.md)). `open-vox setup kokoro` adds it to your
voices pack, including on an existing install: re-run the command to receive it, then
`open-vox voice em_blocktype`.

### Model runtime status

Below the sidebar title, `LID: CPU · Kokoro: GPU` shows each model's last confirmed
selected runtime for the displayed session. CUDA is labeled **GPU**; absent,
unused or legacy diagnostics show **Pending**, never an assumed CPU. Direct
Kokoro synthesis does not use LID, so its LID field stays Pending.

The row confirms a successful narration job's registered provider/device, not GPU
utilization, all-node GPU execution, or successful LID inference. A detector can
select a runtime and still fall back after an inference failure. Workers run per
utterance: these labels do not mean models remain loaded. No models or probes run
just to populate the row.

A new synthesis attempt clears the previous snapshot; success replaces both
fields together, including missing values. Failed, cancelled or timed-out work
stays Pending. Stop, session invalidation/deletion, Off, disposal and observed
engine/backend/settings changes clear confirmation and reject stale completion.
Pause never confirms cancelled synthesis; a genuinely frozen cached playback
does not create a new outcome. Repeat preserves confirmation without rerunning
models. Unconfirmed, conflicting or expired sidebar connections show Pending.

### Experimental Kokoro tone blend

Tone is **off by default** for both languages (`toneVoice` is empty and `toneWeight`
is zero). A donor from any voice in `open-vox voices` can interpolate the prosody
half of the style vector without replacing the base voice's timbre half. Weights
must be finite numbers from 0 to 1; each language setting preserves the other.
`config reset` restores both to off. `am_onyx` at `0.75` is a suggested experimental
preset, not an enabled default or a listening-qualified JARVIS voice.

Blend weight is style interpolation; `speed` is a separate synthesis rate control.
They are not physically orthogonal: the blend can also change duration. The
phonemizer language still follows the base voice, not the donor, but this does not
guarantee that the donor embedding leaves perceived accent unchanged.

Tone applies only to **Kokoro planned narration**, including the plugin and `say`.
Piper/SAPI and direct text calls to the low-level Kokoro engine do not blend; the
TypeScript engine emits no tone flags for that direct route. New utterances sample
the persisted settings; Repeat keeps the previously generated WAV. No new tone
environment overrides are provided, and the downloaded voice pack is not modified.

From this checkout, use `bun run src/cli.ts tone` (the package executable maps
`open-vox` to `src/cli.ts`); no global link or plugin reinstall is needed to invoke
the CLI. Setting a donor explicitly changes the persisted profile, so leave it off
until you choose to audition the preset.

## Contextual pronunciation (explicit setup)

Kokoro speech availability and contextual pronunciation readiness are separate.
For full local contextual ES/EN detection, first install Kokoro using the existing
setup command, then explicitly run:

```powershell
open-vox setup narration
open-vox doctor
open-vox language es
```

This operation creates `%LOCALAPPDATA%\open-vox\pn-venv`, installs pinned CPU
dependencies, and downloads **712,465,856 bytes** of model/config/tokenizer assets
(weights: **711,469,178 bytes**, about 711 MB). Allow approximately **2 GB total**
for the model and environment; this is a forecast, not measured combined setup
size, and wheel/cache/Python requirements vary. Torch comes only from PyTorch's
CPU index; other packages come from anonymous PyPI. Python must have compatible
64-bit Windows binary wheels. Combined managed installation/inference has not yet
been validated; the command's dependency probe does not certify model compatibility
or speech quality.

Existing `kokoro-venv`, ONNX model and voices are reused without modification.
Missing Kokoro assets produce an instruction to run `setup kokoro`, not a hidden
large download. Existing engine setup remains unchanged; narration is never
downloaded by ordinary speech, engine setup, or availability checks.

The approved model is `sagorsarker/codeswitch-spaeng-lid-lince`, pinned at
`66d0e899b3fcf70d8727e4521c7a9c3f7a1fa73c`, under
`<app-home>/lid/codeswitch-spaeng-lid-lince/<revision>`. The bundled
[`resources/lid-model.json`](resources/lid-model.json) records the exact file sizes
and SHA256 hashes. Setup verifies each staged file before exclusive publication;
invalid existing files are preserved and reported, never silently overwritten.
Only owned staging files are cleaned. A failed setup has no new readiness record.
For an integrity error, inspect the reported managed directory manually before
retrying; do not uninstall or alter your existing Kokoro environment.

### Standalone ONNX detector (explicit, local source, inactive)

```powershell
open-vox setup narration-onnx --lid-source <reference-assets>
open-vox doctor
```

This separate path provisions the ONNX FP32 export of the same detector without
torch or transformers. `--lid-source` is required: a local directory holding
`model.onnx` (about **709 MB**) and `tokenizer/*`. Nothing is downloaded for the
model; every file is verified by size and sha256 against
[`resources/lid-model-onnx-fp32.json`](resources/lid-model-onnx-fp32.json), staged,
re-verified and published exclusively under `<app-home>\lid-onnx\...`. Only five
pinned packages (`kokoro-onnx`, `onnxruntime`, `soundfile`, `numpy`, `tokenizers`)
are installed from anonymous PyPI, binary wheels only, into
`<app-home>\pn-onnx-venv`. The Torch environment (`pn-venv`), its model directory,
`kokoro-venv` and their markers are never touched. A missing or invalid source
fails with nothing written; the readiness record is written last.

This command does **not** activate the ONNX backend: narration still uses the
Torch detector. `open-vox doctor` shows a separate informational "Contextual
narration (ONNX)" line; an environment that was never provisioned is reported as
`INFO ... not provisioned` and never makes doctor fail.

Selecting the backend is an explicit, separate step:

```powershell
open-vox narration-backend           # show the current backend (default: torch)
open-vox narration-backend onnx      # refused unless the ONNX environment is ready
open-vox narration-backend torch     # always allowed
```

`onnx` is persisted only after the same readiness check `doctor` uses passes;
otherwise the command exits non-zero, changes nothing and points to
`open-vox setup narration-onnx --lid-source <dir>`. When `onnx` is selected, each
narration run uses one matching set: the ONNX interpreter, the ONNX manifest and
the managed ONNX model directory. If the ONNX environment later stops being ready,
speech falls back to the Torch set without failing and a single
`onnx-backend-unavailable` diagnostic is logged. Existing config files without the
setting keep using Torch.

### Pre-load runtime device selection

Each Python worker probes capabilities before loading the decision model or
Kokoro. ONNX uses CUDA only when the worker's runtime advertises CUDA and a
bounded, model-free driver probe finds a CUDA device. Otherwise it explicitly
requests CPU. Torch checks `torch.cuda.is_available()` before loading FP32
weights and places the model and input tensors on the same selected device.
Direct and planned Kokoro calls both receive an explicit file-backed ONNX session;
the library's `ONNX_PROVIDER` environment override does not control selection.

Each model has an independent outcome. A recognized CUDA initialization failure
allows at most one fresh CPU initialization; a session that silently registers
only CPU is reported as CPU without loading it again. Invalid assets/graphs are
not treated as accelerator failures. Inference-time session fallback is disabled:
there is no automatic inference retry or duplicate synthesis.

Planned narration keeps the existing JSON diagnostics envelope and adds only
`kokoro-onnx-provider-cpu|cuda`, `lid-onnx-provider-cpu|cuda`, or
`lid-torch-device-cpu|cuda` codes for successfully initialized models. Provider
codes describe registered providers, **not proof that every graph node runs on
GPU**. Direct calls report only Kokoro's bounded diagnostic envelope. No exception text, model
paths or source prose is added to these diagnostics.

**Existing managed environments remain on CPU by default.** `runtimeProfile` is
`cpu` unless explicitly changed; the source LID backend default remains `torch`.
Optional CUDA13 provisioning is separate from ordinary setup and never changes
CPU Torch/ORT requirements. Workers still start per utterance, not persistently.
GPU latency, numerical parity and listening quality are not promised by setup.

### Optional managed CUDA13 profile (Windows CPython 3.13 AMD64)

Use this only after reviewing the source and approving package downloads and
offline inference. **Setup, qualification and activation are separate steps.**
No command below plays audio, reinstalls the plugin, migrates app data, downloads
models or rewrites the voice pack. Existing local ONNX LID/Kokoro assets and a
working NVIDIA CUDA13-compatible driver are prerequisites.

The sealed [wheel lock](resources/runtime-cuda13-windows.json) selects 38 wheels
for planned narration and 23 for direct Kokoro. Public PyPI metadata totals
2,637,405,298 compressed wheel bytes across both environments (~2.64 GB); installed
space and scratch usage are larger. Setup requires **at least 12 GiB free** and
refuses existing destinations, including partial/stale environments. It never
deletes or repairs them automatically. Review a failed destination manually;
do not move/rename venvs, copy readiness markers or remove CPU environments.

Run from the repository root in PowerShell. These are explicit provisioning
commands, **not part of the default test suite**:

```powershell
$voxHome = Join-Path $env:LOCALAPPDATA "open-vox"
$scratch = Join-Path $env:LOCALAPPDATA "Temp\opencode"
$env:OPEN_VOX_HOME = $voxHome
$env:OPEN_VOX_PYTHON = "C:\Users\pc\AppData\Local\Programs\Python\Python313\python.exe"
if (-not (Test-Path -LiteralPath $scratch -PathType Container)) { throw "Missing approved scratch directory" }
if ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($voxHome)).AvailableFreeSpace -lt 12GB) { throw "Need 12 GiB free" }
foreach ($name in @("pn-onnx-gpu-venv", "kokoro-gpu-venv")) {
    if (Test-Path -LiteralPath (Join-Path $voxHome $name)) { throw "GPU destination exists; preserve and inspect it" }
}
bun .\src\cli.ts setup gpu
if ($LASTEXITCODE -ne 0) { throw "Provisioning failed; do not qualify or activate" }

# The harness scopes child TEMP/TMP and cached tempfile defaults to each --out.
# Do not change the parent PowerShell TEMP/TMP settings.
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
& "$voxHome\pn-onnx-gpu-venv\Scripts\python.exe" -I -B .\tools\qualify_gpu.py --home $voxHome --out "$scratch\open-vox-cuda13-lid-$stamp"
if ($LASTEXITCODE -ne 0) { throw "Planned GPU qualification failed; remain on CPU" }
& "$voxHome\kokoro-gpu-venv\Scripts\python.exe" -I -B .\tools\qualify_gpu.py --home $voxHome --out "$scratch\open-vox-cuda13-kokoro-$stamp"
if ($LASTEXITCODE -ne 0) { throw "Direct GPU qualification failed; remain on CPU" }
bun .\src\cli.ts doctor

# Activation is explicit and requires the existing ONNX backend plus BOTH reports.
$settings = bun .\src\cli.ts config show | ConvertFrom-Json
if ($settings.narrationBackend -ne "onnx") { throw "ONNX backend must be selected separately; no settings changed" }
bun .\src\cli.ts runtime-profile cuda13
if ($LASTEXITCODE -ne 0) { throw "Activation rejected; settings preserved" }
```

`setup gpu` creates only `pn-onnx-gpu-venv` and `kokoro-gpu-venv` under app home.
Downloads use anonymous HTTPS PyPI/file hosts, isolated pip, explicit hash-checked
URLs, no dependency resolver/cache, and child-only scratch under `Temp/opencode`.
It never co-installs CPU `onnxruntime` and `onnxruntime-gpu`: only Kokoro 0.6.1's
CPU ORT requirement is satisfied by the exact locked GPU distribution/import.
All other missing or incompatible dependencies fail readiness.
The Windows probe does not eagerly execute `dlinfo`'s glibc initializer, matching
phonemizer's Windows policy; its exact package/version/closure/origin checks remain.

Qualification uses synthetic Spanish/English input and existing local-only model
files. It checks valid nonempty LID evidence, finite nonempty Kokoro audio and CPU
sanity comparisons, then requires **per-model profiled CUDA compute node events**.
Provider advertisement/registration alone and memory-copy events are insufficient.
Legitimate CPU nodes are counted separately, not treated as all-node GPU failure.
WAV files, raw ORT profiles and a bounded report stay in the new scratch output;
there is no playback. The environment receives identity/asset-bound qualification
and filtered, hashed CUDA evidence only after successful checks. Failure returns
nonzero, preserves partial output and never activates settings.
Before any third-party dependency/model/phonemizer imports, the harness validates
and exclusively creates `--out` beneath local `Temp/opencode`, rejects traversal
and redirected paths, then scopes the child process's TEMP/TMP and Python's cached
`tempfile.tempdir` to that output. This includes phonemizer's default `mkdtemp()`
DLL-copy scratch. Prior environment values and the cache are restored on success
or failure; the calling shell's TEMP/TMP is never changed. A failed dependency
preflight may therefore leave a new empty output directory for inspection.

Doctor separates dependency readiness from inference qualification and requested
profile. Both planned/direct GPU environments must be coherent and qualified;
otherwise dispatch retains existing CPU paths with a bounded diagnostic. Torch
does not acquire a GPU installation. Managed native DLL files are checked against
distribution records before `preload_dlls(directory="")` and provider enumeration;
DLL directory handles remain alive without changing global PATH. Loaded NVIDIA
DLL provenance is checked, not described as hermetic Windows loader isolation.
Changed package/model file stamps invalidate the profile; the Python worker also
rechecks distribution/native hashes and interpreter identity before loading.
These local records are not signatures against a hostile local administrator.

Activation changes only the raw `runtimeProfile` JSON field, preserving other
settings, including unknown keys. Roll back explicitly with
`bun .\src\cli.ts runtime-profile cpu`; keep all environments/assets for inspection.
Mock tests do not certify real GPU compatibility, performance or audio quality.

Doctor hashes local files and probes pinned imports/versions without loading model
weights. An `OK` contextual line means those checks passed, not listening or LID
accuracy acceptance. `WARN` means explicit degraded dictionary/base fallback.
Known names/expressions and acronym policies still work without LID, but they do
**not** satisfy automatic contextual pronunciation of previously unknown terms.
Piper/SAPI retain bounded text-only speech with reduced pronunciation capability.

### Persistent transport acceptance (no playback)

The separate harness exercises the default Kokoro engine, private Python transport,
Markdown planning, speech queue and real owned-cache promotion. Only the WAV player
is replaced with a no-op. It injects CPU/ONNX or CUDA13/ONNX settings in memory;
it never writes configuration, provisions assets or bypasses GPU readiness checks.

Run only after explicitly approving local inference, from the repository root.
Each output must be a **fresh direct child** of the existing approved
`C:\Users\pc\AppData\Local\Temp\opencode` directory:

```powershell
bun tools/bench_persistent.ts --profile cpu --requests 3 --no-playback --out C:\Users\pc\AppData\Local\Temp\opencode\persistent-cpu-20261017-run1
bun tools/bench_persistent.ts --profile cuda13 --requests 3 --no-playback --out C:\Users\pc\AppData\Local\Temp\opencode\persistent-cuda13-20261017-run1
```

Use a new suffix if a destination exists. Forecast: **1–3 minutes per profile**,
hardware/readiness dependent, not a measurement. Two independently owned model sets
can coexist; cancellation/restart constructs a third generation over the run. RAM
and VRAM costs multiply per concurrent instance; the harness does not measure an
exact memory peak. This is not the historical 34-minute benchmark.

`summary.json` contains bounded synthetic-input character/word counts, complete
integer PCM frame/duration/byte metrics, elapsed time, actual device codes, worker
owner/PID/generation/request IDs and counters. First timing begins before engine
construction; later timings include normal admission, transport, validation and
cache promotion. No source text, raw plans, model paths or exception prose are
recorded. WAVs use cache-owned UUID names beneath the output and are disposed after
verification. Failed acceptance writes a partial summary and returns nonzero;
owned cleanup is attempted on every path.

Acceptance checks distinct sequential requests and sessions, one warm generation,
Repeat without inference, interleaved independent instances, owned active
cancellation, deletion preserving another queued session, restart without replay,
Off and idle-worker disposal. `--idle-ms 1000` optionally tests expiry with an
explicit test override (1000–60000 ms); without it the production five-minute
timeout is covered only by mocked tests, not a five-minute benchmark wait.

Counter semantics: `kokoroLoads` counts a successful returned Kokoro/session load;
`detectorBuilds` counts detector objects, **not** lazy LID loads. `lidLoads` and
`tokenizerLoads` count the successful lazy `_runtime` transition. `kokoroCreates`,
`kokoroRuns` and `lidRuns` count actual delegated instance-method entries, including
calls that subsequently fail. These are not accepted-request counts or native
constructor-attempt counts (including failed accelerator fallback attempts).
Unsupported instrumentation is `null` and fails real load-reuse acceptance, never
silently becoming proof. Counters reset with each generation; snapshots contain
detached read-only values, not mutable process/controller handles.

The harness and telemetry are mocked-test verified only until a separate runtime
executor runs these commands. Synthetic child pipe EOF is tested without models;
forced host death during GPU bootstrap or a GIL-holding native hang remains unproved.
The older benchmark's TypeScript engine leg uses unsupported non-UUID outputs and
omits engine disposal; do not use it as persistent-worker acceptance evidence.
Existing benchmark files and historical results are unchanged.

### Derived text, limits and privacy

- The original response/history remains unchanged. Markdown becomes a separate
  bounded structural plan: headings, paragraphs, lists and quotes keep structure;
  inline technical units retain their meanings; code blocks/tables are omitted
  with announcements. Visible link labels/image alt text can be spoken; URLs,
  destinations and HTML are omitted conservatively. Malformed/unclosed HTML may
  suppress later prose rather than leak markup.
- Narration retains at most **4000 UTF16 units**, including announcements and
  numbering. Truncation is diagnosed; indivisible technical units and resolver
  expansion can fail explicitly instead of being cut. Each Kokoro inference is
  at most **510 raw phonemes**; adjacent language runs pack inside each block.
- One existing voice slot is selected from the configured base language and kept
  across the whole utterance. Language-specific G2P is not translation. Ambiguous,
  missing or unusable contextual evidence falls back conservatively; softmax scores
  are uncalibrated, and naturalness is not guaranteed.
- Settings changes apply to **new utterances**, including changes made while idle.
  Repeat replays the exact old cached WAV and does not reparse or run inference.
- Inference is local-only, existing-files-only, CUDA when usable or CPU otherwise,
  FP32 and safetensors-only for Torch, with remote
  code disabled. It verifies the bundled model hashes once before loading per
  synthesis, not per word. No private prose is sent to external inference services
  or written as a full persistent source trace by default; cached audio remains
  sensitive local content. Provisioning uses only anonymous public downloads.

`OPEN_VOX_HOME` optionally chooses a different managed app home. Runtime does not
scan scratch environments or model caches. The helper's optional `--lid-manifest`
transport argument defaults relative to its own checkout and cannot substitute a
different checkpoint/hash manifest. No new manual model-path setting is required.
Wire/source-range and lifecycle acceptance details are tracked in
[`odd/tasks/pronunciation-normalization.md`](odd/tasks/pronunciation-normalization.md).

Pause is no longer a terminal command. `open-vox pause`, `resume` and `toggle` were
removed and now fail as unknown commands; use the **Pause** button in the sidebar.
An old `paused` entry in `config.json` is ignored and dropped on the next write.

## Sidebar block

`open-vox install` adds a small **open-vox** block to the OpenCode sidebar with
an instance-local service icon and four buttons across two rows:

- **Service On/Off**: the title icon shows confirmed On (green), Off (red), or
  unconfirmed (neutral and not clickable). Off cancels this instance's work,
  clears Pause without resuming and deletes retained WAV audio after holds release.
  On permits new narration only; it restores neither discarded audio nor position.
  Pause/Speak/Repeat are unavailable while Off; Voice remains available. State is held
  in memory, not shared config. A statically unavailable instance cannot be enabled.
  Playback-rate preference is separate from this service control and synthesis speed.

- **Pause / Resume**: freezes the narration that is playing (same audio, same
  position). While paused, only the latest valid completed response is retained,
  without synthesis or playback. **Resume** narrates it once, discarding obsolete
  frozen audio before starting. If no new response exists, Resume continues valid
  frozen audio from the same position, without synthesizing again.
  Pause also clears the queue and mutes new narrations for **this OpenCode instance
  only**. A narration that is still being synthesized has no audio to hold yet, so
  it is cancelled. If the player cannot pause (the one-shot fallback player, or a
  player that does not answer), Pause stops that narration instead and Resume has
  nothing to continue. The state lives in memory (it resets when OpenCode restarts)
  and the button shows the state the plugin confirmed, so it is disabled until the
  plugin has answered.
- **Voice**: opens a list of voices; picking one changes the voice for that
  language immediately.
- **Speak / Repeat**: **Speak** generates and plays the latest eligible
  response when it has no audio of its own. Failed or cancelled generation can be
  retried manually; repeated clicks cannot restart pending preparation or synthesis.
  Once that response has audio, **Repeat** restarts its exact WAV without synthesis.
  Older response audio never enables Repeat for newer text. Voice, synthesis speed
  and engine changes apply to Speak/new narration, not Repeat. Both actions are
  unavailable while paused or Off, without a valid latest target for the displayed
  session, or while instance discovery is missing/ambiguous. After a restart or
  re-enabling, the displayed session can recover its latest persisted response for
  an explicit Speak click. Discovery never generates or plays audio. A newer user
  request or unfinished response prevents falling back to an older answer.
  Recovery examines at most 100 recent messages, caches discovery for five seconds
  and revalidates clicks; ambiguous, missing or invalid history leaves Speak disabled.
- **Playback rate**: the second-row button cycles **1.0x → 1.5x → 2.0x → 1.0x**
  from the confirmed instance preference. Unconfirmed state shows **Speed**;
  clicks never advance the label optimistically. It is disabled while Off or
  unconfirmed, but remains available while paused. The rate affects current and
  later playback, including Repeat, without rebuilding PN plans or WAV audio.
  It starts at 1x per instance, survives Off/On and is never written to shared config.
  The label confirms stored preference, not audible application: missing host
  acknowledgment or SoundPlayer fallback can leave playback at its original rate.

Each server plugin instance retains at most one latest manual response and one last
audio artifact, bound to its session and message. Switching sessions invalidates
in-flight manual discovery; another session cannot act on the old target. Returning to the owner session
permits Repeat only while the latest valid response still owns that audio.
Failed/cancelled/invalid generation keeps prior audio without assigning it to newer
text. Pause keeps
the paused playback (and its audio file) until Resume or until it is discarded: a new
user turn, a session error, message removal, an assistant error, deleting the owner
session or disposing the plugin invalidates affected work, including retained text,
and the instance stays paused until Resume. Off clears all pending text as well.
Resume with neither retained text nor valid frozen audio only unmutes future
narration. Cached audio does not survive a plugin
restart. Deleting the owner session or disposing the plugin removes owned audio
after player handles close. Repeat requests received while paused remain rejected;
they are not retained completed responses.

Speak, Repeat and Pause use correlated, metadata-only `tui.command.execute` events sent
through the attached SDK client's `tui.publish`. Instance nonce, session, request
identity and expiry guard replay on the server. Speak/Repeat also validate the
latest message identity; Repeat checks the audio revision. Pause sends an explicit
`pause` or `resume` action, never a toggle; the
nonce is routing metadata, not an authentication secret. Other attached clients
ignore unmatched challenges. No transient commands are written into shared settings.

Audio is held under the isolated temporary `open-vox-audio-v1` namespace, not
alongside models/settings. Dead-owner cleanup only recognizes its own directory
format and skips live/reused PIDs, unknown access state and symlinks/junctions.
Cached audio is local sensitive content, not an encrypted archive or history.

For the voice, the block and the CLI share the same settings file, so a change in
one shows up in the other within a second. The block is a separate TUI plugin
(`tui/open-vox.tsx`). OpenCode 2.x loads TUI plugins only as directories, so `install`
copies it to `~/.config/opencode/tui-plugins/open-vox/tui.tsx` and registers that
directory in `cli.json` `plugins`; existing entries are preserved. It also removes a
previous single-file install (`tui-plugins/open-vox.tsx` and its `tui.json` entry).

On OpenCode 2.x the server loader in `plugins/open-vox.js` re-exports the V2 entrypoint
`src/opencode-v2.ts`. The sidebar and the server plugin talk through the `open-vox` plugin
RPC (`src/rpc.ts`), which replaces the V1 `tui.command.execute` channel; the encoded
commands are unchanged.

## How it works

1. `src/plugin.ts` admits automatic narration only after a fresh user turn is
   observed. Separately, sidebar discovery may read bounded persisted history for
   explicit Speak/Repeat eligibility. Historical responses never autoplay, including
   after service re-enabling or Pause/Resume.
2. `src/final-response.ts` accepts a message only when it is a root-session
   assistant reply with `finish: "stop"`, a completion time, no error, no
   summary flag, and permitted text. Tool turns, errors, aborts, compaction,
   child sessions and malformed data are rejected.
3. `src/markdown-narration.ts` builds a bounded derived structural plan from
   Markdown; deterministic policies and optional pinned local token classification
   resolve pronunciation. Piper/SAPI use a reduced flattened text representation.
4. Engines, re-chosen on every utterance (`auto` order below):
   - `src/kokoro-engine.ts` + `src/narration-worker.ts` + `scripts/narration_worker.py`: [Kokoro](https://github.com/thewh1teagle/kokoro-onnx)
      (82M ONNX model, CUDA when usable or CPU).
   - `src/piper-engine.ts`: [Piper](https://github.com/rhasspy/piper) voices
     (`es_MX-claude-high`, `en_US-lessac-high`).
   - Windows SAPI voices as the last resort.
5. `src/speech-sink.ts` queues messages serially. A new user turn, a session
   error stops the current speech; pausing freezes the playing audio and
   cancels queued and in-flight synthesis (see Pause above). The pause flag is
   held in memory by each plugin instance and changes only through the control
   channel.
6. `src/player.ts` + `scripts/player.ps1` play the cached audio through one
   persistent `powershell.exe -STA` host (WPF `MediaPlayer`) per plugin
   instance, started on the first narration and stopped when idle. If the host
   cannot start or fails, that playback falls back to the one-shot
   `SoundPlayer` path.
7. `src/config.ts` is the shared settings file used by the plugin, the CLI and
   the sidebar block.

### Persistent narration model ownership

The default Kokoro engine starts one private Python worker lazily per plugin instance,
not per chat session. Sequential requests reuse loaded models/tokenizers over bounded
UTF-8 NDJSON pipes. Plans, text, synthesized results and blended styles are not cached
between requests. The one-shot `scripts/kokoro_say.py` helper remains available unchanged.

| Event | Worker behavior |
|-------|-----------------|
| Voice, speed or tone changes | New request settings; unchanged idle models stay loaded |
| Interpreter, backend, asset stamps or output-root changes | Retire the old generation before starting another |
| Queued session cancellation/deletion | Remove that session's queued jobs; preserve other sessions' queue entries |
| Active synthesis cancellation or Pause | Kill only this instance's worker; the next admitted request reloads |
| Off, disposal or five minutes idle | Retire the owned worker, including when no request is active |
| Crash, deadline or protocol fault | Fail without inference replay; wait for child close before releasing output holds |

Other OpenCode instances have independent controllers, pipes and model memory. There
is no shared daemon, port, registry or cross-instance cancellation. Concurrent instances
therefore multiply RAM/VRAM use and may still contend for the same hardware. Repeat
plays the retained WAV without another synthesis request.

Startup and each sent request have 120-second transport bounds. Shutdown attempts a
second owned-process kill after three seconds; disposal reports failure if close is not
observed, rather than pretending a partial writer has exited. Startup emits `imports`,
imports required SDK libraries serially under stdout redirection, starts the stdin EOF
reader, then probes runtime and constructs/loads models. Preimport constructs no local
model, tokenizer or session; ONNX/direct Kokoro does not import Torch. Optional LID
dependency absence retains degraded detection behavior. EOF monitoring covers session
loading and inference after imports, not the import phase. Explicit cancellation/disposal
still terminates the owned child. Forced-host-death cleanup during imports/native hangs
is not guaranteed; GPU preflight also precedes the monitor, and GIL-holding native code
may delay it. There is **no all-time orphan guarantee**.

The Windows reader-first NumPy import stall is corrected by SDK preimport, not a native
pipe replacement or moving model loading before monitoring. The real CPU import/ready/EOF
regression and one production-transport CPU acceptance run passed. Its first three
different requests took 3010, 784 and 810 ms with one model/tokenizer load per generation;
two-instance isolation, owned cancellation/restart, Repeat and shutdown also passed.
These are descriptive timings, not a statistical comparison. GPU acceptance, real
five-minute idle expiry and memory-release measurements remain pending. Historical failed
reader/native-pipe evidence is preserved in the [task document](odd/tasks/persistent-narration-worker.md).

Low-level persistent synthesis callers must supply a new UUID-named WAV or an empty
exclusive UUID placeholder in a caller-owned output directory and dispose the engine
in `finally`. The older benchmark's TypeScript engine leg does not follow this lifetime
contract; preserve its reports, but do not use that leg as persistent-worker acceptance.

## Renamed from agentVoz

The project used to be called agentVoz. `open-vox install` migrates a previous
installation: it moves `%LOCALAPPDATA%\agentVoz` (settings, models, voices) to
`%LOCALAPPDATA%\open-vox`, removes the old `agentvoz` plugin files from OpenCode,
and keeps your other plugins. The old `AGENTVOZ_*` environment variables still
work as a fallback for the new `OPEN_VOX_*` names.

## Environment variables

These override the settings file when set:

- `OPEN_VOX_DISABLED=1` mutes everything.
- `OPEN_VOX_ENGINE`, `OPEN_VOX_SPEED`, `OPEN_VOX_KOKORO_VOICE_ES`, `OPEN_VOX_KOKORO_VOICE_EN`.
- `OPEN_VOX_VOICE_ES` / `OPEN_VOX_VOICE_EN`: Piper model names.
- `OPEN_VOX_HOME`: where models and settings live (default `%LOCALAPPDATA%\open-vox`).
- `OPENCODE_CONFIG_DIR`: OpenCode config directory (default `~/.config/opencode`).
- `OPEN_VOX_LOG=<file>`: write a small diagnostic log.

## Verify locally

```powershell
bun test
node ./node_modules/typescript/bin/tsc --noEmit
```

Tests use fake clients and fake process spawners, with in-memory filesystem
fixtures and isolated temporary filesystem tests. They never play audio or touch
your OpenCode configuration.

An optional smoke test drives the real player host with muted volume
(`OV_PLAYER_MUTE=1`, no audible audio):

```powershell
$env:OV_PLAYER_SMOKE = "1"; bun test test/player.test.ts
```

### CPU vs GPU benchmark (maintainers)

`tools/bench_runtime.py` times each narration step (start-up, LID load and inference, Kokoro load, phonemization,
inference, WAV write) per profile with explicit interpreters, cold per process and warm in process, using synthetic text
only. It never changes `runtimeProfile` or any config, and never plays audio. Start with `--preflight` and `--dry-run`,
then run it with `--out` under `%LOCALAPPDATA%\Temp\opencode`; `tools/bench_report.py` turns the raw JSON into a
Markdown report and a CSV. Reports contain counts and durations, never text.

The report separates instrumented cold totals, unmodified Python production-worker wall time, and real
`defaultKokoroEngine.synthesizePlan` synthesis-only timing (inside Bun plus parent wall). Engine settings are injected
in memory: ONNX, CPU or CUDA13, fixed voices/speed, no config writes or playback. The shared real TypeScript planner
runs before these measurements; engine timing is not whole-UI latency. `--engine-reps` and `--prod-reps` default to 1
(preliminary), versus 5 cold repetitions and 10 timed warm iterations. Use fresh output directories for each run.
Every run, including each warm iteration, must report the requested device for both LID and Kokoro; missing or mismatched
evidence is retained for audit but excluded from comparisons. CUDA + CPU registered providers do not imply all-node CUDA
placement. Process peak memory is unavailable because the Windows venv launcher is not the inference process; old numeric
launcher peaks are ignored. GPU before/after memory is a coarse global delta, not a workload peak. Signed `untimed_worker`
and `unattributed` residuals reconcile cold exclusive timings with parent wall; per-step medians need not sum to median totals.

## Known limits

- `opencode run` exits right after the session goes idle, which can cut speech
  short. Use the TUI or a server session.
- Contextual ES/EN pronunciation requires explicit `setup narration`. Missing or
  unusable evidence falls back to policies and the configured base language; no
  automatic new-term accuracy or listening qualification is claimed.
- The Voice list covers Kokoro voices only. With the Piper or SAPI engines, use
  `OPEN_VOX_VOICE_*` or the Windows settings instead.
- Automated sidebar checks use opentui's test renderer; live evidence is limited
  to the user-confirmed Repeat scenario below, not full sidebar qualification.
- Repeat has deterministic fake-process, isolated-filesystem, attached SDK
  transport, handshake and UI-guard tests plus a TSX transpile check. After the
  sidebar session-binding fix and a user-controlled restart, the user confirmed
  Repeat enabled and replayed a newly narrated answer in the live session.
  This does not qualify every Windows engine, session switching/deletion, player
   handle cleanup or host-disposal timing. Per-instance Pause (control channel and
   confirmed-state display) has deterministic fake-transport tests only; its live
   sidebar behavior is not yet verified. Real Pause/Resume of the player host is
   covered by fake-host tests plus an opt-in muted smoke test
   (`OV_PLAYER_SMOKE=1 OV_PLAYER_MUTE=1 bun test test/player.test.ts`); it has not
   been judged by ear or in a live OpenCode session.
- Event freshness is bounded by observation: a delayed historical user update
  could in theory look fresh. Real-host traces are in
  [`odd/tasks/bootstrap.md`](odd/tasks/bootstrap.md).
