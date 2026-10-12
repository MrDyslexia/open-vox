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
| `open-vox doctor` / `status` | Check the installation / show current settings |
| `open-vox voices` | List the voices (`*` marks the current ones) |
| `open-vox voice <id>` | Change the voice, e.g. `voice em_alex`, `voice bm_george` |
| `open-vox speed <0.5-2>` | Speaking speed |
| `open-vox engine auto\|kokoro\|piper\|sapi` | Speech engine |
| `open-vox language es\|en` | Set the narration base language; preserve both voice slots |
| `open-vox say <text>` | Speak a test sentence with the current settings |
| `open-vox config path\|show\|reset` | Inspect or reset the settings file |

Defaults: Spanish `em_alex`, English `af_heart`. Voices whose id starts with `b`
(for example `bm_george`) are British and use British phonemes automatically.

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

Doctor hashes local files and probes pinned imports/versions without loading model
weights. An `OK` contextual line means those checks passed, not listening or LID
accuracy acceptance. `WARN` means explicit degraded dictionary/base fallback.
Known names/expressions and acronym policies still work without LID, but they do
**not** satisfy automatic contextual pronunciation of previously unknown terms.
Piper/SAPI retain bounded text-only speech with reduced pronunciation capability.

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
- Inference is local-only, existing-files-only, CPU, safetensors-only, with remote
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
three buttons:

- **Pause / Resume**: freezes the narration that is playing (same audio, same
  position) and **Resume** continues it from there, without synthesizing again.
  Pause also clears the queue and mutes new narrations for **this OpenCode instance
  only**. A narration that is still being synthesized has no audio to hold yet, so
  it is cancelled. If the player cannot pause (the one-shot fallback player, or a
  player that does not answer), Pause stops that narration instead and Resume has
  nothing to continue. The state lives in memory (it resets when OpenCode restarts)
  and the button shows the state the plugin confirmed, so it is disabled until the
  plugin has answered.
- **Voice**: opens a list of voices; picking one changes the voice for that
  language immediately.
- **Repeat**: restarts the last successfully generated audio from the beginning,
  using the same WAV bytes without synthesizing again. Later voice, speed or engine
  changes affect new narration, not Repeat. It is disabled while paused, without
  audio for the displayed session, or when instance discovery is missing/ambiguous.
  Pause stays usable in those last two cases, as long as the plugin answered.

Each server plugin instance retains only one last audio, owned by its session.
Switching sessions or inactivity keeps it; another session cannot replay it, and
returning to the owner session enables Repeat until a successful new generation
replaces it. Failed/cancelled/invalid generation keeps the prior audio. Pause keeps
the paused playback (and its audio file) until Resume or until it is discarded: a new
user turn, a session error, deleting the owner session or disposing the plugin
stops it, and the instance then stays paused until Resume. Resume with nothing
paused only unmutes future narration. Cached audio does not survive a plugin
restart. Deleting the owner session or disposing the plugin removes owned audio
after player handles close. Resume does not replay a request received while paused.

Repeat and Pause use correlated, metadata-only `tui.command.execute` events sent
through the attached SDK client's `tui.publish`. Instance nonce, session, request
identity and expiry guard replay on the server (Repeat also checks the audio
revision; Pause sends an explicit `pause` or `resume` action, never a toggle); the
nonce is routing metadata, not an authentication secret. Other attached clients
ignore unmatched challenges. No transient commands are written into shared settings.

Audio is held under the isolated temporary `open-vox-audio-v1` namespace, not
alongside models/settings. Dead-owner cleanup only recognizes its own directory
format and skips live/reused PIDs, unknown access state and symlinks/junctions.
Cached audio is local sensitive content, not an encrypted archive or history.

For the voice, the block and the CLI share the same settings file, so a change in
one shows up in the other within a second. The block is a separate TUI plugin
(`tui/open-vox.tsx`) that `install` copies into `~/.config/opencode/tui-plugins`
and registers in `tui.json`; existing entries are preserved.

## How it works

1. `src/plugin.ts` watches OpenCode events and picks a candidate only after a
   fresh user turn is observed. It never reads history or replays old messages.
2. `src/final-response.ts` accepts a message only when it is a root-session
   assistant reply with `finish: "stop"`, a completion time, no error, no
   summary flag, and permitted text. Tool turns, errors, aborts, compaction,
   child sessions and malformed data are rejected.
3. `src/markdown-narration.ts` builds a bounded derived structural plan from
   Markdown; deterministic policies and optional pinned local token classification
   resolve pronunciation. Piper/SAPI use a reduced flattened text representation.
4. Engines, re-chosen on every utterance (`auto` order below):
   - `src/kokoro-engine.ts` + `scripts/kokoro_say.py`: [Kokoro](https://github.com/thewh1teagle/kokoro-onnx)
     (82M ONNX model, CPU).
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
