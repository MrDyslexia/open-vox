# Open-Vox — cyclic playback-speed button

**Status: PENDING / NOT IMPLEMENTED.** Updated: 2026-10-11. Backend project: `agentvoz`.
Only documentation is authorized; implementation requires separate authorization.

## Objective and acceptance requirements

| ID | Pending requirement |
| --- | --- |
| PS-01 | Show the current playback multiplier on a sidebar button. Each click cycles `1.0x -> 1.5x -> 2.0x -> 2.5x -> 1.0x`. |
| PS-02 | Apply the multiplier to cached audio, including Repeat. Keep the retained original WAV unchanged; never regenerate speech just to change playback rate. |
| PS-03 | Keep playback multiplier separate from synthesis speed to avoid accidental compounded acceleration. |
| PS-04 | Preserve Pause, session/instance ownership, and cached Repeat cleanup. Do not change the existing Repeat task or its progress. |

## Research and decision dependencies

- [ ] Playback-speed implementation — pending separate authorization.
  - [ ] PS-05 — Research and select a rate-capable player or time-stretch approach.

The supplied verified baseline reports `config.ts` has `MAX_SPEED=2`, Kokoro speed changes synthesis rather than WAV playback, and `speech-sink.ts` uses `System.Media.SoundPlayer` in `playWav`. SoundPlayer has no playback-rate API: [Microsoft API reference](https://learn.microsoft.com/en-us/dotnet/api/system.media.soundplayer). These facts are supplied evidence, not a fresh source audit in this documentation-only update.

| ID | Pending dependency |
| --- | --- |
| PS-05 | Research and select a rate-capable player or time-stretch approach as a nested playback-speed task; no tool or backend has been selected. Merely raising synthesis `MAX_SPEED` does not satisfy this feature. |
| PS-06 | Decide whether changes affect current playback or the next playback. Next playback is a recommendation, not approved behavior; timing remains UNDECIDED. |
| PS-07 | Evaluate tone/pitch preservation. It is a recommended proposal, not an explicitly approved requirement. |

## Proposed functional tests — not executed

| ID | Proposed verification |
| --- | --- |
| PS-08 | Check the displayed rate at each click and wrap from `2.5x` to `1.0x`. |
| PS-09 | Check cached playback and Repeat use the selected multiplier without synthesis or alteration of the retained original WAV. |
| PS-10 | Check Pause, session/instance isolation, Repeat cleanup, and absence of accidental synthesis/playback compounding. |
| PS-11 | Check the timing behavior once PS-06 is decided; verify voice pitch if preservation is adopted under PS-07. |

## Next step

Await implementation authorization before researching or implementing the playback path. No live UI evidence, functional checks, or completed implementation is claimed.

Project tracking: local sprint notes (private, not included in this repository); PS-01–PS-11 remain pending.
