# Bootstrap a silent, typed agentVoz selection boundary

Status: silent implementation locally verified, 2026-10-09; delivery remains partial/pending parent review and commit authorization. Intermediate failing commands are retained below. No activation, audio execution, or real lifecycle capture has occurred.

## Objective and problem

Implement one coherent first slice: a typed OpenCode plugin skeleton and a conservative pure final-response selector, verified with fake client/sink integration. Idle and completed messages alone do not prove a successful user-facing final answer. The eventual product is Windows-first, local-only, with automatic Spanish/English detection; speech remains outside this slice.

## Scope and constraints

- Authorized surface: `package.json`, `bun.lock`, `tsconfig.json`, `.gitignore`, `README.md`, `src/plugin.ts`, `src/final-response.ts`, `test/final-response.test.ts`, `test/plugin.test.ts`, `odd/tasks/bootstrap.md`, and generated `node_modules/**`. All source/config/docs are authored with apply_patch.
- Local development provisioning authorized: one `bun install --ignore-scripts`, generating only the lockfile and node_modules. No voice execution, TTS selection, model downloads, audio/hardware checks, global installs/changes, user plugin activation, staging, commits, pushes, PRs, Git configuration changes, or child agents. Sherpa-onnx is prohibited, including trials.
- Keep `C:\Users\pc\Documents\Obsidian Vault\01-Projects\agentVoz\Sprints.md` read-only. Sprint 0 remains incomplete: lifecycle traces and host/model qualification are not captured.
- Artifact language: English. Skill resolution: `paths-injected`; context7, work-unit-commits, and cognitive-doc-design were read from the explicitly supplied paths. No explicit model override: runtime default.
- `delivery_strategy: ask-on-risk`. Measured authored surface: 600 current lines, comprising 486 new handwritten lines and this 114-line updated tracking document (originally 95 lines); net handwritten growth is 505 lines. Generated lockfile/dependencies are excluded. Original 300-390-line estimate was exceeded by the complete test matrix and documentation. The 400-line budget is advisory; no checks or readability were removed to fit it. Parent owns review and any coherent split decision.
- Routing: one delegated writer, no children. RDD is globally enabled; parent owns review authority, gates, capture, and code-root risk assessment. No worker review PASS is asserted. Commit: pending/not requested; no commit authority is implied by ODD conventions.

## Stable checklist

- [ ] **T1 — Environment and contracts.** Preparation evidence below is complete; real success/tool/error/abort/compaction/child lifecycle traces remain pending under separate authorization.
- [x] **T2 — Typed plugin and pure selector.** Deterministic tests and typed inert stubs preceded implementation. Production sink stays inert; source remains outside activation directories.
- [x] **T3 — Unit and mock integration verification.** Behavioral RED and final GREEN/typecheck are recorded below; fake clients/sinks only.
- [ ] **T4 — Sync documented status and delivery.** File updated; full memory mirror/readback required. Parent review and commit remain pending/not requested.

## Observed environment

`Test-Path -LiteralPath "C:\Users\pc\Documents"` returned `True` before directory effects. Each version command ran only after `Get-Command` resolved the installed executable/wrapper.

| Tool | Exact observed output |
| --- | --- |
| OpenCode | `1.18.35` |
| Bun | `1.3.14` |
| Node | `v24.19.0` |
| npm | `11.17.0` |
| Git | `git version 2.55.0.windows.3` |
| gentle-ai | `gentle-ai 4.0.0` |

Bun's runner and the project-local TypeScript compiler were executed in this unit. Exact pinned development dependencies were provisioned with scripts disabled. No CodeGraph mapping existed at entry for this source-free project; no index was initialized or borrowed.

## Verified package and API contract

Context7 was consulted first; version-pinned published declarations and release source, not current development snippets, establish the following contract.

- Pin `@opencode-ai/plugin` and `@opencode-ai/sdk` to `1.18.35`. Registry metadata confirms both releases and the plugin's exact SDK dependency. Installed development pins: `typescript@5.8.2`, `bun-types@1.3.14`, `@types/node@24.12.2`. Local installed root declarations confirmed message, event, session, and plugin shapes. These are type-only imports; no new runtime dependency is invoked by the source.
- Use the legacy root exports consistently: `Plugin` from `@opencode-ai/plugin`; `Message`, `Part`, `Session`, and `Event` from `@opencode-ai/sdk`. The root plugin's injected client is the root SDK client, not `/v2`. Avoid mixing flattened v2 arguments with this v1 client.
- `Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>`; `Hooks.event?: (input: { event: Event }) => Promise<void>`. The release loader creates the root SDK client and dispatches event hooks with `void`, without awaiting them: catch all asynchronous failures internally and serialize/guard same-message work.
- `client.session.get({ path: { id: sessionID }, query: { directory } })` returns a fields-style result with `data: Session` on success. `client.session.message({ path: { id: sessionID, messageID }, query: { directory } })` returns `data: { info: Message, parts: Part[] }` on success. Default `throwOnError` is false; reject error/missing-data results and catch thrown failures too.
- Root `EventMessageUpdated` declares `type: "message.updated"`, `properties: { info: Message }`. Derive identifiers from `info.id` and `info.sessionID`; do not require v2-only event fields. The runtime forwards bus data, so unknown or inconsistent data must fail closed.
- Root `AssistantMessage` has `role: "assistant"`, `time.created`, optional `time.completed`, optional `error`, required message `parentID`, optional boolean `summary`, and optional string `finish`. Message `parentID` denotes message lineage; session `parentID` denotes a child session. Session `summary` is a diff object, not the assistant compaction flag.
- `TextPart` has text and optional `synthetic`/`ignored`; `ReasoningPart`, `ToolPart`, and `CompactionPart` are separate discriminants. Release processor source writes completion even during cleanup and assigns provider finish reasons. Error/abort paths publish errors and set idle; prompt source writes `finish: "tool-calls"` with completion. Therefore neither completion nor idle alone is an eligibility signal.
- Contract policy for the first slice: accept only explicit `finish === "stop"`, finite completion, no error, no assistant summary, validated root session and parent-user lineage, and nonempty permitted text. Other finish values fail closed even when the runtime might treat them as terminal. Static declarations do not prove turn ordering or real finality; activation stays blocked pending traces.

## Selector and mock verification requirements

1. Observe fresh user lineage after initialization; never enumerate/play historical startup messages. Old/completed-only events, reloads without fresh lineage, and synthetic or compaction parent turns are rejected. Fetch only specific event-referenced messages/session/parent; never use history as a playback queue.
2. Reject idle-only events, errors/aborts, incomplete or unknown finishes, tool-only responses, child sessions, compaction/summary turns, user messages, reasoning-only content, empty text, and synthetic/ignored text. Mixed eligible text may exclude reasoning rather than narrate it; compaction indicators reject the whole candidate. Validate session/message/part/parent identifier consistency; malformed or unknown states fail closed.
3. Deduplicate by `(sessionID, messageID)` across repeated and concurrent events; guard in-flight work before awaits. Invalidate stale work on errors, new turns, or disposal. Out-of-order fixtures must not silently broaden eligibility.
4. Use an injected fake client and inert fake sink. Cover SDK returned errors/missing data, thrown fetch failures, sink rejection, duplicate/out-of-order delivery, session separation, and no startup playback. Errors must not escape hooks or become unhandled rejections; no audio, shell execution, or network calls in tests.

## Authorized implementation and verification evidence

The authorized filenames are listed above. Keep source outside `.opencode/plugins`; no OpenCode activation/configuration file was added. Package scripts are `test: bun test` and `typecheck: tsc --noEmit`. TypeScript uses strict/noEmit, ESNext/Bundler resolution, and explicit `bun-types`/Node types.

Commands ran foreground from `C:\Users\pc\Documents\agentVoz`:

| Phase | Exact command | Actual result |
| --- | --- | --- |
| Entry | `git status --short --branch` | No commits on `feat/bootstrap`; only `odd/` untracked. |
| Provision + RED | `Test-Path -LiteralPath "C:\Users\pc\Documents\agentVoz" && bun install --ignore-scripts && bun test` | Parent exists; 31 packages installed, scripts disabled; 35 pass, 4 fail, 47 assertions, 39 tests. Failures were eligible prose, mixed prose, concurrent independent sessions, and sink attempt. |
| First implementation check | `bun test && node ./node_modules/typescript/bin/tsc --noEmit` | 38 pass, 1 fail: new-turn fixture reused timestamp; compiler not reached. Fixture corrected to later timestamp, preserving conservative ordering policy. |
| Expanded GREEN/compiler check | `bun test && node ./node_modules/typescript/bin/tsc --noEmit` | 57 pass, 0 fail, 77 assertions; compiler failed TS2688 for explicit `bun` type entry. Corrected entry to installed package `bun-types`. |
| Final selector | `bun test ./test/final-response.test.ts` | 34 pass, 0 fail, 34 assertions. |
| Final mock integration | `bun test ./test/plugin.test.ts` | 60 pass, 0 fail, 80 assertions; includes 34 selector tests because shared typed fixture is imported from the selector test module. |
| Final aggregate | `bun test` | 60 pass, 0 fail, 80 assertions across two files. |
| Final compiler | `node ./node_modules/typescript/bin/tsc --noEmit` | Exit 0, no diagnostics. |
| Hygiene | `git diff --check` | Exit 0; files are untracked, so this is not an unstaged-source review. |
| Optional line counter | `rg --count '^' package.json tsconfig.json .gitignore README.md src/plugin.ts src/final-response.ts test/final-response.test.ts test/plugin.test.ts odd/tasks/bootstrap.md` | Unavailable: rg is not installed/resolvable. Line counts obtained from dedicated file read metadata instead. |

```powershell
bun test ./test/final-response.test.ts
bun test ./test/plugin.test.ts
bun test
node ./node_modules/typescript/bin/tsc --noEmit
```

No formatter was introduced. Final source edits precede final verification. The final four commands are rerun after task-document synchronization before parent freeze. Required intermediate failures make the delivery report partial even though final verification is green; no failed command is concealed.

Rollback boundary: remove only this unit's new source/tests/config/README/lockfile/generated dependencies and restore this tracking artifact; preserve `.git`, unrelated files, Obsidian, and user OpenCode configuration. Runtime harness is fake-hook integration (`bun test ./test/plugin.test.ts`); real-host harness is N/A, deliberately unauthorized/unactivated.

### Bounded behavior and remaining uncertainty

The coordinator retains at most 128 session records, 64 user IDs and 256 claimed assistant IDs per session. It never evicts records into a replay window; limit exhaustion and deleted sessions fail closed until recreation. Errors, message removals, newer turns, and explicit disposal invalidate pending fetches. Claims precede awaits and remain consumed after SDK/sink failures. Parent timestamps must match observed user timestamps; non-increasing user timestamps and duplicate user updates do not resurrect old work.

The pure selector rejects compaction, summaries, child/reverting/compacting sessions, invalid completion, unknown finish, synthetic/ignored parent text, unknown part types, and identity inconsistencies. Assistant reasoning/tools/flagged text are excluded from mixed allowed prose. SDK returned errors, missing data, thrown failures, and sink rejection are contained without retries.

Post-initialization observation is not proof of real event freshness: delayed historical user updates may appear fresh. No real-host ordering/finality trace exists. Once a sink has been invoked, coordinator invalidation cannot retract its work; any future audio sink needs cancellation semantics. Default production sink remains inert, and no audio readiness or Sprint 0 completion is claimed.

## Evidence links and persistence

- Plugin metadata: https://registry.npmjs.org/@opencode-ai/plugin/1.18.35
- SDK metadata: https://registry.npmjs.org/@opencode-ai/sdk/1.18.35
- Plugin declaration: https://unpkg.com/@opencode-ai/plugin@1.18.35/dist/index.d.ts
- Root SDK methods: https://unpkg.com/@opencode-ai/sdk@1.18.35/dist/gen/sdk.gen.d.ts
- Root message/event/response types: https://unpkg.com/@opencode-ai/sdk@1.18.35/dist/gen/types.gen.d.ts
- Root response envelope: https://unpkg.com/@opencode-ai/sdk@1.18.35/dist/gen/client/types.gen.d.ts
- Release loader: https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/plugin/index.ts
- Release completion/error paths: https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/session/processor.ts
- Release tool/finish paths: https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/session/prompt.ts
- Bun release runner docs: https://github.com/oven-sh/bun/blob/bun-v1.3.14/docs/test/index.mdx
- Bun types metadata: https://registry.npmjs.org/bun-types/1.3.14

Exact locator: `C:\Users\pc\Documents\agentVoz\odd\tasks\bootstrap.md`. Mirror the full document to Engram project `pc`, topic `odd/agentvoz-bootstrap/tasks`, with `capture_prompt: false`; read back file and complete observation and report the ID. If project validation fails, preserve the file and report mirror pending without guessing another project.

Next task: parent review of this bounded silent unit, followed by separately authorized real-host lifecycle traces (success/tool/error/abort/compaction/reload/child ordering) without assuming activation safety. Commit remains not requested/pending. Reserve model support, language detection, Markdown processing, and audio for subsequent units.
