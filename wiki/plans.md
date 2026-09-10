# Plans

Improve-skill waves, all executed via executor subagents and advisor-reviewed.

## Wave 1: Multi-Tenancy (2026-09-09, Plans 001–008, all DONE)

Goal: add agents and WhatsApp groups/channels declaratively — own personality,
own contacts, own social cards, own budgets, everything isolated per agent
and per channel. See `../plans/README.md` (wave-1 table) for per-plan status
and test/parity numbers.

## Wave 2: Deep-Audit Verständnis / Social Memory / Persönlichkeit (2026-09-10, Plans 009–035, all DONE)

27 plans across four waves + follow-ups, merged to main and deployed
(gateway restarted via `--safe`, plugin load verified, zero human-engine
errors; **Operator-Aktivierung 2026-09-10: alle Feature-Flags live**):

| Wave | Plans | Kern |
|------|-------|------|
| A — Foundation | 009–018 | Speaker-aware Transcript-Dedup, Untrusted-Wrapping komplett, Ingest-Kadenz, Log-Redaction + Perms 0700, Observed-Tail-Read, Scope-Disziplin (parseAgentScope), Version-Sync 0.4.2 + openThread-Stub entfernt, Decide-Parse robust, DM-Budget per Agent (v4), Test-Härtung (TTS-Retry, onSilence-E2E, Parity `kind`) |
| B — Social Memory | 019–021 | Person-Store (Memory pro MENSCH, cross-session, Migration), schemaV2 (relationship/open_threads/emotional_state), Recall-Textur + Memory-in-Decide + unified memoryReference |
| C — Threads & Verständnis | 022–025 | Thread-State (meaningful absence, Decide-Injection, Rebuild), return_greeting + thread_callback Trigger (shadow-first), Decide-Contract v2 (JSON reason/addressed_to), Media-Caption Spike (Report: Media-Facts ohne caption-Feld) |
| D — Persönlichkeit | 026–032 | Timing-CTX-Felder + Style-Selbstfilter, sanitizeTells-Runtime-Backstop, Voice-Card-in-Decide, Sprach-Packs (de byte-identisch), Mood-Decay persistiert + Gruppen-Mood (flagged), Self-Voice-Spike (Prototyp config-off), Native-Reaktions-Spike (Report) |
| Follow-ups | 033–035 | Self-Voice-Wiring (`/soul voice` preview/accept/reset + Persona-Render), Media-Kontext (Caption-in-Transcript + Capture-Gap-Fix + kind-gewichtete Lesezeit), Quote-Reply-Zustellung (replyToId) + opt-in Reaktions-Hinweis |
| P0-Hotfix | — | Host wirft `LLM_COMPLETION_NOT_AUTHORIZED` bei Plugin-llm.complete mit agentId ohne `allowAgentIdOverride: true` (Host-Contract-Änderung; Symptom: Agent komplett stumm, fail-closed). Fix an allen 10 Call-Sites (1130/0, Parity 81/81, deployed 2026-09-10). |

Full per-plan status with test/parity numbers: `../plans/README.md`.
Spike reports: `../plans/025-media-caption-spike-report.md`,
`../plans/031-self-voice-spike-report.md`,
`../plans/032-native-reactions-spike-report.md`.

## Reserved follow-up slots

- **033** — DONE (self-voice command wiring + persona rendering, Plan 033)
- **034** — DONE (media caption-in-transcript + capture-gap fix, Plan 034)
- **035** — DONE (quote-reply delivery via replyToId + opt-in reaction hint, Plan 035)
- Open for the future: plugin-seitiges Reaktions-Senden, sobald der Host den
  message-action-runner als Plugin-SDK-Export freigibt (Report 032 §1.6,
  Option 1).

## Wave 3: Initiative Engine (Plan 613, phased 0–4, DONE)

**Plan 613 — Initiative** (P1, effort L, risk MED): a modular, multi-tenant
proactive task & memory engine. Built shadow-first and default-OFF
(`initiative.enabled:false`). Phased delivery:

- **Phase 0** — skeleton, config schema (`initiative` block in
  `defaultConfig()` + `NESTED_KEYS` + strict manifest schema + agentProfiles),
  version bump 0.5.0, durable per-agent×scope store
  `lib/initiative-store.js` + shadow log, no-op `lib/initiative.js` shell,
  hooks + master tick wiring.
- **Phase 1** — capture (keyword/cadence-triggered LLM task/directive
  extraction, `buildTaskExtractPrompt`) + recall (`before_prompt_build`
  context injection, `maxContextChars`-bounded, untrusted-wrapped).
- **Phase 2** — tick/gate/decide/render: deterministic `evaluateInitiative`
  gate (active/quiet hours, budget, min-gap, hot-room, after-speak, cooldown,
  paused, probability + ignoreStreak multiplier), LLM decide + render +
  sanitize/expand, shadow log (never `subagent.run` in shadow).
- **Phase 3** — engagement attribution (`outcome.repliedWithin48h` backfill),
  ignore-streak, shared outbound budget with `proactive` via
  `lib/proactivity-outbox.js`, operator runbook.
- **Phase 4** — parity rows 83–87 + wiki/docs sync.

Deployed state: parity 87/87, `npm test` 1186 pass / 0 fail. Feature remains
default-OFF pending a shadow-window review per the runbook in
`wiki/operations/environment.md`.
