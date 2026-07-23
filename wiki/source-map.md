# Source map

```
human-engine/
  index.js                  — Plugin entry: registers hooks, wires modules
  openclaw.plugin.json      — Plugin manifest with config schema
  package.json              — npm package (name: human-engine, ES module)
  package-lock.json         — Dependency lock (no external deps)
  README.md                 — Project README (install, config, usage)
  CHANGELOG.md              — Release history (0.2.0, 0.1.0)
  LICENSE                   — MIT with Humalike attribution
  .gitignore                — Ignored: node_modules/, state/, *.log, .DS_Store
  lib/
    gate.js                 — Turn-taking gate (speak/stay-silent decisions)
    naturalize.js           — Bubble naturalization (split + time replies)
    local-engine.js         — Local LLM engine (decide + naturalize calls)
    config.js               — Default config + resolve from OpenClaw API
    voice-card.js           — Communication-style profile learning
    social-memory.js        — Person-centric fact extraction & recall
    persona.js              — Persona prompt assembly (soul + voice-card)
    soul.js                 — Soul/persona enhancement via local LLM
    timing-engine.js        — Human-typing timing calculation
    anti-tell.js            — Tell-like phrase suppression
    style-stats.js          — Communication pattern logging
    state.js                — In-memory ephemeral state (capped Maps)
    autoconfig.js           — Plan config changes for operator
    messages.js             — Message conversion + validation utils
    local-prompts.js        — System prompts for LLM calls
  test/
    gate.test.js            — Gate unit tests
    naturalize.test.js      — Naturalization unit tests
    config.test.js          — Config resolution tests
    local-engine.test.js    — Local engine tests
    voice-card.test.js      — Voice card unit tests
    voice-card-local.test.js— Voice card LLM integration tests
    social-memory.test.js   — Social memory tests
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
    tell-detector.test.js   — Tell detector tests
    decide-eval.test.js     — Decide evaluation tests
    e2e-local.test.js       — End-to-end local integration test
    harness.test.js         — Test harness tests
    parity-matrix.mjs       — 35-item behavioral parity check
    fixtures/
      decide-scenarios.json — 20+ labeled decide test scenarios
    helpers/
      fake-api.js           — Reusable fake OpenClaw API objects
  scripts/
    decide-eval-live.mjs    — Live decide evaluation script
    human-review-protocol.md— Human review protocol docs
  wiki/                     — This directory
```

## Git evidence

- Last commit: `f6426eb`
- Active branch: `main`
- Recent churn: initial commit (50 files)
