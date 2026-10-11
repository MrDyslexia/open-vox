# Bootstrap a silent, typed agentVoz selection boundary

Historical status (2026-10-09): silent implementation locally verified; delivery was partial/pending parent review and commit authorization. Intermediate failing commands are retained below. No activation, audio execution, or real lifecycle capture had occurred at that point. The opening scope and checklist describe that initial slice, not the current product: see [Outcome: working plugin](#outcome-working-plugin-2026-10-10) and the later [Repeat task](repeat-last-audio.md). Successful Task-tool child coverage, delayed-history freshness and broader host/runtime qualification remain open; whole-project public publication is now authorized but parent delivery is pending.

## Objective and problem

Implement one coherent first slice: a typed OpenCode plugin skeleton and a conservative pure final-response selector, verified with fake client/sink integration. Idle and completed messages alone do not prove a successful user-facing final answer. The eventual product is Windows-first, local-only, with automatic Spanish/English detection; speech remains outside this slice.

## Scope and constraints

- Authorized surface: `package.json`, `bun.lock`, `tsconfig.json`, `.gitignore`, `README.md`, `src/plugin.ts`, `src/final-response.ts`, `test/final-response.test.ts`, `test/plugin.test.ts`, `odd/tasks/bootstrap.md`, and generated `node_modules/**`. All source/config/docs are authored with apply_patch.
- Local development provisioning authorized: one `bun install --ignore-scripts`, generating only the lockfile and node_modules. No voice execution, TTS selection, model downloads, audio/hardware checks, global installs/changes, user plugin activation, staging, commits, pushes, PRs, Git configuration changes, or child agents. Sherpa-onnx is prohibited, including trials.
- Keep the private local sprint notes read-only (not included in this repository). Sprint 0 remains incomplete: lifecycle traces and host/model qualification are not captured in this initial slice.
- Artifact language: English. Skill resolution: `paths-injected`; context7, work-unit-commits, and cognitive-doc-design were read from the explicitly supplied paths. No explicit model override: runtime default.
- `delivery_strategy: ask-on-risk`. Measured authored surface: 600 current lines, comprising 486 new handwritten lines and this 114-line updated tracking document (originally 95 lines); net handwritten growth is 505 lines. Generated lockfile/dependencies are excluded. Original 300-390-line estimate was exceeded by the complete test matrix and documentation. The 400-line budget is advisory; no checks or readability were removed to fit it. Parent owns review and any coherent split decision.
- Routing: one delegated writer, no children. RDD is globally enabled; parent owns review authority, gates, capture, and code-root risk assessment. No worker review PASS is asserted. Commit: pending/not requested; no commit authority is implied by ODD conventions.

## Historical initial-slice checklist

- [ ] **T1 — Environment and contracts.** Preparation evidence below is complete; real success/tool/error/abort/compaction/child lifecycle traces remain pending under separate authorization.
- [x] **T2 — Typed plugin and pure selector.** Deterministic tests and typed inert stubs preceded implementation. Production sink stays inert; source remains outside activation directories.
- [x] **T3 — Unit and mock integration verification.** Behavioral RED and final GREEN/typecheck are recorded below; fake clients/sinks only.
- [ ] **T4 — Sync documented status and delivery.** File updated; full memory mirror/readback required. Parent review and commit remain pending/not requested.

## Observed environment

`Test-Path -LiteralPath "<repository-parent>"` returned `True` before directory effects (personal path replaced for publication). Each version command ran only after `Get-Command` resolved the installed executable/wrapper.

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

Commands ran foreground from the original `agentVoz` repository root (personal path replaced for publication):

| Phase | Exact command | Actual result |
| --- | --- | --- |
| Entry | `git status --short --branch` | No commits on `feat/bootstrap`; only `odd/` untracked. |
| Provision + RED | `Test-Path -LiteralPath "<repository-root>" && bun install --ignore-scripts && bun test` | Parent exists; 31 packages installed, scripts disabled; 35 pass, 4 fail, 47 assertions, 39 tests. Failures were eligible prose, mixed prose, concurrent independent sessions, and sink attempt. |
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

Repository-relative locator: `odd/tasks/bootstrap.md`. Historical mirror instruction named Engram project `pc`, topic `odd/agentvoz-bootstrap/tasks`, with `capture_prompt: false`; current project detection resolves `agentvoz`. This publication update does not guess or migrate that mirror. Preserve the file and report mirror synchronization pending until its existing destination is confirmed.

Next task: parent review of this bounded silent unit, followed by separately authorized real-host lifecycle traces (success/tool/error/abort/compaction/reload/child ordering) without assuming activation safety. Commit remains not requested/pending. Reserve model support, language detection, Markdown processing, and audio for subsequent units.

## Real-host lifecycle traces (opencode 1.18.35, free model, scratch dir, metadata only)

Prior captures used a throwaway event-logging plugin outside this repository; global config was untouched. The initial metadata-only claim needs the nested-summary privacy correction below. `--pure` also disables local plugins, so prior runs used the normal plugin set.

- **Success:** the assistant message.updated with `finish=stop` arrives first WITHOUT `time.completed`, then again with completed set (~0.25 s later), then session.status idle and session.idle. The selector requires both, so it accepts only the second event. Matches the fail-closed policy.
- **Tool turn:** one user turn produces several assistant messages sharing the same parentID. The intermediate one carries `finish=tool-calls` (with completed) and is correctly rejected; the final one carries `finish=stop`.
- **Repeated user message.updated** events occur for the same user ID; the coordinator's dedupe handles them.
- **Error (unknown model):** session.error (UnknownError) then session.idle; no assistant message is ever created, so nothing is selectable.
- **Abort (via local server, session.abort):** session.error (MessageAbortedError), session.idle, THEN a late assistant message.updated with `error` set, completed set and no `finish`. The selector rejects it (error and missing `finish=stop`); session.error also invalidates pending work.
- **Prior pending status:** compaction, reload, and child-session ordering were not qualified when the preceding notes were written. The continuation below supersedes only that trace status; T1 stays open.

### Authorized continuation: single compaction and bounded reload

Status: compaction observed successfully; reload/history fetch observed without historical message re-emission in bounded windows; fresh post-reload turn and prior child turn remain partial because both failed with `APIError`. No activation or audio readiness is established. Older document status/checklists and README describe the earlier silent slice and are not a claim that this continuation never occurred.

- **Logging limitation and privacy correction:** `.opencode/plugins/trace.js:19` copies `info.summary` verbatim. User summaries can contain diff patch strings, as preserved in `child.jsonl:96,115,130`; therefore the earlier claim of strictly metadata-only logging is too broad. Existing evidence was preserved, not sanitized or overwritten. The logger excludes text parts/deltas directly, but does not whitelist nested summary objects, record tool names/state, model identity, synthetic/ignored flags, error detail, or lifecycle disposal; write failures are silently swallowed. No eligibility of message text can be proven from these traces.
- **Continuation collection:** left the logger unchanged and unset `AGENTVOZ_TRACE_FILE` in the owned server processes. A foreground, bounded Node observer subscribed to loopback `/event`, discarded deltas, retained only explicit scalar metadata, and omitted object summaries as `summaryKind: "object-omitted"`. HTTP session/message bodies were inspected in memory and never retained as plaintext output. New JSONL files are explicitly selected metadata excerpts, not complete streams or plugin-hook traces. SSE reception timing does not prove plugin delivery ordering. Existing normal host plugins remained present; no production agentVoz activation occurred.
- **Pinned API:** Context7 first, then `v1.18.35/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` (`SummarizePayload`, `SessionPaths.summarize`) and `handlers/session.ts` (`summarize`), plus local root SDK `dist/gen/types.gen.d.ts:2175-2208`. Request: `POST /session/ses_edcc220aaffefZBensERWpdzyy/summarize?directory=<scratch>` with `{ "providerID": "opencode", "modelID": "big-pickle", "auto": false }`. Root SDK declaration omits `auto`; the pinned runtime accepts it and defaults false. Handler creates compaction then awaits the prompt loop. Initial guessed old release route URL returned 404; the pinned current release paths above resolved before invocation.
- **Compaction (one attempt):** HTTP 200 / `true`; user marker `msg_12350bcb5001YSXn4CpXU1Be7d` with a compaction part, followed by assistant `msg_12350bd11001XErSj2Jm5trBeL` (`summary: true`, observed `opencode/big-pickle`). `finish: "stop"` arrived before completion, then completion `1791593869929`, then `session.compacted` and idle. This is a summary, not an eligible ordinary final answer. `auto: false` avoided automatic continuation; no retry or alternative model selection occurred.
- **Reload:** stopped the first owned server, verified port down, then restarted the shim and subscribed before read-only GETs of the exact existing session and `/message`. Three seconds after subscription showed only `server.connected`; explicit GETs returned HTTP 200 and six historical messages (four prior messages plus the compaction pair), with no historical user/assistant events re-emitted through GETs and the subsequent five-second window. This is bounded negative evidence, not a universal guarantee against delayed historical events.
- **Fresh-turn control:** a single tools-disabled prompt on the same session emitted fresh user `msg_12351bd26001KNik9KdUV57yQa` and assistant `msg_12351bd7b0014ZPrACPUGB2Lg8`. It failed `APIError`: error/idle preceded the completed errored assistant update, with no finish. HTTP 200 for that prompt did not mean model success. This proves later SSE message coverage, not successful post-reload final-answer coverage. No retry, delegation, or model switching followed.
- **Prior child result clarified:** `child.jsonl:66,68-85` shows child session `ses_edcc204e7ffe6HDhjgoC4wwqB7` with session `parentID` equal to the scratch parent, child user and assistant lineage, then `APIError`/idle and a completed errored assistant without finish. Parent `finish: "stop"` at `child.jsonl:122,124` does not establish successful child coverage. No new child was launched.
- **Ownership, bounds, and cleanup:** launched `pwsh -NoProfile -File <user-home>/.gentle-ai/bin/opencode.ps1 serve --hostname 127.0.0.1 --port 47214` from scratch (personal path replaced for publication). Checked free port before each launch, validated health version `1.18.35`, and matched the listener to the launcher ancestry using PID and creation time. Runtime-only configuration pinned main/small models to the authorized model and denied all permissions; no global config changed. Readiness: 30 s; ordinary HTTP: 10 s; summarize: 75 s; fresh turn: 60 s; outer commands: 240/150 s. First listener PID 4504 was stopped; a launcher-exit race caused the initial command's cleanup to return status 1 before reload, and its finally block confirmed port down. All three first-launch PIDs were absent before the separate reload command. Final listener PID 11196 was stopped exactly; launcher ancestors 23712/25380 had already exited. Final observation: `remainingOwned: []`, `portDown: true`. No broad command-line killing occurred.

Evidence base: `<scratch-root>/agentvoz-trace` (local-only captures, not included in this repository).

| Locator | Evidence |
| --- | --- |
| `compaction-continuation.jsonl:1-22` | Collection boundary, ownership, single summarize attempt, summary/completion/compacted events, first cleanup failure and port-down result. |
| `reload-continuation.jsonl:1-25` | Restart ownership, startup window, explicit historical GETs and six-message metadata, fresh error control, final exact cleanup. |
| `child.jsonl:66-85,122-124` | Child parent-session lineage and failed child response, distinguished from successful parent final. |
| `.opencode/plugins/trace.js:5-34`; `child.jsonl:96,115,130` | Actual logger fields and nested summary patch retention limitation. |

Verification: documentation-only structural readback; no source/product writes or tests required. Initial git status was `M odd/tasks/bootstrap.md` and `?? .atl/`; existing edits and untracked content were preserved. Only this existing trace section was updated in the repository; scratch evidence files were added, with no staging or commit. Skill resolution: `paths-injected` (`<skills-root>/context7/SKILL.md`; `<skills-root>/cognitive-doc-design/SKILL.md`). Engram discovery save for project `agentvoz`, without session ID, failed: `gentle-engram could not resolve an authoritative OpenCode runtime session for engram_mem_save`; no retry.

Roadmap: silent selector/plugin and fake-client verification remain completed (T2/T3). T1 remains open for successful child and post-reload final coverage, hook-level freshness qualification, and corrected privacy-safe full capture under new authorization; T4 review/document-status reconciliation remains pending. Language detection, Markdown processing, host/model qualification, and speech execution remain later units. No audio, model downloads, credentials inspection, ambient remote sessions, or scope expansion occurred.

### Next T1 direct-hook qualification: setup blocked before model prompts

Status: **blocked/partial, T1 remains open**. Neither successful-response goal was reached; zero model prompts were issued out of the two-prompt budget. No retry, alternative model, Task delegation, product sink invocation, audio, or product implementation occurred. This run adds direct hook evidence only for initialization, the synthetic user seed, and child-session creation; it does not establish successful child completion, post-reload finality, or delayed-history freshness.

- **Pinned setup checks:** Context7 preceded release source checks at `v1.18.35/packages/core/src/v1/config/{config,agent}.ts`, `packages/opencode/src/{agent/agent,plugin/index,session/session,session/prompt,session/llm,session/processor}.ts`. The runtime accepts configured agent model/mode/steps/disable/permission, session-create `parentID`/agent/permission, explicit prompt model, and `noReply`. Runtime model selection prioritizes the explicit prompt model; configured agent models are parsed separately. The release loader calls event hooks without awaiting them. The new logger writes synchronously before any await inside its event hook. No SDK/config option was introduced to claim provider retries are disabled; the logger requests abort on a retry status or unexpected assistant model, but that control was not exercised.
- **Authorized scratch files:** added only `.opencode/plugins/t1-safe-trace.js`, `opencode.json`, and new `t1-qualification-*.jsonl` files. Scratch `opencode.json` did not exist before creation. Main/small model and both new `t1-parent`/`t1-child` agent models are explicitly `opencode/big-pickle`; enabled provider is only `opencode`; all agent/session permissions deny tools; each agent has one step. Title/summary/compaction agents and automatic compaction are disabled. First-server `/agent` and `/config` readback verified those effective constraints. No global/user configuration or configured plugin list was edited. Existing normal plugins remain a limitation; this was not an isolated host-plugin experiment.
- **Direct logger boundary:** exclusive file creation, init marker before observations, contiguous sequence numbers, 512-record cap with a terminal limit marker, 128-user cap, four tracked-session cap, scalar identifier/enum/number/boolean whitelist, boolean-only summary plus scalar kind, and error-presence/kind only. All object summary/error values, content, tool input/output/state, and deltas are omitted. Write/create errors emit fixed scalar metadata to stderr rather than silently succeeding. `AGENTVOZ_TRACE_FILE` was unset in both launched processes; the old logger was unchanged. No coordinator or sink was wrapped or invoked. Temporal `created-after-init` classification is not proof of semantic freshness; known historical IDs are intended to have priority.
- **Synthetic child scenario:** created parent `ses_edc5daf80ffe5xQBvccB6YjFUT` and one `noReply: true` user seed (`msg_123a250a1001cxr7R1OjnPhdxm`), then created child `ses_edc5daf1bffeMQUAzdglm9oQaK` with the parent session ID. Direct `session.created` hook sequence 8 captured both `parentID` and `sessionParent`. This is API-created synthetic child lineage, not Task-tool invocation coverage. The harness incorrectly requested `/tool/ids` while preparing a tools-disabled prompt and failed JSON parsing (`SyntaxError`) before model invocation. No response status/body was retained for that failed request. The installed pinned SDK subsequently confirmed the correct route is `/experimental/tool/ids` (`dist/gen/types.gen.d.ts:1705-1711`). The affected scenario stopped without retry. Counts: one newly created user ID/event, zero historical user events, zero repeated fresh-user events, no assistant response.
- **Reload scenario:** restarted after exact cleanup, with the new parent session ID provided to the logger. The logger wrote only its init marker and awaited `client.session.messages` during plugin initialization; baseline-ready/hook-ready never appeared. The foreground `/agent` request timed out at 30 seconds. This suggests an initialization self-call dependency but does not establish the full root cause. The scenario stopped before explicit external history GETs, fresh prompt, or a meaningful hook-observation window. **Do not describe this timeout as historical-event silence or reload qualification.**
- **Bounded privacy checks:** synthetic adversarial summary/error/text/part/status payloads produced zero retained forbidden payloads or nested object values; 512 records had contiguous sequences and the terminal record-limit marker. Live child capture had eight scalar records, init first, hook ready, no write errors or limit hit. Reload capture had one scalar init record, no ready marker. This is bounded harness validation, not product tests or selector playback proof. The Node privacy check emitted a module-type warning; no package configuration was changed to suppress it.
- **Final validation caveat:** the conservative key-name check passed the three hook/synthetic captures but reported failure for the control excerpt because two rows use scalar `error` name fields. A targeted type/value inspection confirmed they contain only `SyntaxError` and `TimeoutError`, with no nested values or content keys. Both the initial failure and metadata-only classification are preserved in `t1-qualification-validation.jsonl:1-5`; no evidence was rewritten to hide the failure.
- **Ownership and preservation:** both `pwsh -NoProfile -File <user-home>/.gentle-ai/bin/opencode.ps1 serve --hostname 127.0.0.1 --port 47214` launches were preceded by a free-port check and followed by version/ancestry checks (personal path replaced for publication). Listener PID 25036 belonged to shim 16236 via 17344; reload listener 7040 belonged to shim 8504 via 23428. Cleanup rechecked exact PID/creation-time identity, stopped listeners, observed already-exited ancestors, and verified no remaining owned processes plus port down after each server. Readiness was capped at 30 s, ordinary HTTP at 10 s, `/agent` at 30 s, unused model-prompt timeout at 75 s, and hook settle at at most 5 s; outer command bound 300 s. Nine prior evidence/logger/session-marker files had unchanged SHA-256 hashes, including contaminated originals. No source/diff/message text was printed by the control harness.

Evidence base remains `<scratch-root>/agentvoz-trace` (local-only captures, not included in this repository):

| Locator | Evidence |
| --- | --- |
| `t1-qualification-child.jsonl:1-8` | Direct init/readiness, seed user event, and child parent-session lineage; no successful child response. |
| `t1-qualification-reload.jsonl:1` | Init-only capture; reload hook readiness not reached. |
| `t1-qualification-privacy.jsonl:1-512` | Synthetic-only scalar privacy and record-limit check; not real-host response evidence. |
| `t1-qualification-control.jsonl:1-31` | Selected setup/config results, route failure, timeout, ownership, privacy checks, preservation, and zero-prompt budget. |
| `t1-qualification-validation.jsonl:1-5` | Final capture checks and the control excerpt's conservative key-check failure/type-value clarification. |
| `.opencode/plugins/t1-safe-trace.js`; `opencode.json` | Scratch-only logger and explicit agent/model/permission boundary. |

Next step requires a separately authorized bounded correction, not a retry-until-clean loop: use the pinned tool route, move baseline collection outside plugin initialization (or supply verified historical IDs before restart), establish hook readiness, and then attempt each remaining response goal once. Investigate retry-stop timing before claiming a strict provider-invocation count. Delayed historical-event freshness still needs qualification; bounded silence alone cannot complete T1. T2/T3 remain unchanged, T4 review/status reconciliation remains pending, and speech/language/Markdown implementation remains out of scope.

Documentation verification uses structural readback and `git diff --check`, with no product tests required. Repository edits are limited to this existing trace section; starting status was `M odd/tasks/bootstrap.md` and `?? .atl/`. Skill resolution: `paths-injected`, using `<skills-root>/context7/SKILL.md` and `<skills-root>/cognitive-doc-design/SKILL.md`. The discovery save to Engram project `agentvoz` without session ID failed because no authoritative OpenCode runtime session could be resolved; no retry.

### Authorized bounded correction: readiness restored, both response tests failed

Status: **correction verified; response qualification failed/partial; T1 remains open**. Exactly one API-created child prompt and one independent fresh post-reload prompt were issued. Both returned HTTP 200 with assistant `APIError`, completion set, and no finish. No successful ordinary final or child response was observed. Each affected scenario stopped without another prompt, model switch, or Task-tool invocation. Earlier setup failures and captures remain intact.

- **Minimal harness correction:** before-edit hashes and dedicated full-file reads are recorded in `t1-correction-before.jsonl`; no product bytes were copied. The logger now consumes only validated comma-separated historical user IDs from `AGENTVOZ_T1_HISTORICAL_IDS`, supplied after an external parent-history GET and before restart. Initialization performs no HTTP/self-fetch. Historical IDs outrank timestamps. Abort requests are deduplicated per session and use a 10-second SDK request signal. Scratch `opencode.json` was read but unchanged. Context7 preceded the abort-options check against installed `1.18.35` SDK `dist/gen/client/types.gen.d.ts:6,47-50,119` (`RequestInit`/signal) and tool route `dist/gen/types.gen.d.ts:1705-1726`. Tool discovery was corrected to `GET /experimental/tool/ids?directory=<scratch>` and returned HTTP 200 JSON on both servers.
- **Pre-invocation checks:** `/agent` and `/config` returned within the 10-second ordinary HTTP cap on both servers. Both explicit primary/child models, modes, deny-all permissions, one-step limits, provider restriction, main/small model pins, disabled auxiliary agents, and disabled automatic compaction were verified. Direct hook init/readiness markers preceded observations (child sequences 1/2; reload sequences 1/4). The old logger environment was unset. All 15 discovered tool IDs were disabled in each prompt in addition to deny-all permissions. Existing normal plugins remained present and unchanged; no product coordinator/sink integration was invoked.
- **Synthetic privacy/bounds validation:** no initialization self-fetch occurred. An adversarial known historical ID with a future timestamp was still classified historical; two fresh updates counted one user plus one repetition. Summary/error/text/part/retry payloads retained no forbidden content or nested values. Contiguous sequence numbers ended at the 512-record limit marker. Duplicate synthetic retry statuses produced one mock abort request with a bounded signal. Malformed baseline input produced init then baseline-error, without hook-ready. These are synthetic harness checks, not live provider-attempt or product playback proof. The unchanged Node module-type warning was retained; no package edits suppressed it.
- **Child response test:** new parent `ses_edc2a8affffeXWP3CIkxLh8QJs`, `noReply` seed `msg_123d57524001YAQ06x8T9gYKAh`, and child `ses_edc2a8a88ffeOq6P5Zp8V5tL3H`. Direct child session creation at sequence 8 records parent session lineage. Child assistant `msg_123d575ad001er3udnUI2ha43t` has user-message parent `msg_123d57598001O7td5CMVEUcCQo`, observed authorized model, error/idle at sequences 18-20, then completed errored update at sequence 21 without finish. No eligible final was captured. Child-file totals: two newly created users/events (parent seed plus child prompt), zero historical/repeated user events, 23 records. This is API-created child-session coverage, **not successful Task-tool child coverage**.
- **Reload/fresh response test:** fetched the parent history externally before restart and supplied its single user ID as baseline metadata. Restarted hook recorded init, baseline ID, baseline-ready, then hook-ready without the former timeout. A 3-second post-readiness startup window, exact session/history GETs (one historical user message), and 5-second post-fetch settle emitted zero historical message events. A later fresh user `msg_123d5cbaf00164UU9DarZOXmT0` was captured at sequence 5; assistant `msg_123d5cc14001ba2KvNlZBrdfNs` at sequence 10 used the authorized model. Error/idle sequences 13-15 preceded completed errored assistant sequence 16, again without finish. Totals: one fresh user/event, zero historical/repeated user events, 18 records. This proves bounded direct-hook observation, not universal immunity to delayed historical updates or successful post-reload finality.
- **Failure and retry limits:** both prompt bodies explicitly selected `opencode/big-pickle`; neither HTTP response was treated as successful merely because its status was 200. The logger retained only error presence/kind, while the control excerpt retained the whitelisted scalar name `APIError`, never error messages or objects. No live retry status, abort request, unexpected model, write failure, or record-limit hit was observed. The mock abort test does not prove live abort timing; two HTTP prompts do **not** establish a bound on internal provider attempts. No credentials or detailed provider error bodies were inspected, so the API failure cause remains unqualified.
- **Cleanup/preservation:** both launches used `pwsh -NoProfile -File <user-home>/.gentle-ai/bin/opencode.ps1 serve --hostname 127.0.0.1 --port 47214` after a free-port check (personal path replaced for publication). Version `1.18.35`, listener ancestry, and creation-time identity were checked. First listener 1092 belonged to shim 23796 via 18060; reload listener 22720 belonged to shim 22348 via 24176. Exact listeners stopped; ancestors were observed already exited. Finally confirmed no remaining owned processes and port down. Bounds: readiness 30 s, ordinary HTTP 10 s, prompt 75 s, hook settle 3/5 s, foreground outer command 260 s. Fifteen earlier captures/config/logger/session-marker files retained unchanged SHA-256 hashes; prior contaminated evidence was not overwritten.

Evidence base: `<scratch-root>/agentvoz-trace` (local-only captures, not included in this repository).

| Locator | Evidence |
| --- | --- |
| `t1-correction-before.jsonl:1-2` | Pre-edit logger/config hashes and dedicated read evidence; config unchanged. |
| `t1-correction-child.jsonl:1-23` | Direct readiness, child session lineage, failed response ordering, scalar counters. |
| `t1-correction-reload.jsonl:1-18` | External-baseline readiness and failed fresh-response ordering. |
| `t1-correction-privacy.jsonl:1-512`; `t1-correction-invalid-baseline.jsonl:1-2` | Synthetic privacy, historical precedence, deduplicated abort, recording bound, fail-closed baseline. |
| `t1-correction-control.jsonl:1-38` | Selected scalar command/results, HTTP error classification, bounded windows, ownership, cleanup, and preservation. |

Task decision: T1 remains incomplete for successful child/fresh post-reload final responses, delayed-historical freshness, and successful Task-tool child qualification. The initialization/route blockers are corrected, not the observed API errors. Any next diagnostic or new invocation requires separate scope/authorization; no retry is scheduled. T2/T3 remain unchanged and T4 review/status reconciliation remains pending. Product/audio/language/Markdown work remains outside this experiment.

Verification: task-section structural readback and `git diff --check`; product tests unnecessary because product source was unchanged. Harness metadata privacy/sequence/limit checks ran. Starting git status remained `M odd/tasks/bootstrap.md` and `?? .atl/`; only this existing trace section changed in the repository. Skill resolution: `paths-injected` using the supplied context7 and cognitive-doc-design skill paths. Engram discovery save for project `agentvoz` without a session ID failed because no authoritative OpenCode runtime session could be resolved; no retry.

### APIError root-cause check (harness, not host)

Re-running with the scratch `opencode.json` produced `OpenCode's free tier can only be used from within OpenCode` for `opencode/big-pickle`. With that file moved aside, the same prompt returned a normal reply. Individually applied via `OPENCODE_CONFIG_CONTENT`, these all succeeded: provider/model pinning, custom agent prompt, deny-all permission, `steps: 1`, and disabled auxiliary agents. The rejection therefore comes from the full scratch config combination (unisolated remaining candidates: `snapshot`/`share`/`autoupdate`/`compaction` keys, the long custom prompt, or a combination). The earlier `APIError` results for child and post-reload turns are explained by this harness config and are NOT host behavior. Next step: rerun child and post-reload turns WITHOUT the restrictive config (direct-hook logger only). T1 stays open. Scratch config was restored unchanged.

## Outcome: working plugin (2026-10-10)

Scope was expanded by the user ("do not stop until the plugin works"). Delivered in commits b915eb2 and 414d32c plus README:

- `src/speech-text.ts`: Markdown stripping and ES/EN heuristic detection (17 tests).
- `src/speech-sink.ts`: Windows SAPI via one PowerShell process per message, text over stdin, serial queue (max 2 pending), timeout, stop/cancel, contained errors (10 tests).
- `src/plugin.ts`: sink wired in; a NEW user turn or `session.error` stops speech; repeated updates of the same user message do not. `AGENTVOZ_DISABLED=1` mutes, `AGENTVOZ_LOG=<file>` writes diagnostics.
- **Real bug found only by the live run:** the host attaches `summary: { diffs: [] }` to user messages after a turn, and the selector rejected any user summary, so no real answer was ever selectable. Fixed with RED/GREEN tests.
- Live verification: server-mode run launched the SAPI process and logged selection with no speech error; the globally installed loader (`~/.config/opencode/plugins/agentvoz.js`) also loaded and selected in `opencode run`. Audio output itself was not heard by the agent.
- The earlier APIError in T1 child/reload runs came from the restrictive scratch config, not the host.

Suite: 93 tests pass, typecheck clean. Still open: real Task-tool child success trace, delayed-history freshness proof, listening quality check by the user.
