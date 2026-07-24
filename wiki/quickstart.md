# Human Engine quickstart

A fully self-hosted OpenClaw plugin that adds social intelligence to agents:
turn-taking gate, bubble naturalization with human timing, voice card,
persona/soul enhancement, and social memory. Runs entirely on the host's
built-in LLM with no cloud dependencies.

## Start here

- [Architecture overview](./architecture/overview.md) — hook pipeline, module roles, execution flow.
- [Build, test, lint](./operations/build-test-lint.md) — exact commands.
- [Environment](./operations/environment.md) — config keys, state files.
- [Source map](./source-map.md) — file tree with descriptions.

## What this repository does

- Decides when the agent should speak or stay silent (turn-taking gate).
- Naturalizes multi-bubble replies with human-like typing timing.
- Maintains per-agent persona prompts with soul auto-enhance.
- Learns a voice card (communication-style profile) per session.
- Extracts and recalls person-centric social memory on cadence.
- Supports DM fail-open and group fail-closed safety modes.
- Provides a parity-matrix contract for all behavioral capabilities.

## Key source files

| File | Role |
|------|------|
| `index.js` | Plugin entry point; registers hooks, wires modules |
| `lib/gate.js` | Turn-taking gate: decide speak/stay-silent per message |
| `lib/naturalize.js` | Bubble naturalization: split, time, and dispatch replies |
| `lib/local-engine.js` | Local LLM engine for decide + naturalize decisions |
| `lib/config.js` | Config resolution from OpenClaw API |
| `lib/voice-card.js` | Communication-style profile learning and injection |
| `lib/social-memory.js` | Person-centric fact extraction and recall |
| `lib/timing-engine.js` | Human-typing timing calculation |
| `lib/persona.js` | Persona prompt building (soul + voice-card) |
| `lib/state.js` | In-memory ephemeral state (Maps with size caps) |
| `lib/soul.js` | Soul/persona enhancement via local LLM |
| `openclaw.plugin.json` | Plugin manifest (id, name, config schema) |

## Documentation map

- [Architecture](./architecture/overview.md)
- [Build, test, lint](./operations/build-test-lint.md)
- [Environment](./operations/environment.md)
- [Source map](./source-map.md)

## Notes for future agents

- All hook error handling is in `index.js` wrap() — catches and logs, never
  throws into OpenClaw's hook chain.
- State is in-memory only (Maps in `state.js`), except voice-card cache and
  soul marker, which persist to `state/` files.
- Config resolves via `api.pluginConfig ?? api.config.plugins.entries["human-engine"].config`.
- `silentEpochBySession` entries are `{epoch, ts}` objects with a 90s TTL
  (`gate.silentTtlMs`) — never store bare epochs there; stale flags must
  expire, not silence.
- Never return a block from `before_agent_run` — it wedges sessions via
  pendingFinalDelivery recovery. Silence is enforced in `before_agent_reply`.
- The decide/respond LLM calls get conversation context from
  `getTranscriptPeek(sk, n)` (state.js) — keep inbound messages flowing into
  the peek buffer or decide quality degrades to single-message guesses.
- Every test uses fake API objects from `test/helpers/fake-api.js`.
- Parity matrix at `test/parity-matrix.mjs` is the behavioral contract — must
  stay 35/35 before any release.

## Source map

See [source-map.md](./source-map.md) for the full file tree.
