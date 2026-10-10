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
4. `src/speech-sink.ts` speaks the text with an installed voice for that
   language (one PowerShell process per message, text via stdin), queued
   serially. A new user turn or a session error stops the current speech.

## Install

Create `%USERPROFILE%\.config\opencode\plugins\agentvoz.js` containing:

```js
export { AgentVozPlugin } from "file:///C:/Users/pc/Documents/agentVoz/src/index.ts";
```

Remove that file to uninstall. Set `AGENTVOZ_DISABLED=1` to mute without
uninstalling. Set `AGENTVOZ_LOG=<file>` to write a small diagnostic log.

Requirements: Windows, and at least one installed SAPI voice per language
(Spanish and English voices ship with Windows; see Settings > Speech).

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
