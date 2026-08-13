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
| `soulAutoEnhance` | bool | `true` | Auto-enhance on startup (once, marker-gated) |
| `antiTell` | bool | `true` | Suppress tell-like phrases |
| `styleStats` | bool | `true` | Log style stats |
| `socialLearning.enabled` | bool | `true` | Voice card learning (gates the prompt-build handler) |
| `socialLearning.perSessionCard` | bool | `true` | Per-session voice card |
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

There is no model-override key: every LLM call uses the host's built-in
`llm.complete`. Nested objects deep-merge one level over defaults, so a
partial override (e.g. only `timing.typingWpm`) keeps the sibling defaults.

## State files

All under `<plugin-dir>/state/` (or `$HUMAN_ENGINE_STATE_DIR`), created at
runtime, never committed. Files are written 0600, dirs 0700, via tmp+rename.

| Path | Purpose |
|------|---------|
| `state/social-learning-cache.json` | Voice card cache (disk-persisted) |
| `state/social-memory/<agentId>/<sessionKey>.json` | Social memory profiles per agent × session |
| `state/observed/<sessionKey>.jsonl` | Silenced-message observation log (plugin-local) |
| `state/proactive.json` | Proactive budgets/cooldowns (persisted) |

Two files live next to the SOUL.md, NOT under `state/`:
| Path | Purpose |
|------|---------|
| `<soul-dir>/.soul_auto_enhanced` | Marker that auto-enhance has run |
| `<soul-dir>/SOUL.md.bak` | SOUL.md backup from `/soul enhance` |

`logs/` (when `socialLearning.logRequests` is enabled) holds
`social-learning-requests.jsonl`. `.gitignore` excludes `state/`, `logs/`, and
`*.log`.

## Secrets

No secrets or credentials. The plugin uses the host's built-in LLM exclusively.
No API keys, no tokens.
