# Source map

```
human-engine/
  index.js                  — Plugin entry: registers hooks, wires modules; readSessionTranscript (ts backfill + NO_REPLY filter)
  openclaw.plugin.json      — Plugin manifest with config schema (v0.4.0)
  package.json              — npm package (name: human-engine, ES module)
  package-lock.json         — Dependency lock (no external deps)
  README.md                 — Project README (install, config, usage)
  CHANGELOG.md              — Release history (0.4.0–0.1.0)
  LICENSE                   — MIT
  .gitignore                — Ignored: node_modules/, state/, logs/, *.log
  bin/
    followup-gate.mjs       — CLI layer-1 pre-send check for the followup-cron (exit 0/1/2/3)
  docs/
    design-dm-proactive-v2.md — DM-proactive v2 binding design (Plan 526, Option A)
    media-findings.md       — Media handling findings
  lib/
    gate.js                 — Turn-taking gate (speak/stay-silent, chronological transcript merge, decide-ctx log)
    naturalize.js           — Bubble naturalization (split + time replies, persistOwnReply)
    local-engine.js         — Local LLM engine (decide + naturalize calls)
    config.js               — Default config + one-level deep merge
    voice-card.js           — Communication-style profile learning
    social-memory.js        — Person-centric fact extraction & recall (coalesced writes)
    observed-store.js       — Plugin-local persistence of silenced + own-reply lines
    proactive.js            — 3-stage proactive funnel (shadow-first)
    dm-proactive.js         — DM-proactive v2: envelope adapter, byKind cadence, shadow log, dispatch
    dm-gate-core.js         — Shared DM follow-up gate rules (hook + CLI)
    dayfit.js               — DayFit bands from kevin-activity.json
    persona.js              — Persona prompt assembly (soul + voice-card)
    soul.js                 — SOUL.md section-merge enhancement via local LLM
    timing-engine.js        — Human-typing timing calculation
    anti-tell.js            — Tell-like phrase suppression + meta-commentary strip (stripMetaCommentary)
    style-stats.js          — Communication pattern logging
    state.js                — In-memory ephemeral state (capped Maps)
    autoconfig.js           — Advisory config warnings for operator
    contacts.js             — contacts.md parsing + sender-ID → name resolution (findAgentContactIds, listContactNames)
    messages.js             — Message conversion + validation utils
    local-prompts.js        — System prompts for all LLM calls
  test/
    gate.test.js            — Gate unit tests (incl. chronological merge)
    naturalize.test.js      — Naturalization unit tests (incl. persistOwnReply)
    index.test.js           — readSessionTranscript helpers (ts conversion, NO_REPLY filter)
    config.test.js          — Config resolution tests
    local-engine.test.js    — Local engine tests
    voice-card.test.js      — Voice card unit tests
    voice-card-local.test.js— Voice card LLM integration tests
    social-memory.test.js   — Social memory tests (coalescing, race, cache cap)
    observed-store.test.js  — Observed store tests
    proactive.test.js       — Proactive funnel tests
    dm-proactive.test.js    — DM-proactive v2 tests (envelope, cadence, shadow-log, backfill)
    register.test.js        — Plugin register/hook-registration tests
    soul.test.js            — Soul enhancement tests
    soul-local.test.js      — Soul LLM integration tests
    persona.test.js         — Persona prompt tests
    timing-engine.test.js   — Timing calculation tests
    timing-distribution.test.js — Timing distribution tests
    anti-tell.test.js       — Anti-tell tests
    style-stats.test.js     — Style stats tests
    state.test.js           — State module tests
    messages.test.js        — Message utils tests
    local-prompts.test.js   — Prompt template tests
    autoconfig.test.js      — Autoconfig tests
    contacts.test.js        — Contacts resolution tests
    tell-detector.test.js   — Tell detector tests
    decide-eval.test.js     — Decide evaluation tests
    hook-contract.test.js   — SDK-shaped hook-context contract tests
    e2e-local.test.js       — End-to-end local integration test
    harness.test.js         — Test harness tests
    parity-matrix.mjs       — 42-item behavioral parity check
    fixtures/
      decide-scenarios.json — 20+ labeled decide test scenarios
    helpers/
      sdk-hook-ctx.js       — SDK-shaped hook contexts (hook-contract tests)
      ensure-plugin-sdk-shim.mjs — node_modules shim for openclaw plugin SDK
      dm-proactive-fixtures.js — Shared DM-proactive v2 test fixtures
  scripts/
    decide-eval-live.mjs    — Live decide evaluation script
    human-review-protocol.md— Human review protocol docs
  wiki/                     — This directory
```

## Git evidence

- Last commit: `a878dd2`
- Active branch: `main`
- Recent churn: Wave-91 hardening (21 plans 496-516: burst dedup,
  dispatcher displacement, meta-commentary/pure-commentary, gateway_stop
  cleanup, fail-closed hardening), Plan 528 (persistOwnReply), Plan 529
  (chronological decide-context merge + ts backfill + NO_REPLY filter),
  dm-proactive v2 AP(a)-(e) (Plans 530-534: envelope adapter, followup-gate
  CLI, DayFit bands, byKind cadence, shadow-log v2, outcome backfill)
