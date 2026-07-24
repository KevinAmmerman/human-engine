# Architecture overview

## Runtime structure

Human Engine is loaded as an OpenClaw plugin via `index.js`, which defines the
plugin entry using `definePluginEntry`. On `register()`, it instantiates all
internal modules (gate, naturalize, voice-card, social-memory, engine) and
registers typed hook handlers. The plugin runs in-process within the OpenClaw
gateway, sharing its LLM instance (`api.runtime.llm`). No separate server or
worker process.

## Major modules

| Module | Path | Role |
|--------|------|------|
| Plugin entry | `index.js` | Hook registration, module wiring, log prefix |
| Gate | `lib/gate.js` | Decides speak/stay-silent via local engine per message |
| Naturalize | `lib/naturalize.js` | Splits reply into bubbles, adds timing delays |
| Local engine | `lib/local-engine.js` | LLM-based decide + naturalize via host's `llm.complete` |
| Config | `lib/config.js` | Default config + resolve from OpenClaw API |
| Voice card | `lib/voice-card.js` | Style-profile learning, onBeforePromptBuild injection |
| Social memory | `lib/social-memory.js` | Person-centric fact extraction, cadence, recall |
| Persona | `lib/persona.js` | Soul prompt + voice-card assembly |
| Soul | `lib/soul.js` | SOUL.md enhancement via local LLM, auto-enhance on start |
| Timing engine | `lib/timing-engine.js` | WPM-based delay calculation, night mode |
| Anti-tell | `lib/anti-tell.js` | Suppress tell-like phrases in agent output |
| Style stats | `lib/style-stats.js` | Communication pattern logging |
| State | `lib/state.js` | Ephemeral in-memory Maps with size capping |
| Autoconfig | `lib/autoconfig.js` | Plan config changes (requireMention, streaming off) |
| Messages | `lib/messages.js` | Message conversion + validation utilities |
| Local prompts | `lib/local-prompts.js` | System prompts for decide + naturalize LLM calls |

## Execution flow

1. **`message_received`** hook: gate gathers transcript, ingests into social
   memory, records chat type (DM/group).
2. **`before_agent_run`** hook: gate calls `engine.decide()` which queries the
   local LLM with context (messages, persona, transcript). The transcript comes
   from the host's `event.transcript` if present, otherwise from the plugin's
   own per-session transcript peek buffer (last 20 lines). Hard triggers
   (DM, media, agent-name mention) short-circuit to `speak` with zero LLM
   calls. Returns `speak`/`stay_silent`/`null`.
3. If `speak`: gate records speak epoch, recalls social memory.
4. If `stay_silent`: gate buffers the message as observed context and marks a
   silent epoch flag (`{epoch, ts}`) — the agent run is NOT blocked (blocking
   wedges sessions via pendingFinalDelivery recovery).
5. If `null` (engine unavailable): DM fails open (agent runs normally), group
   fails closed (silent flag set).
6. **`before_prompt_build`** hook: gate injects observed context (if any
   silent turns). Voice card injects style profile into system context.
7. **`before_agent_reply`** hook: a fresh silent flag (age ≤
   `gate.silentTtlMs`, default 90s) is consumed and the reply suppressed
   (`{handled: true}`). Stale flags (older than the TTL, e.g. from turns that
   died before producing a reply) are dropped instead — they must not swallow
   a later, legitimate speak reply. Otherwise naturalize captures the draft.
8. **`reply_dispatch`** hook: naturalize dispatches bubbles with inter-bubble
   delays computed by timing engine (typing WPM, max wait, night mode).

## Key dependencies

| Dependency | Role |
|------------|------|
| `openclaw` (host) | Plugin SDK (`definePluginEntry`, `api.on`, `api.runtime.llm`) |
| Node.js 24+ | `node:test`, `node:assert/strict`, ES modules |

No external npm packages — all logic is self-contained.

## Design decisions

- **Local-only LLM calls**: All decisions use the host's `llm.complete` — no
  direct API keys, no external transport. Degrades gracefully if LLM is absent.
- **In-memory state**: Ephemeral state uses `Map` with size caps (4096 entries).
  Persistent state (voice-card cache, soul marker) writes to `state/` files.
- **Hook error isolation**: Every handler is wrapped in try/catch via `wrap()`
  in `index.js` — a hook error logs and returns `undefined` (no-op), never
  breaks the gateway.
- **Fail-open/fail-closed**: DMs default to fail-open (engine null → agent runs
  normally); groups default to fail-closed (engine null → silent block).
- **Silent flags carry a TTL**: `silentEpochBySession` entries store
  `{epoch, ts}` and expire after `gate.silentTtlMs` (default 90s). A reply for
  a stay_silent turn fires within seconds; older flags are residue of dead
  turns and are discarded, not consumed.
- **Never block `before_agent_run`**: returning a block from that hook writes
  a user-facing "blocked" text that wedges the session via
  pendingFinalDelivery recovery on restart. Silence is enforced by
  suppressing the reply in `before_agent_reply` instead; `message_sending`
  cancels any residual block text as defense-in-depth.
- **Scoping is uniform**: every handler (gate, naturalize, voice card)
  checks `enabled` and `agents` before doing any work.
- **Purpose strings**: Block reasons use `human-engine-*` prefix for
  traceability (`human-engine-stay-silent`, `human-engine-group-fail-closed`).
