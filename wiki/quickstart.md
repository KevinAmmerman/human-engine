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
  (`state/observed/`) and layers them into the decide transcript —
  including the agent's own replies (restart-surviving self-context).
- Builds the decide context as a chronologically merged, timestamped
  transcript (LCM session events + observed store + in-memory peek),
  filters `NO_REPLY` artifacts, and logs a PII-safe `decide-ctx` line
  (line/own/speaker/age counts) per group decide.
- Hard-triggers speech on direct address: name/alias/word-boundary match,
  WhatsApp @-mention (lid/phone via contacts), and quote-reply to the
  agent's own message (`path=reply`).
- Strips leaked model monologue (meta-commentary) before delivery
  (`stripMetaCommentary`) on both the humanize and raw-fallback paths.
- Detects pure-commentary output (model returned only reasoning, no reply)
  and regenerates a real reply once; suppresses instead of leaking commentary
  if regeneration fails.
- Runs an opt-in proactive turn-taking funnel (shadow-first).
- Renders due DM follow-ups from `[[fu:…]]` envelopes through a shared
  gate-core (shadow-first, sentIds idempotency, byKind cadence, outcome
  backfill) — see [design/dm-proactive-v2.md](./design/dm-proactive-v2.md).
- Supports DM fail-open and group fail-closed safety modes.
- Provides a parity-matrix contract for all behavioral capabilities.

## Key source files

| File | Role |
|------|------|
| `index.js` | Plugin entry point; registers hooks, wires modules, readSessionTranscript (ts backfill + NO_REPLY filter) |
| `lib/gate.js` | Turn-taking gate: decide speak/stay-silent per message; chronological transcript merge |
| `lib/naturalize.js` | Bubble naturalization: split, time, and dispatch replies; persistOwnReply |
| `lib/local-engine.js` | Local LLM engine for decide + naturalize decisions |
| `lib/dm-gate-core.js` | Shared DM follow-up gate rules (hook + CLI, one source of truth) |
| `lib/dm-proactive.js` | DM-proactive v2: envelope adapter, cadence, shadow log, dispatch |
| `lib/dayfit.js` | DayFit bands from `~/.openclaw/state/kevin-activity.json` |
| `bin/followup-gate.mjs` | CLI layer-1 pre-send check for the followup-cron |
| `lib/config.js` | Config resolution from OpenClaw API |
| `lib/voice-card.js` | Communication-style profile learning and injection |
| `lib/social-memory.js` | Person-centric fact extraction and recall |
| `lib/timing-engine.js` | Human-typing timing calculation |
| `lib/persona.js` | Persona prompt building (soul + voice-card) |
| `lib/state.js` | In-memory ephemeral state (Maps with size caps) |
| `lib/observed-store.js` | Silenced + own-reply persistence (`state/observed/*.jsonl`) |
| `lib/soul.js` | Soul/persona enhancement via local LLM |
| `openclaw.plugin.json` | Plugin manifest (id, name, config schema) |

## Documentation map

- [Architecture](./architecture/overview.md)
- [Build, test, lint](./operations/build-test-lint.md)
- [Environment](./operations/environment.md)
- [Source map](./source-map.md)
- Design: [conversational time](./design/conversational-time.md),
  [meaningful absence](./design/meaningful-absence.md),
  [social memory v2](./design/social-memory-v2.md),
  [DM proactive v2](./design/dm-proactive-v2.md)

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
- The decide/respond LLM calls get conversation context from a three-layer
  merge (`mergeTranscriptLayers` in gate.js): hydrated LCM session events
  (index.js `readSessionTranscript` — with ts backfill from
  `e.timestamp`/`e.message.timestamp` and `NO_REPLY` filtering), the observed
  store, and the in-memory peek. Layers are tail-deduped, then
  **chronologically stable-sorted** (ts-less entries sort last), then
  `slice(-20)` — the current message must be the last line or decide quality
  degrades (live-verified false stay_silent, Plan 529).
- Tests use inline fakes plus `test/helpers/sdk-hook-ctx.js` for SDK-shaped
  hook contexts (no shared fake-api helper).
- Parity matrix at `test/parity-matrix.mjs` is the behavioral contract — must
  stay 42/42 before any release.

## Source map

See [source-map.md](./source-map.md) for the full file tree.
