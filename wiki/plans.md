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

## Wave 3: Live-Betrieb (2026-09-10)

Plans 036 + 613–616: vertical inline-list rendering, the Initiative engine
(phased 0–4, minus `/initiative` command), the humanizer-fidelity fix
(faithful split instead of rewrite), and the outbound reply anchor. **Plan 613
shipped default-OFF** (`initiative.enabled:false`, `shadow:true`) — flipping
an agent live is an operator step (runbook in
[operations/environment.md](./operations/environment.md)). The README rows
still carry the original branch/worktree wording; the commits are on `main`.

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [036](../plans/036-vertical-list-formatting.md) | Inline-Pipe-Listen vertikal rendern (Schedules/Tallies) | P1 | S–M | — | DONE (`c47a33c`, 1155/0, Parity 82/82) |
| 037 | Gruppen-Agents proaktiv nachfassen lassen (Cron-Follow-up, OpenClaw-Config) | P1 | S | — | SUPERSEDED → `~/plans/612-group-agent-proactive-followup.md` (nicht im public Repo) |
| [613](../plans/613-initiative-task-engine.md) | Initiative: modulare Multi-Tenant-Task-/Memory-/Proaktivitäts-Engine | P1 | L | 036 | DONE (`d4774b1`…`d5e8490` P0–P4, 1186/0, Parity 87/87; default OFF) |
| [614](../plans/614-initiative-command.md) | `/initiative`-Command (list/add/done/forget/directive) | P2 | S | 613 | DONE (`90bdc6a`, 1194/0) |
| [615](../plans/615-humanizer-fidelity.md) | Humanizer-Treue: Split statt Rewrite (Proxy-Flip-Fix) | P1 | S–M | — | DONE (`3efa38a`, 1204/0, Parity 88/88; `humanize.temperature` 0.9→0.3) |
| [616](../plans/616-reply-target-anchor.md) | Reply-Anker auf Mitglieds-Nachricht statt eigene | P1 | S | — | DONE (`cfd66dc`, 1205/0) |

## Wave 4: DM-Proaktivität — durable Open-Loop-Ledger (2026-09-11)

One generic, per-agent×scope durable open-loop ledger (built on
`initiative-store`), shared by the followup-cron, heartbeat and `dm-proactive`;
declarative activation via `agentProfiles`/`scopes`, shadow-first, live
initially only for the DM agent. The config/workspace side (cron prompt,
`erledigt_check.py`, heartbeat, KPIs) lives outside this repo
(`~/plans/635–639`).

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [617](../plans/617-initiative-durable-open-loop-state.md) | Initiative-Store als durable Open-Loop-Ledger (Cooldown, Expiry, Shadow-Budget, stabiler topicKey) | P1 | M | — | DONE (`301764e`, 1211/0, Parity 93/93) |
| [618](../plans/618-ledger-read-surface-and-gate-cli-fix.md) | `followup-gate.mjs` v4-sentIds-Fix + read-only `initiative-ledger.mjs` CLI | P1 | S–M | 617 | DONE (`cf5d5a3`, 1218/0, Parity 98/98) |
| [619](../plans/619-dm-proactive-topic-ledger-integration.md) | dm-proactive konsumiert den Ledger (Topic-Cooldown/Attempt-Cap/agent-owed), malformed fail-closed, geteilter Outbox | P1 | L | 617, 618 | DONE (`06046a9`, 1237/0, Parity 104/104) |
| [620](../plans/620-memory-thread-open-loop-repair.md) | Memory/Thread-State reparieren (schemaV2-Befüllung, Thread-Status, zweiseitiger Observed-Store) | P1 | M | — | DONE (`9092008`, 1246/0, Parity 107/107; leere v2-Ablage = Modell-/Ingest-Regression, jetzt per Warn sichtbar) |
| [621](../plans/621-context-hygiene-quoted-audio.md) | Kontext-Hygiene: Untrusted-Delimiter escapen + quotierte Voice-Transkripte labeln | P2 | S–M | — | DONE (`388a37f`, 1256/0, Parity 108/108) |

Full per-plan wording with branches/worktrees stays in
[`../plans/README.md`](../plans/README.md).
