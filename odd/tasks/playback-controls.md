# Open-Vox - controllable player, per-instance controls, Pause/Resume, On/Off, playback speed

Status: **IN PROGRESS** (started 2026-10-11, branch `feat/playback-controls`). Backend project: `agentvoz`. Engram recovery topic: `odd/playback-controls/tasks`. Related, separate documents: `odd/tasks/playback-speed.md` (PS-01..PS-11, superseded in part by the decisions below), `odd/tasks/chunked-narration.md` (CN, later), `odd/tasks/pronunciation-normalization.md` (PN, independent).

## Objective

Replace the one-shot `System.Media.SoundPlayer.PlaySync()` playback with a persistent, controllable player so Open-Vox can offer real Pause/Resume (same audio, real position), a per-instance service On/Off toggle, and a cyclic playback-speed button, all scoped to one OpenCode instance.

## Decisions (user-approved, 2026-10-11)

| ID | Decision |
| --- | --- |
| D1 | Every runtime control (Pause/Resume, service On/Off, playback speed) is **per OpenCode instance**, held in memory by that plugin instance. Initial state: enabled, not paused, 1.0x. Nothing is persisted across restarts. |
| D2 | Control uses the nonce-targeted `tui.command.execute` event channel (as Repeat), not shared `config.json`. The TUI shows the **confirmed** state from the plugin `status` reply, not click intent. |
| D3 | The CLI `pause`, `resume` and `toggle` commands are removed. `paused` leaves `config.json`. Voice, engine and synthesis speed stay in `config.json` as shared persisted defaults (assumption, not yet explicitly confirmed). |
| D4 | Player: WPF `System.Windows.Media.MediaPlayer` in a persistent `powershell.exe -NoProfile -STA -ExecutionPolicy Bypass` child with a stdin line protocol and JSON-line stdout events. |
| D5 | Playback speed cycle is `1.0x -> 1.5x -> 2.0x -> 1.0x` (2.5x dropped). A change applies immediately to the current and later playback (PS-06). Pitch is preserved by `SpeedRatio` (PS-07 satisfied; judged by ear with one SAPI voice). |
| D6 | Pause keeps the same audio and the real player position, blocks new audible narrations, disables Repeat and keeps the service enabled (green). OFF stops own synthesis/playback, cancels the queue, deletes the retained audio and position after handles are released, blocks narration and Repeat; ON allows future narrations only (Engram #1695). |

## Spike evidence (muted, scratch directory, not in the repo)

- The Dispatcher must be pumped or `MediaOpened`/`MediaEnded` never fire and `Pause()` is unreliable.
- `SpeedRatio` changes live and tracks 0.25-8 (clamps above 8); `Close()` resets it to 1.0, so reapply after each `Open()`. Same-URI `Open()` without `Close()` fires no `MediaOpened`.
- `Pause()` held `Position` within ~25 ms over 1.5 s; `Play()` resumed in place. Position slope 1.000 at 1.0x (max 1 ms deviation), 1.98-1.994 at 2.0x (max ~59 ms).
- Open to `MediaOpened` took 30-125 ms. Exclusive file access returns only after `Close()`, not `Stop()`; delete/rename work while open.
- `powershell.exe -STA` child: `ready` ~240 ms, ~15 ms command round trip, clean exit on `quit`, stdin close and parent kill. `pwsh` was slower (`ready` ~484 ms).
- One replay of the same file took 293 ms instead of ~77 ms, unexplained.

## Constraints

- Windows-only backend behind a small `Player` interface; the audio failure path must never block OpenCode or the written reply (RNF-04). If the player host cannot start, fall back to the existing `SoundPlayer` path.
- No new dependencies, downloads or installs. No audible audio in automated tests.
- Preserve Repeat exact-audio behavior, session/instance ownership and cache cleanup, and the existing TUI polish.
- Technical artifacts in English. Planning heuristic: about 400 authored changed lines per task; not a cap.

## Tasks

- [x] **P1 - Persistent controllable player, behavior-preserving.** New `Player` abstraction and persistent `powershell.exe -STA` host (play, pause, resume, rate, position, stop, dispose) that replaces `playWav` in the cached sink path with the old `SoundPlayer` path as fallback. No user-visible behavior change: Pause still stops, no new UI.
- [ ] **P2 - Per-instance runtime state and control channel.** In-memory pause/enabled/playbackSpeed per plugin instance; extend the `status` event and add control command kinds; remove `paused` from `config.json` and the CLI `pause`/`resume`/`toggle`.
- [ ] **P3 - Real Pause/Resume (PC-01) and service On/Off (PC-02).** Player pause/resume wired through the sink, `AudioCache.clear()`, TUI green/red icon next to the title, Repeat disabled while paused.
- [ ] **P4 - Playback speed button (PS-01..PS-11).** Cycle button with confirmed state, rate reapplied after each `Open()`, applies live to current and later playback, separate from synthesis speed.
- [ ] **P5 - Documentation sync.** README, `odd/tasks/playback-speed.md`; Obsidian notes are updated by the parent.

## Route declaration and delivery

- Route: delegated direct, one writer per task; the parent reads back results and spot-checks. Trigger: 2+ non-trivial source files per task plus preparation reading.
- Test-first policy: default applicable (Bun tests with injected fake processes; no real audio). Runner: `bun test`; typecheck: `node ./node_modules/typescript/bin/tsc --noEmit`. Baseline before the feature: 201 pass, 0 fail, tsc exit 0.
- Forecast: roughly 1,300 authored changed lines across P1-P5 (P1 ~350, P2 ~250, P3 ~450, P4 ~200, P5 ~100), above the ~400 line heuristic. Delivery strategy defaults to `ask-on-risk`; the chain strategy is asked once before the first commit.
- Delivery: user chose `chain_strategy = feature-branch-chain` (2026-10-11). Tracker branch `feat/playback-controls` (draft/no-merge tracker PR holds only this document). Child branches: `feat/playback-controls-p1-player` targets the tracker; each later child (`-p2-state`, `-p3-controls`, `-p4-speed`, `-p5-docs`) targets the immediately previous child branch. Only the tracker merges to `main`, after all children are reviewed and integrated. Push, PR creation and merge stay the user's decisions. Do not mix chain strategies. Review budget per slice is ~400 changed lines; P1 is ~1,350 because the player host and its tests are one cohesive unit, so recommend a maintainer `size:exception` for that slice rather than shrinking it.
- Out of scope here: PN, CN, `open-vox say` one-shot inline playback in `piper-engine.ts` (kept as is).

## Progress log

- 2026-10-11: feature document created on branch `feat/playback-controls` from `main` at `5fe4faf`; no source written yet.
- 2026-10-11: P1 verified by the parent (own `bun test`: 246 pass, 1 skip, 0 fail; `tsc` exit 0; no leftover `player.ps1` process; diff read back for `plugin.ts`/`speech-sink.ts`). P1 actually changed ~1,350 authored lines (mostly `player.ts` 542, `player.test.ts` 596, `player.ps1` 115), well above the forecast; no audible check yet. P1 summary: `src/player.ts` + `scripts/player.ps1` persistent muted-testable `MediaPlayer` host with pause/resume/rate/position, lazy start, idle shutdown, duration watchdog and SoundPlayer fallback; wired into the cached sink path (`playbackTimeoutMs`) and plugin dispose; `bun test` 246 pass/1 skip (opt-in real-host smoke), tsc exit 0.

- 2026-10-11: P1 committed as `03a13e8` (`feat(player): add persistent controllable MediaPlayer host for cached playback`) on `feat/playback-controls-p1-player`, on top of tracker commit `a517ec4`. Native assessment against `main`: risk **high** (`process_boundary`, `src/player.ts`), 9 paths / 1,422 lines, review due. The user declined native review for this exact candidate (`declined_this_candidate`; no review record, RDD stays on). Recommend a `size:exception` for this slice. A concurrent uncommitted change to `src/repeat-ui.ts` / `test/repeat-ui.test.ts` and an untracked `odd/tasks/repeat-renewal.md` (not part of this feature) exist in the working tree and are excluded from every commit here.

## Next step

Resolve the overlap with the concurrent `repeat-renewal` change in `src/repeat-ui.ts` (P2 must edit that file), then start P2 on `feat/playback-controls-p2-state` branched from `feat/playback-controls-p1-player`.
