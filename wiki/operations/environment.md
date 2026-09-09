# Environment

## Config keys

All config lives under `plugins.entries["human-engine"].config` in the OpenClaw
config. See `openclaw.plugin.json` for the full schema with defaults
(`additionalProperties: false` — unknown keys are rejected).

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `enabled` | bool | `true` | Master switch |
| `agents` | string[] | `[]` | Allowed agent IDs (empty = all) |
| `agentName` | string | `"OpenClaw"` | Agent display name |
| `soulPath` | string | `""` | Custom SOUL.md path |
| `contactsPath` | string | `""` | contacts.md table for sender-ID → name resolution |
| `agentProfiles` | object | `{}` | Per-agent identity overrides, keyed by agent ID (Plan 002/003) — see below |
| `soulAutoEnhance` | bool | `true` | Auto-enhance on startup (once, marker-gated) |
| `antiTell` | bool | `true` | Suppress tell-like phrases |
| `styleStats` | bool | `true` | Log style stats |
| `socialLearning.enabled` | bool | `true` | Voice card learning (gates the prompt-build handler) |
| `socialLearning.perSessionCard` | bool | `true` | Per-session voice card; `false` = ONE card per agent (not one for all agents) — Plan 004 |
| `socialLearning.refreshEvery` | number | `5` | Message count between refreshes |
| `socialLearning.refreshMinutes` | number | `0` | Time-based refresh |
| `socialLearning.window` | number | `100` | Context window |
| `socialLearning.logRequests` | bool | `false` | Log voice-card LLM requests to `logs/` |
| `socialMemory.enabled` | bool | `true` | Social memory |
| `socialMemory.extractEvery` | number | `25` | Extraction cadence (messages) |
| `socialMemory.extractMinutes` | number | `0` | Time-based extraction |
| `socialMemory.maxPeople` | number | `50` | Max tracked people |
| `socialMemory.recallLimit` | number | `800` | Max recall chars |
| `autoconfig` | bool | `false` | Log advisory config warnings on startup |
| `decide.temperature` | number | `0.2` | Decide temperature |
| `humanize.maxBubbles` | number | `5` | Max reply bubbles |
| `humanize.temperature` | number | `0.9` | Naturalization temperature |
| `naturalize.speakEpochTtlMs` | number | `300000` | Speak-epoch expiry before a captured reply is dropped |
| `naturalize.disableDM` | bool | `false` | Skip bubble arming for direct chats — DM replies deliver as ONE raw message, no split/timing (Plan 587); groups unaffected |
| `timing.typingWpm` | number | `40` | Typing speed for delay calc |
| `timing.maxTypingMs` | number | `60000` | Max typing delay per bubble |
| `timing.maxBubbleGapMs` | number | `3000` | Max gap between bubbles |
| `timing.nightMode` | bool | `true` | Longer delays at night |
| `proactive.enabled` | bool | `false` | Enable the proactive turn-taking funnel |
| `proactive.shadow` | bool | `true` | Log would-be sends without delivering |
| `proactive.budgetPerDay` | number | `2` | Max proactive messages per day |
| `proactive.minGapMinutes` | number | `180` | Min gap between proactive sends |
| `proactive.quietStart` / `proactive.quietEnd` | string | `"23:00"` / `"07:00"` | Quiet hours window |
| `proactive.probability` | number | `0.5` | Seeded probability floor |
| `proactive.cooldownBaseMinutes` | number | `180` | Base cooldown after a send |
| `proactive.triggers.*` | bool | `true` | Candidate triggers (unanswered_question, stalled_exchange, context_match, follow_up_commitment) |
| `dmProactive.agents` | array | `[]` | DM-proactive allowlist override — when non-empty it OVERRIDES global `cfg.agents` for the DM-proactive subtree only (Plan 005, adopted from 586) |
| `dmProactive.enabled` | bool | `false` | Enable DM follow-up rendering |
| `dmProactive.shadow` | bool | `true` | Log would-be sends without delivering |
| `dmProactive.budgetPerDay` | number | `2` | Max DM follow-ups per day |
| `dmProactive.minGapMinutes` | number | `180` | Min gap between DM follow-ups |
| `dmProactive.quietStart` / `dmProactive.quietEnd` | string | `"23:00"` / `"07:00"` | Quiet hours window (Europe/Berlin) |
| `dmProactive.careBudgetPerDay` | number | `1` | Extra budget for care-tier candidates |
| `dmProactive.dayFitReduceHours` | number | `4` | Reduce sends when DayFit band is this many hours stale |
| `dmProactive.dayFitPauseHours` | number | `12` | Pause sends when DayFit band is this many hours stale |
| `dmProactive.dayFitActivityPath` | string | `""` | Per-agent DayFit activity file override (falls back to the global kevin-activity.json default) |
| `dmProactive.inferredCapPerDay` | number | `2` | Cap for inferred (non-envelope) candidates |
| `mood.enabled` | bool | `false` | Mood layer master switch — stateful valence/energy per DM session, dm-only (Plan 570) |
| `mood.refreshEvery` / `mood.refreshMinutes` | number | `5` / `0` | Appraisal cadence (message-count and/or minutes; count-based wins while minutes=0) |
| `mood.decayHours` | number | `6` | Hours without update before valence/energy decay toward neutral |
| `mood.maxShiftPerUpdate` | number | `1` | Max |Δ| per axis per appraisal |

There is no model-override key: every LLM call uses the host's built-in
`llm.complete`. Nested objects deep-merge one level over defaults, so a
partial override (e.g. only `timing.typingWpm`) keeps the sibling defaults.

## Per-agent profiles (Plan 002/003)

`agentProfiles` keys multi-tenancy by agent ID. Every Identity consumer
(name, aliases, contacts table, SOUL, self-filter) resolves per agent; a
second agent no longer runs under the global name/contacts/SOUL.

```json
{
  "agents": ["hori-wa", "kletter"],
  "agentProfiles": {
    "hori-wa":  { "agentName": "Yuki", "agentAliases": ["Yuki (Bot)"], "contactsPath": ".../contacts-hori.md", "soulPath": ".../SOUL-hori.md" },
    "kletter":  { "agentName": "Hori", "agentAliases": [],             "contactsPath": ".../contacts-kletter.md", "soulPath": ".../SOUL-kletter.md" }
  }
}
```

**Resolution order per key:** `agentProfiles[agentId][key]` → global `cfg[key]`
→ built-in default. Without a profile the behavior is byte-for-byte the
global (single-agent) behavior. Nested profile objects merge ONE level over
the global (same semantics as the top-level deep-merge). A profile never
widens the `agents` allowlist (it only overrides values).

**Which keys are per-agent:** `agentName`, `agentAliases`, `contactsPath`,
`soulPath`, plus any config key (e.g. `soulAutoEnhance`, nested `socialMemory`,
`dmProactive`, `mood`). `bin/followup-gate.mjs` and the DayFit single-human
tracking remain global until Plan 005.

For the step-by-step, see [Onboarding multi-tenant](./onboarding-multi-tenant.md).

## State files

All under `<plugin-dir>/state/` (or `$HUMAN_ENGINE_STATE_DIR`), created at
runtime, never committed. Files are written 0600, dirs 0700, via tmp+rename.

| Path | Purpose |
|------|---------|
| `state/social-learning-cache.json` | Voice card cache, format v2: per-agent buckets `{version:2, agents:{<agentId>:{cache,counter}}}`; v1 flat files migrate on load (Plan 004) |
| `state/social-memory/<agentId>/<sessionKey>.json` | Social memory profiles per agent × session |
| `state/observed/<sessionKey>.jsonl` | Silenced-member AND agent-own-reply lines (Plan 528), 200-line rotation |
| `state/proactive.json` | Proactive budgets/cooldowns, format v2: `{version:2, agents:{<agentId>:{counters,cooldowns,engagements}}}`; v1 flat scope-keys migrate on load (split at first `::`, no-agent → `__legacy__`) (Plan 005) |
| `state/dm-proactive-state.json` | DM-proactive v3: `{version:3, scopes, sentIds:{<agentId>:[…]}, byKind:{<agentId>:{kind:{…}}}}`; v2 flat `sentIds`/`byKind` migrate to a `__legacy__` bucket (reads fall back, writes never touch it) (Plan 005) |
| `state/dm-proactive.jsonl` | DM-proactive shadow/live log v2 (14-day retention, outcome backfill) |
| `state/mood/<agentId>/<sessionKey>.json` | Mood layer: per-DM-session valence/energy state (Plan 570) |

One file is read (never written) from OUTSIDE the plugin dir:
| Path | Purpose |
|------|---------|
| `~/.openclaw/state/kevin-activity.json` | DayFit input: `{ lastKnownKevinActivityAtMs }` (Plan 521) |

Two files live next to the SOUL.md, NOT under `state/`:
| Path | Purpose |
|------|---------|
| `<soul-dir>/.soul_auto_enhanced` | Marker that auto-enhance has run |
| `<soul-dir>/SOUL.md.bak` | SOUL.md backup from `/soul enhance` |

`logs/` (when `socialLearning.logRequests` is enabled) holds
`social-learning-requests.jsonl`. `.gitignore` excludes `state/`, `logs/`, and
`*.log`.

## Host/channel config dependencies (OpenClaw config, not plugin config)

The WhatsApp pipeline silently degrades without these channel-level keys —
all live-verified 2026-09-04:

| Key | Required value | Missing-value symptom |
|-----|----------------|----------------------|
| `channels.whatsapp.pluginHooks.messageReceived` | `true` | `message_received` hook never fires: no quote-reply detection (`replyToAgent` stays false), no sender cache, no social-memory ingest |
| `channels.whatsapp.contextVisibility` | `"allowlist_quote"` | `"allowlist"` drops quotes from senders outside the allowlist (incl. the bot's own messages — i.e. every quote-reply TO the agent) before hooks see them |
| `channels.whatsapp.groupAllowFrom` | all group members who should be processed | Senders outside are dropped BEFORE the inbound log: no ack, no session entry, no gate — completely silent |

## Secrets

No secrets or credentials. The plugin uses the host's built-in LLM exclusively.
No API keys, no tokens.
