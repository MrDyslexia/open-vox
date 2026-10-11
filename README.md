# open-vox

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
| `open-vox doctor` / `status` | Check the installation / show current settings |
| `open-vox pause` / `resume` / `toggle` | Stop or resume narration |
| `open-vox voices` | List the voices (`*` marks the current ones) |
| `open-vox voice <id>` | Change the voice, e.g. `voice em_alex`, `voice bm_george` |
| `open-vox speed <0.5-2>` | Speaking speed |
| `open-vox engine auto\|kokoro\|piper\|sapi` | Speech engine |
| `open-vox say <text>` | Speak a test sentence with the current settings |
| `open-vox config path\|show\|reset` | Inspect or reset the settings file |

Defaults: Spanish `em_alex`, English `af_heart`. Voices whose id starts with `b`
(for example `bm_george`) are British and use British phonemes automatically.

## Sidebar block

`open-vox install` adds a small **open-vox** block to the OpenCode sidebar with
two buttons:

- **Pause / Resume**: stops the current narration and mutes new ones.
- **Voice**: opens a list of voices; picking one changes the voice for that
  language immediately.

The block and the CLI share the same settings file, so a change in one shows up
in the other within a second. The block is a separate TUI plugin
(`tui/open-vox.tsx`) that `install` copies into `~/.config/opencode/tui-plugins`
and registers in `tui.json`; existing entries are preserved.

## How it works

1. `src/plugin.ts` watches OpenCode events and picks a candidate only after a
   fresh user turn is observed. It never reads history or replays old messages.
2. `src/final-response.ts` accepts a message only when it is a root-session
   assistant reply with `finish: "stop"`, a completion time, no error, no
   summary flag, and permitted text. Tool turns, errors, aborts, compaction,
   child sessions and malformed data are rejected.
3. `src/speech-text.ts` strips Markdown (code, links, tables, headings) and
   detects Spanish or English.
4. Engines, re-chosen on every utterance (`auto` order below):
   - `src/kokoro-engine.ts` + `scripts/kokoro_say.py`: [Kokoro](https://github.com/thewh1teagle/kokoro-onnx)
     (82M ONNX model, CPU).
   - `src/piper-engine.ts`: [Piper](https://github.com/rhasspy/piper) voices
     (`es_MX-claude-high`, `en_US-lessac-high`).
   - Windows SAPI voices as the last resort.
5. `src/speech-sink.ts` queues messages serially. A new user turn, a session
   error, or pausing stops the current speech.
6. `src/config.ts` is the shared settings file used by the plugin, the CLI and
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

Tests use fake clients, fake process spawners and an in-memory file system; they
never play audio or touch your OpenCode configuration.

## Known limits

- `opencode run` exits right after the session goes idle, which can cut speech
  short. Use the TUI or a server session.
- Language detection is a word-list heuristic; very short text falls back to
  English.
- The Voice list covers Kokoro voices only. With the Piper or SAPI engines, use
  `OPEN_VOX_VOICE_*` or the Windows settings instead.
- The sidebar block is verified with opentui's test renderer, not in a live
  terminal session.
- Event freshness is bounded by observation: a delayed historical user update
  could in theory look fresh. Real-host traces are in
  [`odd/tasks/bootstrap.md`](odd/tasks/bootstrap.md).
