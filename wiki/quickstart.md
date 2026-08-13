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
- Persists silenced messages to a plugin-local observed store
  (`state/observed/`) and layers them into the decide transcript.
- Hard-triggers speech on direct address: name/word-boundary match, WhatsApp
  @-mention (lid/phone via contacts), and quote-reply to the agent's own
  message (`path=reply`).
- Strips leaked model monologue (meta-commentary) before delivery
  (`stripMetaCommentary`) on both the humanize and raw-fallback paths.
- Detects pure-commentary output (model returned only reasoning, no reply)
  and regenerates a real reply once; suppresses instead of leaking commentary
  if regeneration fails.
- Runs an opt-in proactive turn-taking funnel (shadow-first).
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
- State is in-memory only (Maps in `state.js`); persistent state lives in
  `state/` files (voice-card cache, social-memory profiles, observed store,
  proactive.json) plus the soul marker/backup next to SOUL.md — see
  `operations/environment.md`.
- Config resolves via `api.pluginConfig ?? api.config.plugins.entries["human-engine"].config`.
- `before_agent_reply` fires BEFORE the model run with the cleaned inbound
  body — the gate decides and silences there (`{handled: true}`). It never
  contains the agent's reply text; that comes from `reply_payload_sending`.
- Never return a block from `before_agent_run` — it wedges sessions via
  pendingFinalDelivery recovery.
- The decide/respond LLM calls get conversation context from
  `getTranscriptPeek(sk, n)` (state.js) — keep inbound messages flowing into
  the peek buffer or decide quality degrades to single-message guesses.
- Tests use inline fakes plus `test/helpers/sdk-hook-ctx.js` for SDK-shaped
  hook contexts (no shared fake-api helper).
- Parity matrix at `test/parity-matrix.mjs` is the behavioral contract — must
  stay 36/36 before any release.

## Source map

See [source-map.md](./source-map.md) for the full file tree.
