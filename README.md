# agentVoz: silent bootstrap

This is a Windows-first, local-only development boundary, not an audio-ready
product. The plugin is **unactivated** and its default sink does nothing. No
speech engine, language detector, model, audio device, or shell execution exists
in this unit. Sherpa-onnx is prohibited, including trials.

## Verify locally

The observed environment is Bun 1.3.14, Node 24.19.0, and OpenCode 1.18.35.
Development dependencies are version-pinned; install scripts are disabled.

```powershell
bun install --ignore-scripts
bun test ./test/final-response.test.ts
bun test ./test/plugin.test.ts
bun test
node ./node_modules/typescript/bin/tsc --noEmit
```

Tests use fake clients and inert sinks, with no external calls or audio.

## Boundary

- `src/final-response.ts` validates root session and user-parent identities,
  explicit successful completion, and permitted nonempty text. Compaction,
  errors, child sessions, unknown finishes, and malformed identities fail closed.
- `src/plugin.ts` exports a typed production skeleton and injectable coordinator.
  Only observed post-initialization user updates establish a candidate turn.
  It fetches specific session/message/parent records; it never enumerates history.
  Idle events do nothing. Claims precede awaits, and failures never auto-retry.
- New turns, errors, removals, and explicit coordinator disposal invalidate
  pending fetch work. Cancellation cannot retract a sink invocation already made;
  a future audio sink would need its own cancellation contract.

State is bounded to 128 session records, 64 unique user turns per session, and
256 claimed assistant IDs per session. Records are never evicted into a replay
window. Exhausted sessions fail closed until coordinator recreation; deleted
sessions remain blocked. Recreation clears state and requires newly observed
user events. Duplicate user IDs and non-increasing creation timestamps are
ignored; this intentionally sacrifices ambiguous same-timestamp turns.

## Next boundary

Fake events prove selection policy, not real host finality or event freshness.
A delayed historical user update could appear fresh after initialization; no
real-host trace qualification has occurred. Keep activation blocked until a
separately authorized lifecycle-trace task verifies success, tool, error, abort,
compaction, reload, and child-session ordering. Language detection, Markdown
processing, model qualification, and speech execution are later units.

Tracking and exact verification evidence: [`odd/tasks/bootstrap.md`](odd/tasks/bootstrap.md).
