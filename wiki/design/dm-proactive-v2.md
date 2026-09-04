# DM proactive v2 (design summary)

Binding design: `docs/design-dm-proactive-v2.md` (Plan 526, Option A,
Kevin decision 2026-09-04). This page is the agent-facing digest — the repo
doc wins on conflict.

## What it is

Renders due DM follow-up commitments (e.g. "ask me again Friday") as natural
DMs, gated by a shared rule core and shadow-first by default. Replaces the
v1 `~/.openclaw/commitments/` reconciliation with an envelope-first-line
protocol.

## Pipeline (Plans 530-534)

1. **Envelope source adapter** — `lib/dm-proactive.js` `onMessageSending`
   parses a first line `[[fu:{…}]]` via `parseFollowupEnvelope`
   (`lib/dm-gate-core.js`). Plain text passes through untouched (fail-open).
2. **Gate-core** — `evaluateDmGate(candidate, ctx)` is the single source of
   truth, consumed by BOTH the hook and the CLI. Rules: deadline grace,
   care/soft tiers, DayFit bands, byKind cadence, budget.
3. **DayFit** — `lib/dayfit.js` reads `~/.openclaw/state/kevin-activity.json`
   (`{ lastKnownKevinActivityAtMs }`), Europe/Berlin quiet-hours + day-key.
   Soft tier is blocked when `dayFit.value === null`.
4. **byKind cadence** — `state/dm-proactive-state.json` `byKind`:
   `budgetMultiplier`, `sends[]`, `replyRate14d`, `ignoreStreak`, `paused`.
   `ignoreStreak ≥ 2` halves budget, `≥ 4` pauses the kind. Reply attribution
   via `onMessageReceived`.
5. **sentIds idempotency** — bounded LRU (max 512) in the same state file;
   a retried envelope (same id) is blocked as duplicate.
6. **Shadow log v2** — `state/dm-proactive.jsonl` entries carry `day`,
   `candidateId`, `kind`, `scope`, `gateVerdicts`, `gatePassed`,
   `renderPreview` (shadow) / `render` (live), `envelope`, and
   `outcome.repliedWithin48h`. 14-day retention prune.
7. **Outcome backfill** — when an inbound DM arrives within 48 h of a sent
   follow-up, `backfillOutcome()` marks it replied.

## CLI (layer-1 defense)

```
node bin/followup-gate.mjs check [--file <env.json>|-] [--config <cfg.json>]
       [--state <state.json>] [--session <sessionKey>] [--agent <agentId>]
       [--now <epoch-ms>]
```

Exit codes: 0 pass, 1 block, 2 invalid/no envelope, 3 usage error. The
followup-cron MUST run this before sending — same gate-core, no transcript
context.

## Config

`dmProactive.*` — see `operations/environment.md`. Defaults: `enabled:
false`, `shadow: true`, `budgetPerDay: 2`, `minGapMinutes: 180`,
`quietStart/End: 23:00/07:00`, `careBudgetPerDay: 1`, `dayFitReduceHours: 4`,
`dayFitPauseHours: 12`, `inferredCapPerDay: 2`.

## Verification

- `test/dm-proactive.test.js` (79 tests) + `test/helpers/dm-proactive-fixtures.js`
- Parity matrix rows #37-#40 (v2) in `test/parity-matrix.mjs`
- Log markers (prefix `human-engine:`): `dm-proactive SHADOW`,
  `dm-proactive SENT`, `dm-proactive cannot send`,
  `dm-proactive live send failed`.
