# agentVoz

An OpenCode plugin that reads the agent's final answer aloud. Windows-first and
local-only: neural voices run on your machine (Kokoro, then Piper), with the
built-in Windows voices as a fallback. No cloud service and no sherpa-onnx.

## Quick start

```powershell
bun install --ignore-scripts
bun link                      # makes the `agentvoz` command available globally
agentvoz setup kokoro         # venv + model download (about 340 MB)
agentvoz install              # registers the plugin and the sidebar block
agentvoz doctor               # checks everything
```

Then restart OpenCode. Requirements: Windows, [Bun](https://bun.sh), and Python 3
(only for `setup kokoro`).

## Terminal commands

Settings live in `%LOCALAPPDATA%\agentVoz\config.json` and apply immediately, with
no restart, even while OpenCode is running.

| Command | What it does |
| --- | --- |
| `agentvoz install [--no-tui]` | Register the plugin and the sidebar block in OpenCode |
| `agentvoz uninstall` | Remove both (settings and downloaded voices are kept) |
| `agentvoz setup kokoro\|piper` | Download a local neural voice engine |
| `agentvoz doctor` / `status` | Check the installation / show current settings |
| `agentvoz pause` / `resume` / `toggle` | Stop or resume narration |
| `agentvoz voices` | List the voices (`*` marks the current ones) |
| `agentvoz voice <id>` | Change the voice, e.g. `voice em_alex`, `voice bm_george` |
| `agentvoz speed <0.5-2>` | Speaking speed |
| `agentvoz engine auto\|kokoro\|piper\|sapi` | Speech engine |
| `agentvoz say <text>` | Speak a test sentence with the current settings |
| `agentvoz config path\|show\|reset` | Inspect or reset the settings file |

Defaults: Spanish `em_alex`, English `af_heart`. Voices whose id starts with `b`
(for example `bm_george`) are British and use British phonemes automatically.

## Sidebar block

`agentvoz install` adds a small **agentVoz** block to the OpenCode sidebar with
two buttons:

- **Pause / Resume**: stops the current narration and mutes new ones.
- **Voice**: opens a list of voices; picking one changes the voice for that
  language immediately.

The block and the CLI share the same settings file, so a change in one shows up
in the other within a second. The block is a separate TUI plugin
(`tui/agentvoz.tsx`) that `install` copies into `~/.config/opencode/tui-plugins`
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

## Environment variables

These override the settings file when set:

- `AGENTVOZ_DISABLED=1` mutes everything.
- `AGENTVOZ_ENGINE`, `AGENTVOZ_SPEED`, `AGENTVOZ_KOKORO_VOICE_ES`, `AGENTVOZ_KOKORO_VOICE_EN`.
- `AGENTVOZ_VOICE_ES` / `AGENTVOZ_VOICE_EN`: Piper model names.
- `AGENTVOZ_HOME`: where models and settings live (default `%LOCALAPPDATA%\agentVoz`).
- `OPENCODE_CONFIG_DIR`: OpenCode config directory (default `~/.config/opencode`).
- `AGENTVOZ_LOG=<file>`: write a small diagnostic log.

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
  `AGENTVOZ_VOICE_*` or the Windows settings instead.
- The sidebar block is verified with opentui's test renderer, not in a live
  terminal session.
- Event freshness is bounded by observation: a delayed historical user update
  could in theory look fresh. Real-host traces are in
  [`odd/tasks/bootstrap.md`](odd/tasks/bootstrap.md).
