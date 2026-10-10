# agentVoz

An OpenCode plugin that reads the agent's final answer aloud. Windows-first and
local-only: speech uses the built-in Windows SAPI voices, with no cloud service,
model download, or sherpa-onnx.

## How it works

1. `src/plugin.ts` watches OpenCode events and picks a candidate only after a
   fresh user turn is observed. It never reads history or replays old messages.
2. `src/final-response.ts` accepts a message only when it is a root-session
   assistant reply with `finish: "stop"`, a completion time, no error, no
   summary flag, and permitted text. Tool turns, errors, aborts, compaction,
   child sessions and malformed data are rejected.
3. `src/speech-text.ts` strips Markdown (code, links, tables, headings) and
   detects Spanish or English.
4. Engines, chosen in this order (override with `AGENTVOZ_ENGINE=kokoro|piper|sapi`):
   - `src/kokoro-engine.ts` + `scripts/kokoro_say.py`: [Kokoro](https://github.com/thewh1teagle/kokoro-onnx)
     (82M ONNX model, CPU). Default voices `ef_dora` (es) and `af_heart` (en).
   - `src/piper-engine.ts`: [Piper](https://github.com/rhasspy/piper) neural voices.
   - Windows SAPI voices as the last resort.
5. `src/speech-sink.ts` queues messages serially. A new user turn or a session
   error stops the current speech.

## Install

Create `%USERPROFILE%\.config\opencode\plugins\agentvoz.js` containing:

```js
export { AgentVozPlugin } from "file:///C:/Users/pc/Documents/agentVoz/src/index.ts";
```

Remove that file to uninstall. Set `AGENTVOZ_DISABLED=1` to mute without
uninstalling. Set `AGENTVOZ_LOG=<file>` to write a small diagnostic log.

### Neural voices (Kokoro, preferred)

```powershell
$root = "$env:LOCALAPPDATA\agentVoz"
python -m venv "$root\kokoro-venv"
& "$root\kokoro-venv\Scripts\python.exe" -m pip install kokoro-onnx soundfile
# Download into $root\kokoro\ from github.com/thewh1teagle/kokoro-onnx releases (model-files-v1.0):
#   kokoro-v1.0.onnx (310 MB) and voices-v1.0.bin (27 MB)
```

Voices: `AGENTVOZ_KOKORO_VOICE_ES` (`ef_dora`, `em_alex`, `em_santa`) and
`AGENTVOZ_KOKORO_VOICE_EN` (`af_heart`, `am_adam`, ...). Speed: `AGENTVOZ_SPEED`
(0.5 to 2, default 1). A short sentence synthesizes in under a second on CPU;
each message also loads the model (about 1 s).

### Neural voices (Piper, fallback)

Everything lives under `%LOCALAPPDATA%\agentVoz` (override with `AGENTVOZ_HOME`):

```
agentVoz\piper\piper.exe            # piper_windows_amd64.zip from rhasspy/piper 2023.11.14-2
agentVoz\voices\es_MX-claude-high.onnx(.json)
agentVoz\voices\en_US-lessac-high.onnx(.json)
```

Voices come from `huggingface.co/rhasspy/piper-voices`. Use a different voice by
putting its files in `voices\` and setting `AGENTVOZ_VOICE_ES` / `AGENTVOZ_VOICE_EN`
to the model name without `.onnx`. Set `AGENTVOZ_ENGINE=sapi` to force the
built-in Windows voices. Piper runs on CPU; a sentence takes about 1 second.

Without Piper, the plugin needs one installed SAPI voice per language (Spanish
and English voices ship with Windows).

## Verify locally

```powershell
bun install --ignore-scripts
bun test
node ./node_modules/typescript/bin/tsc --noEmit
```

Tests use fake clients and a fake process spawner; they never play audio.

## Known limits

- `opencode run` exits right after the session goes idle, which can cut speech
  short. Use the TUI or a server session.
- Language detection is a word-list heuristic; very short text falls back to
  English.
- If no voice exists for the detected language, the default voice is used.
- Event freshness is bounded by observation: a delayed historical user update
  could in theory look fresh. Real-host traces are in
  [`odd/tasks/bootstrap.md`](odd/tasks/bootstrap.md).
