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
| `socialMemory.personStore` | bool | `false` | Person store: ONE profile file per AGENT (cross-session persons, idempotent migration moves legacy session files to `legacy-sessions/`) — Plan 019 |
| `socialMemory.schemaV2` | bool | `false` | V2 person schema (relationship/open_threads/emotional_state with design caps, merge-level self-exclusion) — Plan 020 |
| `language` | string | `"de"` | Language pack for prompts/labels/trigger wordlists; per-agent overridable via agentProfiles; `de` byte-identical, non-de groups run documented reduced proactive mode — Plan 029 |
| `autoconfig` | bool | `false` | Log advisory config warnings on startup |
| `decide.temperature` | number | `0.2` | Decide temperature |
| `decide.v2Contract` | bool | `false` | Decide outputs JSON `{decision, reason, addressed_to}` (maxTokens 48) with token fallback — Plan 024 |
| `threads.enabled` | bool | `false` | Thread state: persisted openTopics/agentAbsentSince + absence/thread context line in decide — Plan 022 |
| `threads.absenceThresholdHours` | number | `24` | Absence threshold for the decide context line |
| `threads.topicExpiryDays` | number | `14` | Open-topic expiry |
| `selfVoice.enabled` | bool | `false` | Self-voice prototype (extract own-line voice card per agent; wired into the persona after owner accept via `/soul voice` — Plans 031/033) |
| `humanize.maxBubbles` | number | `5` | Max reply bubbles |
| `humanize.temperature` | number | `0.3` | Naturalization temperature (lowered 0.9→0.3 with Plan 615 to stop proxy rewrites) |
| `humanize.requireFaithfulSplit` | bool | `true` | Humanizer output must be a faithful split of the drafted reply (no proxy rewrite); non-faithful output is rejected/falls back — Plan 615 |
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
| `proactive.triggers.returnGreeting` | bool | `false` | return_greeting trigger (meaningful >24h absence, own guards + budget, 7-day per-scope gap; tick-scanned) — Plan 023 |
| `proactive.triggers.threadCallback` | bool | `false` | thread_callback trigger (agent-owed open threads, ≥20h old) — Plan 023 |
| `proactive.returnGreetingBudgetPerDay` | number | `1` | Own daily budget for return_greeting |
| `proactive.threadCallbackMinAgeHours` | number | `20` | Min age for a thread-callback candidate |
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
| `dmProactive.topicMaxAttempts` | number | `3` | Max delivery attempts per open loop/topic before it is suppressed (durable ledger, Plan 619) |
| `dmProactive.topicCooldownMinutes` | number | `240` | Per-topic cooldown after an attempt (Plan 619) |
| `dmProactive.openAttemptCooldownMinutes` | number | `240` | Cooldown after any open-loop attempt (Plan 619) |
| `mood.enabled` | bool | `false` | Mood layer master switch — stateful valence/energy per DM session (Plan 570) |
| `mood.refreshEvery` / `mood.refreshMinutes` | number | `5` / `0` | Appraisal cadence (message-count and/or minutes; count-based wins while minutes=0) |
| `mood.decayHours` | number | `6` | Hours without update before valence/energy decay toward neutral (decay now persists across appraisals — Plan 030) |
| `mood.maxShiftPerUpdate` | number | `1` | Max |Δ| per axis per appraisal |
| `mood.groupsEnabled` | bool | `false` | GROUP mood: appraisal on group sessions, room-energy line in decide, mood-coupled timing (±12 %) and split brevity — Plan 030 |
| `mood.groupsRefreshEvery` | number | `10` | Group appraisal cadence (messages) |
| `initiative.enabled` | bool | `false` | Initiative (proactive task & memory engine) master switch — default OFF (shadow-first; when off: zero files, zero injection) |
| `initiative.shadow` | bool | `true` | Log would-be initiative sends without delivering |
| `initiative.agents` | string[] | `[]` | Initiative agent allowlist override (empty = all scoped agents) |
| `initiative.scopes` | string[] | `["group"]` | Which session kinds participate (`group` / `dm`) |
| `initiative.everyMinutes` | number | `60` | Ambient per-scope tick cadence; `0` disables the tick |
| `initiative.activeHours` | {start,end,timezone} | `08:00`/`22:00`/`Europe/Berlin` | Active-hours window; equal start/end = always inactive |
| `initiative.quietStart` / `initiative.quietEnd` | string | `"22:00"` / `"07:00"` | Quiet-hours window (no sends) |
| `initiative.maxActsPerDay` | number | `2` | Max initiative sends per scope per day |
| `initiative.minGapMinutes` | number | `240` | Min gap between initiative sends AND shared with `proactive` via the outbox |
| `initiative.minGapAfterAgentSpeakMinutes` | number | `30` | Min gap after the agent last spoke |
| `initiative.hotWindowMinutes` | number | `15` | Skip acting right after a member message |
| `initiative.firstNudgeMinutes` | number | `120` | Age before an untouched task is first considered |
| `initiative.taskExpiryDays` | number | `30` | Task expiry horizon |
| `initiative.probability` | number | `0.8` | Probability floor for acting |
| `initiative.cooldownBaseMinutes` | number | `240` | Base per-task cooldown after an act |
| `initiative.maxContextChars` | number | `600` | Max chars of the recall context line |
| `initiative.maxOpenTasks` | number | `20` | Max open tasks kept per scope |
| `initiative.capture.keywords` | bool | `true` | Keyword-triggered task capture |
| `initiative.capture.everyMessages` | number | `20` | Cadence-based capture (messages) |
| `initiative.capture.everyMinutes` | number | `0` | Cadence-based capture (minutes; 0 = count-based only) |
| `initiative.directives.enabled` | bool | `true` | Standing-instruction capture |
| `initiative.directives.maxPerScope` | number | `10` | Max standing directives per scope |

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
| `state/social-memory/<agentId>/<sessionKey>.json` | Social memory profiles per agent × session (legacy shape; when `personStore:true` these migrate into the person store, files MOVE to `legacy-sessions/` — never deleted) |
| `state/social-memory/<agentId>.json` | Person store (Plan 019, when `socialMemory.personStore:true`): ONE profile per agent `{version:1, people:{…}}`, cross-session per-human; per-agent 64 KB oversize eviction + maxPeople |
| `state/social-threads/<agentId>/<sessionKey>.json` | Thread state (Plan 022, when `threads.enabled`): `{version:1, openTopics, lastAgentSpeakTs, lastGroupActivityTs, agentAbsentSince}`; rebuild from observed store + person profiles when missing |
| `state/self-voice/<agentId>.json` | Self-voice card state (Plan 031 prototype, `selfVoice.enabled`): version 1, preview/accept/reset semantics |
| `state/observed/<sessionKey>.jsonl` | Silenced-member AND agent-own-reply lines (Plan 528), 200-line rotation; readObserved is tail-read + mtime/size cached (Plan 013) |
| `state/proactive.json` | Proactive budgets/cooldowns, format v2: `{version:2, agents:{<agentId>:{counters,cooldowns,engagements}}}`; v1 flat scope-keys migrate on load (split at first `::`, no-agent → `__legacy__`) (Plan 005) |
| `state/dm-proactive-state.json` | DM-proactive v4 (Plan 017): `{version:4, agents:{<agentId>:{sentIds,byKind,budget}}}` — budget now per-agent (was flat cross-agent); v3 flat `scopes` migrate on load, CLI reads per-agent bucket first with flat fallback |
| `state/dm-proactive.jsonl` | DM-proactive shadow/live log v2 (14-day retention, outcome backfill) |
| `state/mood/<agentId>/<sessionKey>.json` | Mood layer: per-session valence/energy state (DM sessions always; group sessions when `mood.groupsEnabled:true`) (Plan 570/030) |
| `state/initiative/<agentId>/<scope>.json` | Initiative tasks/directives + durable open-loop ledger state per agent×scope (Plans 613/617) |
| `state/initiative.jsonl` | Initiative shadow/live act log (14-day retention, outcome backfill) |
| `state/proactivity-outbox.json` | Shared per-scope "last proactive outbound" (min-gap budget shared by `proactive` + `initiative`) — Plan 613 |

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

## Initiative (proactive task & memory engine)

Config lives under `plugins.entries["human-engine"].config.initiative`; see the
Config-keys table above and `openclaw.plugin.json` for the full schema with
defaults. **The feature is DEFAULT-OFF** (`initiative.enabled:false`): until
explicitly enabled it creates no `state/initiative/` files, injects no context,
and changes no behavior.

### `/initiative` command (manual operator surface, Plan 614)

Inspect or manage tasks & directives from the chat — works even while the
feature is disabled (`initiative.enabled:false`), since it operates directly on
the per-scope state:

| Subcommand | Effect |
|------------|--------|
| `/initiative` or `/initiative list` | List open tasks for this session (agent-wide when no session context) |
| `/initiative add <text>` | Add an open task |
| `/initiative done <index\|id-prefix>` | Mark a task done (1-based index in listed order, or ≥4-char id prefix) |
| `/initiative forget <index\|id-prefix>` | Mark a task expired |
| `/initiative directive <text>` | Add a standing instruction |
| `/initiative directives` | List standing instructions |
| `/initiative help` | Usage block |

Replies are capped at 1500 chars; agent-wide scope labels are non-PII (never
the raw JID).

### Shadow window KPIs (`state/initiative.jsonl`)

While `initiative.shadow:true`, candidates are captured to the shadow log (one
line per candidate, 14-day retention) but never delivered. Before flipping any
agent to live, review the shadow log over a window and confirm:

- ≥ N captured candidates (enough signal to judge),
- ≥ X % engaged — `outcome.repliedWithin48h === true` (the group actually
  responds to the would-be acts),
- 0 gate violations (the `gate.reasons` array should always be empty on acted
  candidates — a reason present on an ACT entry is a bug worth flagging).

### Per-agent live flip

Only after the shadow window looks healthy, flip ONE agent at a time:

```jsonc
"agentProfiles": { "<agentId>": { "initiative": { "shadow": false } } }
```

Keep the master `initiative.enabled:true` and other agents in shadow. Re-review
the per-agent log after each flip before moving the next.

### Kill-switch

Any time, the whole feature off:

```jsonc
"initiative": { "enabled": false }
```

This returns the plugin to pre-initiative behavior (no files, no injection, no
ticks). Per-agent: remove the `agentProfiles["<agentId>"].initiative` block or
set `shadow:true` again.

No real names/numbers are used here by design — apply the KPIs to whatever
agent/room you are reviewing.

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

## Wave-2 rollout notes (Plans 009–032 + 033–035)

**LIVE STATUS (2026-09-10, Operator-Aktivierung):** alle Verständnis-/Memory-
/Persönlichkeits-Flags sind AKTIV: `personStore: true`, `schemaV2: true`,
`threads.enabled: true`, `decide.v2Contract: true`,
`mood.groupsEnabled: true`, `selfVoice.enabled: true`,
`proactive.triggers.returnGreeting/threadCallback: true` (alle 8 Trigger-
Keys explizit gesetzt — One-Level-Merge), `reactions.hintEnabled: true`
(model-routed Emoji-Reaktionen in Gruppen-Turns; Host-Gate
`channels.whatsapp.reactionLevel: "extensive"` — bei Reaktions-Übertrieb
zuerst auf `"minimal"`, dann Hint abschwächen; Rollback = der eine Flag). Backups:
`~/backups/openclaw.json.bak-wave2-activation-*` +
`~/backups/human-engine-state-social-memory-*.tar.gz`.

- Person-Store-Migration läuft LAZY beim ersten Profil-Zugriff je Agent
  (Ingest/Recall nach Traffic); Legacy-Dateien wandern nach
  `legacy-sessions/`, nichts wird gelöscht.
- Self-Voice: Extract startet ab ≥30 eigenen Zeilen je Agent; die Karte wird
  erst nach Owner-ACCEPT aktiv (`/soul voice` → preview → `accept`).
  Objektiv sichtbar: `selfVoiceLen=N` in der decide-ctx-Logzeile.
- Decide-Gründe: mit `v2Contract` zeigt die claim-Logzeile
  `reason=… addressed=…` je Entscheidung (Token-Fallback = Modell-Regression-
  Signal).
- **Proaktive SENDS bleiben im Shadow** (`proactive.shadow: true`,
  `dmProactive.shadow: true`) — return_greeting/thread_callback-Kandidaten
  werden geloggt, nicht gesendet; die Shadow-Fenster sind die bestehenden
  Owner-Gates (Q4-Kriterien).
