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
| Naturalize | `lib/naturalize.js` | Splits reply into bubbles, adds timing delays, attaches group TTS audio per bubble |
| Local engine | `lib/local-engine.js` | LLM-based decide + naturalize via host's `llm.complete` |
| Config | `lib/config.js` | Default config + one-level deep merge from OpenClaw API |
| Voice card | `lib/voice-card.js` | Style-profile learning, onBeforePromptBuild injection |
| Social memory | `lib/social-memory.js` | Person-centric fact extraction, cadence, recall (coalesced writes) |
| Observed store | `lib/observed-store.js` | Plugin-local persistence of silenced + own-reply lines to `state/observed/` |
| Proactive | `lib/proactive.js` | 3-stage proactive funnel (triggers → anti-annoyance → subagent.run) |
| DM gate core | `lib/dm-gate-core.js` | Shared DM follow-up gate rules (hook + CLI, one source of truth) |
| DM proactive v2 | `lib/dm-proactive.js` | Envelope adapter `[[fu:…]]` → gate → shadow/live dispatch, byKind cadence, outcome backfill |
| DayFit | `lib/dayfit.js` | DayFit bands from `~/.openclaw/state/kevin-activity.json` (quiet-hours + day-key aware) |
| Persona | `lib/persona.js` | Soul prompt + voice-card assembly |
| Soul | `lib/soul.js` | SOUL.md section-merge enhancement via local LLM, auto-enhance on start |
| Timing engine | `lib/timing-engine.js` | WPM-based delay calculation, night mode |
| Anti-tell | `lib/anti-tell.js` | Suppress tell-like phrases in agent output |
| Style stats | `lib/style-stats.js` | Communication pattern logging |
| State | `lib/state.js` | Ephemeral in-memory Maps with size capping |
| Contacts | `lib/contacts.js` | contacts.md parsing + sender-ID → name resolution |
| Autoconfig | `lib/autoconfig.js` | Advisory config warnings (no channel writes) |
| Messages | `lib/messages.js` | Message conversion + validation utilities |
| Local prompts | `lib/local-prompts.js` | System prompts for all LLM calls |

## Execution flow

Hook semantics verified against OpenClaw 2026.6.11: `before_agent_reply`
fires **before the model run** with the cleaned inbound body; returning
`{handled: true}` short-circuits the turn with `NO_REPLY`. `reply_dispatch`
fires in the delivery pipeline with a dispatcher. `reply_payload_sending`
fires per outbound payload with the real reply text and supports
`{cancel: true}`.

1. **`message_received`** hook: gate records chat type, caches the resolved
   sender name, pushes the transcript peek line, ingests into social memory
   (chat sessions only), and feeds the proactive inbound funnel.
2. **`before_agent_reply`** hook (gate): runs the turn-taking decide on the
   cleaned inbound body. Hard triggers (DM, media, agent-name/alias mention,
   agent-contact mention, quote-reply to the agent's own message)
   short-circuit to `speak` with zero LLM calls; otherwise the local LLM
   decides with persona + transcript context. The transcript is merged from
   three layers — hydrated session transcript (session-transcript-runtime
   SDK, ts backfilled from `e.timestamp`/`e.message.timestamp`,
   `NO_REPLY` assistant artifacts filtered), the observed store
   (`state/observed/`, also holds the agent's own replies since Plan 528),
   and the in-memory peek (last 20 lines) — tail-deduped, chronologically
   stable-sorted, `slice(-20)`. Group decides log a PII-safe `decide-ctx`
   line (line/own/speaker/age counts, redacted session key).
   - `speak` → speak epoch `{epoch, ts}` recorded, social memory recalled.
   - `stay_silent` → message persisted to the observed store and
     `{handled: true}` returned — the turn is silenced before the LLM call,
     inside its own turn. No cross-turn state.
   - `null` (engine unavailable) → DM fails open; group fails closed
     (`{handled: true}`).
3. **`before_agent_run`** hook: transcript/social-memory bookkeeping for
   turns that actually run (silenced turns never reach this hook).
4. **`before_prompt_build`** hook: gate injects observed context (drained
   once) and social-memory recall. Voice card injects style profile into
   system context.
5. **Agent run** produces a reply.
6. **`reply_dispatch`** hook (naturalize): on speak turns, stashes the
   dispatcher on a per-session FIFO queue (max 8) WITHOUT completing a
   previous one; entries carry `consumed: false` and bind their epoch at
   first capture.
7. **`reply_payload_sending`** hook (naturalize): captures the real reply
   text (`{cancel: true}` suppresses the original payload), debounces
   multiple payloads into one draft. System fallback payloads
   (`NO_VISIBLE_REPLY_FALLBACK_TEXT`, `QUEUE_CAP_REJECTION_TEXT` — the core
   injects these on tool-call-turn races) are cancelled, never captured.
   The draft binds FIFO to the OLDEST unconsumed dispatcher.
8. **Flush**: the draft is humanized by the local LLM into 1–5 bubbles and
   re-delivered via the bound dispatcher's `sendBlockReply` with
   timing-engine delays (typing WPM, night mode). Raw-draft fallback on LLM
   error or supersede. `markComplete` after the last bubble.
   - **Group TTS attachment (Plan 548b)**: for group sessions with
     session TTS enabled, each bubble payload runs through the framework
     TTS runtime (`maybeApplyTtsToPayload`, kind `"final"`, payload keeps
     `text` and gains `mediaUrl` + `audioAsVoice` — one voice message per
     bubble, no text alone, HART). The TTS context is stashed per
     dispatcher at `reply_dispatch` (`buildTtsContext`: `sessionTtsAuto`,
     channel from `ttsChannel` or the session key). Any TTS failure or
     missing SDK shim degrades to text-only; `deliverWithRetry` retries
     text-only if the host rejects the media-carrying payload — the reply
     is never lost. The DM path is untouched (no TTS ever applied there).
   - **Silence cleanup**: when a later message is decided `stay_silent`,
     `onSilence` completes/removes only UNconsumed queue entries — a pending
     reply on an older dispatcher survives a later message's silence (Plan
     545; the eager displacement-completion it replaced silently dropped
     replies).
9. **Proactive funnel** (independent of the reactive gate, off by default):
   a 30-min unref'd tick runs candidate triggers (unanswered question,
   stalled exchange, context match, follow-up commitment) through an
   anti-annoyance gate (budget, min gap, adaptive cooldown, quiet hours,
   seeded probability). In `shadow:true` it only logs; otherwise it
    delivers via `api.runtime.subagent.run`, which does not re-enter
    `before_agent_reply` — no gate loop.
10. **DM-proactive v2 funnel** (opt-in, shadow-first; see
    [design/dm-proactive-v2.md](../design/dm-proactive-v2.md)):
    `message_sending` parses a `[[fu:{…}]]` first-line envelope
    (`parseFollowupEnvelope`); plain text passes through untouched
    (fail-open). Production ctx carries NO `sessionKey` — the DM scope is
    derived from `event.to` (channel-prefix-stripped) + channel via
    `deriveDmFromEvent()` (Plan 536/546); cross-agent target resolution
    when several agents are configured. Kind is normalized
    (`normalizeFollowupKind`: `care` → `care_check_in`). Content starting
    with `[[fu:` is NEVER delivered raw — malformed envelopes are
    stripped+logged (shadow) or cancelled (live) (Plan 546). Envelope
    candidates run through the shared
    `lib/dm-gate-core.js` rules (deadline grace, DayFit bands via
    `~/.openclaw/state/kevin-activity.json`, byKind cadence from
    `state/dm-proactive-state.json`, sentIds idempotency, care/soft tiers).
    In `shadow:true` gate-passed candidates deliver with the envelope
    stripped and a `state/dm-proactive.jsonl` v2 entry (14-day retention);
    gate-fail and duplicate cancel + log in BOTH modes (Plan 536). Inbound
    replies backfill `outcome.repliedWithin48h`. The followup-cron MUST
    pre-check via `bin/followup-gate.mjs check` (same gate-core, exit
    0=pass / 1=block / 2=no-envelope / 3=usage).

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
- **Silence is synchronous**: stay_silent returns `{handled: true}` from
  `before_agent_reply` — the same hook that ran the decide — so a stay_silent
  turn never starts an LLM run and can never leak a reply. There is no
  cross-turn silence state (the 0.2.x silentEpoch/TTL machinery is gone).
- **Never block `before_agent_run`**: returning a block from that hook writes
  a user-facing "blocked" text that wedges the session via
  pendingFinalDelivery recovery on restart. `message_sending` cancels any
  residual block text as defense-in-depth.
- **Real reply text only**: bubbles are built from the actual agent reply
  captured at `reply_payload_sending`, never from inbound text.
- **Scoping is uniform**: every handler (gate, naturalize, voice card)
  checks `enabled` and `agents` before doing any work.
- **LLM-call purposes**: every `llm.complete` call carries a purpose string
  for traceability: `human-engine-decide`, `human-engine-humanize`,
  `human-engine-extract` (voice card), `human-engine-soul`,
  `human-engine-memory` (social memory).
- **Decide context is chronological**: layers are merged tail-deduped then
  stable-sorted by ts (ts-less entries last); the current message is the
  final line. Regressing to layer concatenation re-introduces the
  false-`stay_silent` bug where the prompt tail looked days old
  (live-verified 2026-09-04, Plan 529).
