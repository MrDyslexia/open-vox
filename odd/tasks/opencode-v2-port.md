# OpenCode V2 port

Objective: load and run Open-Vox on OpenCode 2.x (V2 plugin loader) without rewriting the tested coordinator. Branch: `main` (user-directed). Delivery: work-unit commits on main. Runner: `bun test`, `bun run typecheck`.

## Specs

- S1. The server plugin loads on OpenCode 2.x. The V2 loader currently rejects it with: "Plugin must export a default definition with an id and an effect or setup function." It must default-export `{ id, setup }`.
- S2. Narration of the final assistant response keeps working on V2. A thin adapter translates V2 session events and `ctx.session.get`/`ctx.session.context` into the V1 shapes that `createCoordinator` and `final-response.ts` already consume, so their freshness and fail-closed rules stay unchanged.
- S3. The sidebar controls keep working on V2. The V1 `tui.publish` / `tui.command.execute` channel is replaced by a V2 RPC definition: TUI to server is a method call, server to TUI is an RPC event. Encoded command strings are unchanged.
- S4. The TUI plugin default-exports the V2 shape `{ id, setup }` and uses the V2 TUI API (`ui.slot`, `ui.router`, `ui.dialog.select`, `ui.toast.show`, `theme`).
- S5. `open-vox install` writes a layout V2 loads:
  - The server loader in `plugins/open-vox.js`.
  - The TUI as the directory `tui-plugins/open-vox/tui.tsx`, registered in `cli.json` `plugins`.
  - It removes the old single-file TUI and its `tui.json` entry.
  - `uninstall` reverses all of this.
- S6. The V1 `OpenVoxPlugin` export stays available for the CLI and tests.

## Tasks

- T1 [S1,S2,S3,S6] V2 server entry plus adapter (`src/opencode-v2.ts`), shared hook factory in `src/plugin.ts`. Route: inline. Status: done, 8f59ef3.
- T2 [S3,S4] V2 TUI (`tui/open-vox.tsx`). Route: inline. Status: done (code and tests); renderer not observed live.
- T3 [S5] Installer V2 layout plus tests. Route: inline. Status: done.

## Log

- L1 (2026-10-18, user): "actualice opencode y ya no funcionana la mayoria de mis plugins, solucionalo"
- L2 (2026-10-18, user): "si arranca, commitea y pushea, trabaja en la rama main"
- L3 (2026-10-18, user): "primero mergee". The backup branch was merged into main (1c08cbf) and pushed.
- L4: Evidence. OpenCode 2.0.32 log: open-vox.js fails with "Missing key at [default]". V2 TUI loader rejects `{id, tui}` modules ("Invalid V2 TUI plugin module"). Local file targets in `cli.json` are skipped, so a TUI must be a directory containing `tui.*`.
- L5: Verification.
  - `bun run typecheck`: clean.
  - `bun test`: 814 pass, 5 skip, 0 fail.
  - Live, after `open-vox install` and `opencode service restart`, the server log shows `open-vox.js` loading with no "failed to load plugin".
  - A scratch probe using the official V2 client sent a `hello` through `rpc(OPEN_VOX_RPC).command` and received the `status` reply on `rpc.open-vox.command`, with a matching challenge and `enabled: true`.
- L6: Not observed live.
  - Spoken narration of a real assistant turn (S2) is covered only by tests through the unchanged coordinator.
  - The sidebar rendering in the interactive TUI (S4).
  - The user has to confirm both in OpenCode.
- L7: Found during install. OpenCode's V2 migration copied the V1 `tui-plugins\open-vox.tsx` path into `cli.json`. `install` now drops it (regression test added).
