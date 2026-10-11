# Post-normalization chunked narration — feasibility analysis

**PENDING / ANALYSIS BACKLOG (2026-10-11).** Documentation only. No algorithm, cap change, research execution, implementation, or performance result is approved by this task. Display project: Open-Vox; canonical Engram project: `agentvoz`.

## Objective and dependency

Investigate sequential, ordered TTS requests over the output of the pending pronunciation-normalization layer (`odd/tasks/pronunciation-normalization.md`, PN-01–PN-05). The hypothesis is earlier first audio, followed by synthesis of a subsequent part while the prior part plays. Preserve the authoritative original in UI/history/source. This is downstream analysis, not an alternative to PN or authorization to implement it.

## Verified current behavior

Read-only source inspection on 2026-10-11, against the current working tree (including pre-existing uncommitted changes); no audio or benchmarks:

| Finding | Source evidence |
| --- | --- |
| Technical cleanup already exists: Markdown/code fences, links/URLs and markup are removed or transformed; whitespace is cleaned. This is not the planned pronunciation-normalization layer. | `src/speech-text.ts:28–50` |
| Prepared text defaults to a 4,000 UTF-16 code-unit cap (`string.length`/`slice`), preferring a recognized sentence boundary in the prefix and otherwise hard-cutting it. This is an application cap, not an evidenced model token limit. The sink permits a `maxLength` override; the live factory supplies none. | `src/speech-text.ts:29,51–55`; `src/speech-sink.ts:27,159`; `src/plugin.ts:246–251` |
| The sink sends one complete prepared text per narration job, not chunk requests. Cached synthesis must exit successfully and promote the WAV before playback starts. Piper/Kokoro's uncached WAV path also waits for synthesis exit before playing. This does not establish the timing of uncached SAPI direct speech. | `src/speech-sink.ts:121–141,157–165`; `src/piper-engine.ts:56–81` |
| The default runner spawns a fresh process per synthesis request. Kokoro starts Python, reads all stdin, constructs `Kokoro`, calls `create`, then writes the WAV on each invocation. Piper invokes an executable with a model path; its internal model-loading behavior is not established by these wrappers. | `src/piper-engine.ts:19–29,78–90`; `src/kokoro-engine.ts:51–73,97`; `scripts/kokoro_say.py:19–25` |
| Cancellation invalidates a generation, drains pending jobs and kills the current process. New user turns, session deletion and disposal are wired to cancellation/cleanup. Current Resume does not continue canceled audio automatically. | `src/speech-sink.ts:118,168–197`; `src/plugin.ts:120–143,166–176` |
| Repeat queues session/revision identity without text, then plays the existing cached file without synthesis. Cache promotion keeps one committed last artifact, with bounded candidates and held-file retirement. | `src/speech-sink.ts:122–137,177–184`; `src/audio-cache.ts:85–106,119–149` |

## Pending analysis tasks

- [ ] Post-normalization chunked narration — feasibility analysis; no implementation authorization.
  - [ ] CN-01 — Define the whole-text baseline and cap/measurement contract. Trace PN output to TTS without altering the original; compare current capped behavior with proposed full-coverage handling. Investigate removing arbitrary hard truncation without silently allowing unlimited processing. Decide length units (characters, tokens or estimated duration), per-request/total caps and resource budgets only from evidence; no cap changes now.
  - [ ] CN-02 — Analyze meaning-aware segmentation of normalized text at sentence/paragraph boundaries, with a fallback for overlong spans. Preserve punctuation, pauses and protected commands, paths, URLs, versions, numbers and identifiers; verify no text is lost, duplicated or reordered. Boundary rules and chunk sizes remain undecided.
  - [ ] CN-03 — Assess sequential FIFO TTS requests with pipelined synthesis/playback: a subsequent chunk generates while the prior chunk plays, without overlapping playback. Investigate bounded prefetch, backpressure, buffer depth and worker reuse/model residency versus repeated process/model initialization. Do not assume more processes improve performance; no concurrency strategy is selected.
  - [ ] CN-04 — Assess naturalness, prosody continuity, silence, artifacts and audible gaps at boundaries, alongside text/order integrity and failure behavior. Define acceptance criteria only after authorized evidence; punctuation preservation alone does not prove naturalness.
  - [ ] CN-05 — Analyze Pause cancellation of active synthesis/playback and prefetched audio, Resume semantics versus current compatibility, and new-turn/session-deletion/disposal invalidation. Prevent stale generations, preserve session/instance ownership and bounded safe cleanup. Plan exact cached Repeat of the full logically last narration without re-synthesis: assembled audio versus ordered stored fragments remains undecided, including incomplete-narration handling. Do not change the one-last-narration policy or pending playback-speed PS-05.
  - [ ] CN-06 — After separate research authorization, evaluate feasibility and record go/no-go plus a proposed design from evidence. Compare time-to-first-audio, interchunk gaps, total completion/model time, memory/CPU and correctness against whole-text synthesis under identical settings/input, cold/warm conditions and multiple text lengths. Implementation requires later, separate authorization; all tasks remain pending.

## Hypotheses, open decisions and proposed verification

Earlier first audio is a hypothesis, not a measured improvement or proof that current latency is excessive. Chunking may increase total synthesis overhead through repeated initialization; model residency and sufficient generation throughput may matter. Neither model streaming support nor a model maximum token limit has been established.

Future authorized verification should cover short/long bilingual PN output, overlong sentences, paragraph boundaries and protected technical spans; reconstruct the normalized text to detect loss/duplication/reordering. Exercise slow synthesis/playback, bounded buffering, middle-chunk failure, Pause during active/prefetched work, Resume once specified, new turns, session deletion, disposal and exact cached Repeat of the logical narration. Compare byte/sample fidelity of stored audio, session isolation and cleanup; listen for prosody/gaps only with authorization.

Separate process startup/model initialization, synthesis, playback and end-to-end timings where measurable; retain the current-cap baseline and disclose any full-coverage comparison that changes narrated content. Choose thresholds, segmentation rules, caps, buffering, worker lifecycle and Repeat representation only after evidence. No functional tests, listening, benchmarks or model calls have been performed for this task.

## Next step and synchronized locators

Wait for separate authorization to execute feasibility research, downstream of PN's pronunciation-normalization output. Preserve PN-01–PN-05, playback-speed's nested PS-05 and exact-audio Repeat unchanged.

- Repository locator: `odd/tasks/chunked-narration.md`.
- Engram: project `agentvoz`, topic `odd/chunked-narration/tasks` (full task mirror).
- Local tracking: private overview and sprint notes, section for CN-01–CN-06; not included in this repository.
