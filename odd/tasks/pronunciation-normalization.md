# Pronunciation-oriented text normalization

**Status: PENDING / NOT IMPLEMENTED (2026-10-11).** Documentation-only authorization adds a planned Open-Vox feature, not an implementation approval. Repository-relative locator: `odd/tasks/pronunciation-normalization.md`. Engram's canonical internal project remains `agentvoz`.

## Objective and scope

Plan a non-mutating, derived speech representation that renders technical text intelligibly in Spanish and English while preserving meaning and the authoritative original. The user reported that competitors may use an LLM transformation layer; this premise is unverified, not a competitor finding or an LLM requirement. No research or competitor verification was performed.

- Split identifiers such as `getUserName` into understandable words (illustrative segmentation: `get user name`). Local-language pronunciation remains undecided; do not arbitrarily translate technical identifiers.
- Define meaningful spoken rendering of acronyms and symbols according to language and context, with a conservative fallback for ambiguity; there is no universal pronunciation rule.
- Preserve punctuation and paragraph boundaries to support pauses. Phrasing depends on the synthesis engine; boundary preservation does not guarantee natural audio.
- Protect versions, paths, URLs, numbers, commands, CLI flags/options, and identifiers against meaning-changing phonetic expansion. Never silently rewrite the original in UI, history, or source.
- An LLM, if later approved, is optional assistance for grounded lexical transformation only: no summaries, paraphrases, or hallucinated tokens. Provider/tool selection is open; no external text transfer is authorized.
- Preserve existing pause, session/instance ownership, replay, and cache guards. Cached Repeat reuses the exact existing audio, with no repeated synthesis or retroactive normalization.

## Pending tasks

- [ ] Pronunciation-oriented text normalization — planned feature; all subtasks pending.
  - [ ] PN-01 — Define language/context pronunciation rules, ambiguity fallback, and protected technical tokens without arbitrarily translating identifiers.
  - [ ] PN-02 — Evaluate a deterministic baseline versus optional LLM assistance: latency, resource use, privacy, offline operation, reproducibility, and naturalness risks; require a safe deterministic fallback. Provider/tool remains unchosen and external text transfer unauthorized.
  - [ ] PN-03 — Design integration of derived speech text separately from the authoritative original, preserving punctuation/paragraph boundaries and existing pause, ownership, replay, and cache guards; cached Repeat must not synthesize again or alter existing audio.
  - [ ] PN-04 — Implement only after separate approval; this checklist grants no implementation authorization.
  - [ ] PN-05 — Perform regression and listening evaluations for meaning fidelity, pauses, and fluency after approval; judge naturalness using listening evidence, not assumptions.

## Proposed acceptance criteria

These are future criteria, not completed results. Pronunciation choices and thresholds remain pending.

- Derived speech text remains separate from unchanged UI/history/source originals; protected tokens retain their meaning.
- Spanish/English language and context rules include explicit ambiguity handling, identifier segmentation, and no arbitrary technical translation.
- Punctuation and paragraph boundaries remain available to the engine for pauses; engine-dependent phrasing is qualified rather than guaranteed.
- Any optional LLM remains constrained to grounded lexical transformations and has a safe deterministic fallback; no provider is selected and no external text transfer is permitted by this task.
- Existing pause, ownership, replay, and cache guards remain intact; cached Repeat performs no new synthesis and reuses the exact existing audio.
- Regression and listening evidence support fidelity, pause behavior, and fluency before any naturalness improvement is claimed. No improvement is claimed now.

## Future test ideas — not run

All cases below are proposed for both Spanish and English contexts; expected pronunciation decisions are pending, not invented requirements.

| Representative case | Future evaluation focus |
| --- | --- |
| `getUserName` | Word segmentation (`get user name` as an example), language strategy, original identifier preservation. |
| `API`, `HTTP`, `>=` | Context-sensitive acronym/symbol rendering and ambiguous-case fallback. |
| `v1.2.3` | Preserve version meaning; do not mistake components for a decimal. |
| `<reference-assets>`, `/usr/local/bin`, `https://example.com/a?q=1` | Protected filesystem paths/URLs, separators, and unchanged originals. |
| `1,234.56`, `1.234,56`, `1.5`, `1,5` | Decimal/grouping interpretation under both locales and fallback when context is insufficient. |
| `tool --output ./file.txt -v`, `--speed=1.5` | Preserve commands, CLI flags/options, values, and token meaning. |
| Punctuation and multiple paragraphs | Pause/fluency listening evidence with the chosen engine, without guaranteeing phrasing. |
| Ambiguous input, optional-assistance failure, cached Repeat | Safe deterministic fallback; unchanged originals; exact cached audio with no new synthesis and intact pause/ownership/replay/cache guards. |

## Open decisions and next step

Language/context rules, local-language identifier pronunciation, acronym/symbol ambiguity handling, protected-token policy, integration/cache policy for newly synthesized audio, evaluation thresholds, and whether optional LLM assistance is justified remain open. No provider/tool is chosen. Deterministic-versus-LLM evaluation must consider latency, resources, privacy, offline operation, reproducibility, and naturalness risks before selection.

**Next step:** await separate approval before evaluation/design execution or implementation. This update performs documentation and passive structural checks only; no research, source edits, functional tests, listening sessions, or external provider calls.

## Tracking

- [Open-Vox overview](../../README.md)
- Local sprint notes (private, not included in this repository); PN-01–PN-05 remain pending.
- Engram: project `agentvoz`, topic `odd/pronunciation-normalization/tasks`.

Playback-speed (including nested PS-05) and Repeat are separate existing features and remain untouched.

## Local preparation context

Original SHAs, test results, host observations and branch states above are historical evidence, not fresh verification. The new local chain is tracked in [PN delivery preparation](pn-main-delivery.md); P3b/P4 remain deferred. No publication is authorized.
