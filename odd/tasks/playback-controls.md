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
- [x] **P2 - Per-instance runtime state and control channel.** In-memory pause/enabled/playbackSpeed per plugin instance; extend the `status` event and add control command kinds; remove `paused` from `config.json` and the CLI `pause`/`resume`/`toggle`.
- [x] **P3a - Real Pause/Resume (PC-01).** Sliced from the original P3 to keep slices cohesive. The sink pauses and resumes the active cached playback through the player (same audio, real position, no restart, no re-synthesis); the sidebar Pause button already exists from P2. Fallback `SoundPlayer` playback keeps the old stop-on-pause behavior. In-flight synthesis and queued jobs are cancelled on Pause (no audio exists yet to hold). A stop caused by a new turn, session error or session deletion while paused discards the paused audio; the instance stays paused until Resume.
- [ ] **P3b - Service On/Off (PC-02).** Control actions `disable`/`enable`, `enabled` in the confirmed status, `AudioCache.clear()` that deletes the retained audio after handles are released, sink gating by a dynamic enabled flag, TUI green/red icon next to the title. OFF also clears Pause (nothing to resume); ON allows future narrations only.
- [ ] **P4 - Playback speed button (PS-01..PS-11).** Cycle button with confirmed state, rate reapplied after each `Open()`, applies live to current and later playback, separate from synthesis speed.
- [ ] **P5 - Documentation sync.** README, `odd/tasks/playback-speed.md`; Obsidian notes are updated by the parent.

## Route declaration and delivery

- Route: delegated direct, one writer per task; the parent reads back results and spot-checks. Trigger: 2+ non-trivial source files per task plus preparation reading.
- Test-first policy: default applicable (Bun tests with injected fake processes; no real audio). Runner: `bun test`; typecheck: `node ./node_modules/typescript/bin/tsc --noEmit`. Baseline before the feature: 201 pass, 0 fail, tsc exit 0.
- Forecast: roughly 1,300 authored changed lines across P1-P5 (P1 ~350, P2 ~250, P3 ~450, P4 ~200, P5 ~100), above the ~400 line heuristic. Delivery strategy defaults to `ask-on-risk`; the chain strategy is asked once before the first commit.
- Delivery: user chose `chain_strategy = feature-branch-chain` (2026-10-11). Tracker branch `feat/playback-controls` (draft/no-merge tracker PR holds only this document). Child branches: `feat/playback-controls-p1-player` targets the tracker; each later child (`-p2-state`, `-p3a-pause`, `-p3b-onoff`, `-p4-speed`, `-p5-docs`) targets the immediately previous child branch. Only the tracker merges to `main`, after all children are reviewed and integrated. Push, PR creation and merge stay the user's decisions. Do not mix chain strategies. Review budget per slice is ~400 changed lines; P1 is ~1,350 because the player host and its tests are one cohesive unit, so recommend a maintainer `size:exception` for that slice rather than shrinking it.
- Out of scope here: PN, CN, `open-vox say` one-shot inline playback in `piper-engine.ts` (kept as is).

## Progress log

- 2026-10-11: feature document created on branch `feat/playback-controls` from `main` at `5fe4faf`; no source written yet.
- 2026-10-11: P1 verified by the parent (own `bun test`: 246 pass, 1 skip, 0 fail; `tsc` exit 0; no leftover `player.ps1` process; diff read back for `plugin.ts`/`speech-sink.ts`). P1 actually changed ~1,350 authored lines (mostly `player.ts` 542, `player.test.ts` 596, `player.ps1` 115), well above the forecast; no audible check yet. P1 summary: `src/player.ts` + `scripts/player.ps1` persistent muted-testable `MediaPlayer` host with pause/resume/rate/position, lazy start, idle shutdown, duration watchdog and SoundPlayer fallback; wired into the cached sink path (`playbackTimeoutMs`) and plugin dispose; `bun test` 246 pass/1 skip (opt-in real-host smoke), tsc exit 0.

- 2026-10-11: P1 committed as `03a13e8` (`feat(player): add persistent controllable MediaPlayer host for cached playback`) on `feat/playback-controls-p1-player`, on top of tracker commit `a517ec4`. Native assessment against `main`: risk **high** (`process_boundary`, `src/player.ts`), 9 paths / 1,422 lines, review due. The user declined native review for this exact candidate (`declined_this_candidate`; no review record, RDD stays on). Recommend a `size:exception` for this slice. A concurrent uncommitted change to `src/repeat-ui.ts` / `test/repeat-ui.test.ts` and an untracked `odd/tasks/repeat-renewal.md` (not part of this feature) exist in the working tree and are excluded from every commit here.
- 2026-10-11: P2 written on `feat/playback-controls-p2-state` (uncommitted, parent verification pending): pause is now per-instance in-memory state (`createPauseState`, one `sink.stop()` on the false->true edge, `watchPause` 250 ms poller removed) driven by a new validated `control` message (`pause`/`resume`, shared 64-entry request history) over the `tui.command.execute` channel; the sidebar Pause button publishes it through the attached client and shows the confirmed `status.paused` (disabled without confirmation); `paused` removed from `config.json`/`Config`, legacy key ignored and CLI `pause`/`resume`/`toggle` removed (now unknown commands); README updated. Renderer and live behavior unverified.
- 2026-10-11: P2 verified by the parent (own `bun test`: 278 pass, 1 skip, 0 fail; `tsc` exit 0; `git diff --check` clean; no production read of `paused` from `config.json`) and committed as `5804e00` on `feat/playback-controls-p2-state`, after `d3f3ff6` (`fix(repeat-ui): keep Repeat available during status renewal`, the separate `repeat-renewal` work committed by the parent at the user's request). Native assessment against `74b9644`: risk **high** (`src/cli.ts` shell_process signal), 14 paths / ~1,000 lines. The user declined native review for this exact candidate again (`declined_this_candidate`). Renderer/live TUI behavior is unverified. The P2 slice is above the ~400-line heuristic because the protocol, TUI, plugin, config, CLI and tests move together; recommend `size:exception`.
- 2026-10-11: P3a written on `feat/playback-controls-p3a-pause` (uncommitted, parent verification pending): real Pause/Resume. The play handle gained optional `pause()`/`resume()` (a pause that arrives before the file opens waits for `opened`; unacknowledged pause/resume or a host crash while paused degrades to stop, never a replay); the sink freezes the active cached playback (job, cache hold and exact position kept; backstop and watchdog off while paused, re-armed on resume; no host idle shutdown) and cancels queued jobs and in-flight synthesis; `stop()` discards a paused playback while the instance stays paused; the SoundPlayer fallback keeps stop-on-pause; the plugin calls `sink.pause()`/`sink.resume()` once per edge. `bun test` 324 pass, 2 skip (opt-in smoke ran: 62 pass in `test/player.test.ts`, muted, no leftover `player.ps1`), `tsc` exit 0; no audible or live-UI check.

## Next step

Start P3a (real Pause/Resume) on `feat/playback-controls-p3a-pause` branched from `feat/playback-controls-p2-state`, then P3b.
