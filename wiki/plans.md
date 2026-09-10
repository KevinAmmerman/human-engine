# Plans

Improve-skill waves, all executed via executor subagents and advisor-reviewed.

## Wave 1: Multi-Tenancy (2026-09-09, Plans 001–008, all DONE)

Goal: add agents and WhatsApp groups/channels declaratively — own personality,
own contacts, own social cards, own budgets, everything isolated per agent
and per channel. See `../plans/README.md` (wave-1 table) for per-plan status
and test/parity numbers.

## Wave 2: Deep-Audit Verständnis / Social Memory / Persönlichkeit (2026-09-10, Plans 009–032, all DONE)

24 plans across four waves, merged to main and deployed (gateway restarted
2026-09-10, plugin load verified, zero human-engine errors):

| Wave | Plans | Kern |
|------|-------|------|
| A — Foundation | 009–018 | Speaker-aware Transcript-Dedup, Untrusted-Wrapping komplett, Ingest-Kadenz, Log-Redaction + Perms 0700, Observed-Tail-Read, Scope-Disziplin (parseAgentScope), Version-Sync 0.4.2 + openThread-Stub entfernt, Decide-Parse robust, DM-Budget per Agent (v4), Test-Härtung (TTS-Retry, onSilence-E2E, Parity `kind`) |
| B — Social Memory | 019–021 | Person-Store (Memory pro MENSCH, cross-session, Migration), schemaV2 (relationship/open_threads/emotional_state), Recall-Textur + Memory-in-Decide + unified memoryReference |
| C — Threads & Verständnis | 022–025 | Thread-State (meaningful absence, Decide-Injection, Rebuild), return_greeting + thread_callback Trigger (shadow-first), Decide-Contract v2 (JSON reason/addressed_to), Media-Caption Spike (Report: Media-Facts ohne caption-Feld) |
| D — Persönlichkeit | 026–032 | Timing-CTX-Felder + Style-Selbstfilter, sanitizeTells-Runtime-Backstop, Voice-Card-in-Decide, Sprach-Packs (de byte-identisch), Mood-Decay persistiert + Gruppen-Mood (flagged), Self-Voice-Spike (Prototyp config-off), Native-Reaktions-Spike (Report) |

Full per-plan status with test/parity numbers: `../plans/README.md`.
Spike reports: `../plans/025-media-caption-spike-report.md`,
`../plans/031-self-voice-spike-report.md`,
`../plans/032-native-reactions-spike-report.md`.

## Reserved follow-up slots

- **033** — self-voice command wiring (accept/reset) + persona rendering
  (plan 031's report)
- **034** — media caption build: caption-in-body path (plan 025's report)
- **035** — native reactions via model-routed message-action (plan 032's
  report; reactions are NOT plugin-SDK reachable)
