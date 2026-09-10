# Human Engine quickstart

A fully self-hosted OpenClaw plugin that adds social intelligence to agents:
turn-taking gate, bubble naturalization with human timing, voice card,
persona/soul enhancement, and social memory. Runs entirely on the host's
built-in LLM with no cloud dependencies.

## Start here

- [Architecture overview](./architecture/overview.md) — hook pipeline, module roles, execution flow.
- [Build, test, lint](./operations/build-test-lint.md) — exact commands.
- [Environment](./operations/environment.md) — config keys, state files.
- [Onboarding multi-tenant](./operations/onboarding-multi-tenant.md) — add a new agent or WhatsApp group/channel.
- [Source map](./source-map.md) — file tree with descriptions.

## What this repository does

- Decides when the agent should speak or stay silent (turn-taking gate). The
  decide is register-aware (full persona incl. voice card, Plan 028), receives
  compact person memory before the verdict (Plan 021), an absence/open-thread
  context line (Plan 022, `threads.enabled`), a room-energy line (Plan 030,
  `mood.groupsEnabled`), and an opt-in JSON contract with audit reasons
  (Plan 024, `decide.v2Contract`). Verdict parsing tolerates model noise
  (fences/JSON/prose, Plan 016).
- Naturalizes multi-bubble replies with human-like timing — groups by default;
  DMs can opt out via `naturalize.disableDM: true` (DM replies then deliver as
  one raw message, no split/timing — Plan 587; own-reply persistence still runs).
- Attaches framework TTS audio to group bubbles (HART: each bubble carries its
  text AND its own voice-note audio in one payload — never voice-only, degrades
  to text-only on host reject); DM path untouched (Plan 548b, commit `fcee7b5`).
- Maintains per-agent persona prompts with soul auto-enhance.
- Learns a voice card (communication-style profile) per session.
- Extracts and recalls person-centric social memory on cadence. Memory is
  optionally per-HUMAN cross-session (`socialMemory.personStore`, Plan 019 —
  one profile per agent, legacy session files migrate into
  `legacy-sessions/`), and optionally carries relationship texture:
  `relationship`, `open_threads`, `emotional_state` (`socialMemory.schemaV2`,
  Plan 020). Recall renders texture (Plan 021) and a bounded compact recall
  feeds the decide prompt. Ingest dedupes hook refires (Plan 011) so the
  extract cadence counts REAL messages.
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
  (`stripMetaCommentary`) on both the humanize and raw-fallback paths, plus a
  runtime tell backstop (`sanitizeTells`, Plan 027): mechanical tells
  (em-dash/markdown/lists/headers) are sanitized per draft AND per bubble,
  fail-open; semantic tells are logged only.
- Detects pure-commentary output (model returned only reasoning, no reply)
  and regenerates a real reply once; suppresses instead of leaking commentary
  if regeneration fails.
  - Runs an opt-in proactive turn-taking funnel (shadow-first).
  - **Initiative (Plan 613, default OFF)**: a per-agent×scope proactive task &
    memory engine. Captures tasks/standing directives a member hands the agent
    (keyword/cadence-triggered LLM extraction), recalls the open ones into the
    agent context (`before_prompt_build`), and a 5-min tick acts on due tasks
    through a deterministic anti-annoyance gate + LLM decide + render, sharing
    the outbound budget with `proactive`. Shadow-first — `initiative.enabled`
    defaults false; when off it creates no files, injects no context, and never
    sends. See [environment.md](./operations/environment.md).
  - Renders due DM follow-ups from `[[fu:…]]` envelopes through a shared
   gate-core (shadow delivers gate-passed candidates envelope-stripped;
   gate-fail/duplicate cancel; `[[fu:`-prefixed content is never delivered
   raw; kind normalization `care`→`care_check_in`; sentIds idempotency,
   byKind cadence, outcome backfill; DM scope derived from `event.to`
   with channel-prefix stripping — production ctx has no `sessionKey`)
   — see [design/dm-proactive-v2.md](./design/dm-proactive-v2.md).
 - **Multi-tenant by config (Plans 001–008)**: add an agent or a WhatsApp
   group declaratively — `agentProfiles` entry + contacts.md + SOUL.md, no
   code. Identity (name/aliases/contacts/soul/self-filter), voice cards,
   memory, proactive/dm-proactive budgets are isolated per agent; channel
   info derives from the sessionKey via the canonical scope parser.
 - Suppresses host system-fallback payloads at capture (`NO_VISIBLE_REPLY`,
   queue-cap rejection, and `⚠️ Agent run failed (model: …)`) — a failed
   agent run can never leak an error text as a "reply" (Plans 540/007).
 - Supports DM fail-open and group fail-closed safety modes.
 - Provides a parity-matrix contract for all behavioral capabilities.

## Key source files

| File | Role |
|------|------|
| `index.js` | Plugin entry point; registers hooks, wires modules, readSessionTranscript (ts backfill + NO_REPLY filter) |
| `lib/scope.js` | Canonical session-key parser (`agent:<id>:<channel>:<kind>:<rest>`): parseSessionKey/parseScope/isDmSessionKey/isChatSession/agentIdFromSessionKey — the ONLY place that parses key shape (Plans 001–008) |
| `lib/gate.js` | Turn-taking gate: decide speak/stay-silent per message; chronological transcript merge; per-agent identity via `resolveAgentConfigForSession` |
| `lib/naturalize.js` | Bubble naturalization: split, time, dispatch replies (per-bubble TTS via framework `maybeApplyTtsToPayload`, kind `final`); persistOwnReply; system-fallback filter incl. `⚠️ Agent run failed` (Plans 540/007) |
| `lib/local-engine.js` | Local LLM engine for decide + naturalize decisions; every `llm.complete` carries per-session `agentId` (Plan 008) |
| `lib/dm-gate-core.js` | Shared DM follow-up gate rules (hook + CLI, one source of truth) |
| `lib/dm-proactive.js` | DM-proactive v2: envelope adapter, cadence, shadow log, dispatch; per-agent sentIds/byKind buckets (state v3) |
| `lib/dayfit.js` | DayFit bands; activity path per-agent overridable via `dmProactive.dayFitActivityPath` (Plan 005) |
| `lib/mood.js` | Mood layer: stateful valence/energy per DM session, appraisal + decay, dm-only (Plan 570) |
| `bin/followup-gate.mjs` | CLI layer-1 pre-send check for the followup-cron; agent-aware (`isScopedDmAgent`, per-agent sentIds) |
| `lib/config.js` | Config resolution + `agentProfiles` per-agent overlay (`resolveAgentConfig`, Plan 002) + `dmProactiveAgents`/`isScopedDmAgent` (Plan 005) |
| `lib/voice-card.js` | Communication-style profile learning; per-agent cache buckets, disk format v2 with migration (Plan 004) |
| `lib/social-memory.js` | Person-centric fact extraction and recall; per-agent × session profiles, optional per-human person store (Plan 019) + schemaV2 texture (Plan 020) + recallCompact (Plan 021) |
| `lib/threads.js` | Persisted open-topic/absence state per scope + decide context line + rebuild from observed store (Plan 022, `threads.enabled`) |
| `lib/initiative.js` | Initiative engine (Plan 613, default-off): capture, recall, tick/gate/decide/render, shadow/live, attribution |
| `lib/initiative-store.js` | Initiative durable per-agent×scope state + shadow/live jsonl (14-day retention, outcome backfill) |
| `lib/proactivity-outbox.js` | Shared per-scope "last proactive outbound" store (proactive + initiative share a min-gap budget, Plan 613) |
| `lib/self-voice.js` | Self-voice prototype: extract the agent's OWN voice from own observed replies, preview/accept/reset behind `selfVoice.enabled` (Plan 031; persona wiring is follow-up 033) |
| `lib/timing-engine.js` | Human-typing timing calculation |
| `lib/persona.js` | Persona prompt building (soul + voice-card), per-path soul cache |
| `lib/state.js` | In-memory ephemeral state (Maps with size caps) |
| `lib/observed-store.js` | Silenced + own-reply persistence (`state/observed/*.jsonl`) |
| `lib/soul.js` | Soul/persona enhancement via local LLM |
| `openclaw.plugin.json` | Plugin manifest (id, name, config schema incl. `agentProfiles`) |
| `plans/` | improve-skill plan index (multi-tenancy wave 001–008) — see [plans.md](./plans.md) |

## Documentation map

- [Architecture](./architecture/overview.md)
- [Build, test, lint](./operations/build-test-lint.md)
- [Environment](./operations/environment.md)
- [Source map](./source-map.md)
- [Plans](./plans.md) — improve-skill wave index (001–008 multi-tenancy, 009–032 wave 2, all DONE; follow-up slots 033–035 reserved)
- Design: [conversational time](./design/conversational-time.md),
  [meaningful absence](./design/meaningful-absence.md),
  [social memory v2](./design/social-memory-v2.md),
  [DM proactive v2](./design/dm-proactive-v2.md)

## Notes for future agents

- **Adding an agent or WhatsApp group is declarative** — see
  [operations/onboarding-multi-tenant.md](./operations/onboarding-multi-tenant.md):
  contacts.md + SOUL.md + an `agentProfiles` entry + allowlist. No code.
  Misconfiguration warns loudly at startup via `autoconfig:true` (advisory).
- **Parse session keys ONLY via `lib/scope.js`** — never `split(":")[1]`
  by hand. The format is `agent:<agentId>:<channel>:<kind>:<rest>`; the
  canonical parser is the tenancy axis for all modules (Plan 001).
- **Every `llm.complete` call carries `agentId`** (SDK param, Plan 008) —
  the flush path runs outside the agent turn's async context, so the host
  CANNOT infer the caller; without the param it falls back to a default
  agent and routes model/credentials wrongly.
- **Plugin LLM authorization (hotfix 2026-09-10)**: the host throws
  `LLM_COMPLETION_NOT_AUTHORIZED` („Plugin LLM completion cannot override
  the target agent") for plugin llm.complete calls with `agentId` unless the
  PLUGIN ENTRY declares the permission. The permission lives at the
  openclaw.json ENTRY level — `"llm": {"allowAgentIdOverride": true}` as a
  SIBLING of `config` inside `plugins.entries["human-engine"]` — NOT in the
  plugin manifest and NOT in call params (both are ineffective; the call
  sites still pass `allowAgentIdOverride: true` for documentation/forward-
  compat). Symptom when missing: fully mute agent (decide → fail-closed).
  Any NEW llm.complete call site must carry `agentId`; the entry-level
  permission must never be removed.
- **System fallback payloads are never captured** (Plans 540/007): the
  core can inject `NO_VISIBLE_REPLY_FALLBACK_TEXT`,
  `QUEUE_CAP_REJECTION_TEXT` or `⚠️ Agent run failed (model: …)` during
  turn races/agent failures; `isSystemFallbackText` cancels them at
  capture — extending the list is mandatory when the host grows new ones.
- **Per-agent state is namespaced**: voice-card disk cache v2
  (`{version:2, agents:{<agentId>:{cache,counter}}}`, migrates flat v1 on
  load), proactive.json v2 and dm-proactive-state.json v3 (per-agent
  `sentIds`/`byKind` buckets, legacy v2 flat data migrates to a
  `__legacy__` read-only bucket). New state files MUST carry a `version`
  field and migrate-on-load (Plan 004 pattern).
- **Initiative is multi-tenant + default-OFF (Plan 613)**: per-agent overrides
  live at `agentProfiles["<agentId>"].initiative`, state is namespaced per
  agent×scope (`state/initiative/<agentId>/<scope>.json` + shared
  `state/initiative.jsonl` shadow/live log + shared `state/proactivity-outbox.json`).
  Flip ONE agent to live via `agentProfiles[...].initiative.shadow:false`
  after a healthy shadow window; kill-switch = `initiative.enabled:false`.
  No real names/numbers in code/tests/docs (public repo).
- **`/initiative` command (Plan 614)**: inspect/manage tasks & directives even
  while the feature is disabled (manual operator surface): `/initiative list`
  (or empty), `/initiative add <text>`, `/initiative done <index|id-prefix>`,
  `/initiative forget <index|id-prefix>`, `/initiative directive <text>`,
  `/initiative directives`, `/initiative help`. Agent-wide when no session
  context; scope labels are non-PII (never the raw JID).
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
- **Layers merge named-first** (observed → peek → hydrated → current): the
  dedup is first-wins and speaker-agnostic, so the named copy must win over
  the hydrated generic-`[User]` copy — otherwise the decide prompt shows
  anonymous chatter (live-verified, Plan 543). Hydrated lines now carry real
  sender labels via `message.__openclaw.senderName` when present.
- **Reply payloads bind FIFO to dispatchers** (Plan 545): captures bind to
  the OLDEST unconsumed armed dispatcher, displacement no longer completes
  the previous dispatcher eagerly, and silence (`onSilence`) cleans up only
  unconsumed entries. Regressing to latest-binding loses replies when a
  later message is silenced (live-verified silent loss, incident 12:01).
- **System fallback payloads are never captured** (Plan 540): the core can
  inject `NO_VISIBLE_REPLY_FALLBACK_TEXT` / `QUEUE_CAP_REJECTION_TEXT`
  during tool-call-turn races; `isSystemFallbackText` cancels them at
  capture.
- **Channel-config dependencies (OpenClaw config, NOT plugin config)** —
  without these the WhatsApp pipeline silently loses data:
  - `channels.whatsapp.pluginHooks.messageReceived: true` — without it the
    `message_received` hook NEVER fires for WhatsApp: no quote-reply
    detection (replyToAgent), no sender cache, no social-memory ingest.
  - `channels.whatsapp.contextVisibility: "allowlist_quote"` — `"allowlist"`
    drops quotes from senders outside the allowlist (including the bot's own
    messages, i.e. every quote-reply TO the agent) before they reach hooks.
  - `channels.whatsapp.groupAllowFrom` — senders outside it are dropped
    BEFORE the inbound log: no ack, no session entry, no gate. Silent.
- Tests use inline fakes plus `test/helpers/sdk-hook-ctx.js` for SDK-shaped
  hook contexts (no shared fake-api helper).
- Parity matrix at `test/parity-matrix.mjs` is the behavioral contract — must
  stay fully covered (87/87; two rows are tagged `kind:"static"` — review
  recommended, not a contract) before any release.

## Source map

See [source-map.md](./source-map.md) for the full file tree.
