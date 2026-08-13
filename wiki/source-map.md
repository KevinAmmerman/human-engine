# Source map

```
human-engine/
  index.js                  — Plugin entry: registers hooks, wires modules
  openclaw.plugin.json      — Plugin manifest with config schema (v0.4.0)
  package.json              — npm package (name: human-engine, ES module)
  package-lock.json         — Dependency lock (no external deps)
  README.md                 — Project README (install, config, usage)
  CHANGELOG.md              — Release history (0.4.0–0.1.0)
  LICENSE                   — MIT
  .gitignore                — Ignored: node_modules/, state/, logs/, *.log
  lib/
    gate.js                 — Turn-taking gate (speak/stay-silent decisions)
    naturalize.js           — Bubble naturalization (split + time replies)
    local-engine.js         — Local LLM engine (decide + naturalize calls)
    config.js               — Default config + one-level deep merge
    voice-card.js           — Communication-style profile learning
    social-memory.js        — Person-centric fact extraction & recall (coalesced writes)
    observed-store.js       — Plugin-local persistence of silenced messages
    proactive.js            — 3-stage proactive funnel (shadow-first)
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
    gate.test.js            — Gate unit tests
    naturalize.test.js      — Naturalization unit tests
    config.test.js          — Config resolution tests
    local-engine.test.js    — Local engine tests
    voice-card.test.js      — Voice card unit tests
    voice-card-local.test.js— Voice card LLM integration tests
    social-memory.test.js   — Social memory tests (coalescing, race, cache cap)
    observed-store.test.js  — Observed store tests
    proactive.test.js       — Proactive funnel tests
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
    parity-matrix.mjs       — 36-item behavioral parity check
    fixtures/
      decide-scenarios.json — 20+ labeled decide test scenarios
    helpers/
      sdk-hook-ctx.js       — SDK-shaped hook contexts (hook-contract tests)
      ensure-plugin-sdk-shim.mjs — node_modules shim for openclaw plugin SDK
  scripts/
    decide-eval-live.mjs    — Live decide evaluation script
    human-review-protocol.md— Human review protocol docs
  wiki/                     — This directory
```

## Git evidence

- Last commit: `6b1d4e4`
- Active branch: `main`
- Recent churn: 0.4.0 wave (observability + hygiene) — observed store,
  decide rebuild on real hook semantics, naturalize repair, security
  hardening, proactive shadow mode, config truth sync, dead-code removal
