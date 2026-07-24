# Environment

## Config keys

All config lives under `plugins.entries["human-engine"].config` in the OpenClaw
config. See `openclaw.plugin.json` for the full schema with defaults.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `enabled` | bool | `true` | Master switch |
| `agents` | string[] | `[]` | Allowed agent IDs (empty = all) |
| `agentName` | string | `"OpenClaw"` | Agent display name |
| `soulPath` | string | `""` | Custom SOUL.md path |
| `soulAutoEnhance` | bool | `true` | Auto-enhance on startup |
| `socialLearning.*` | object | — | Voice card learning config |
| `socialMemory.*` | object | — | Social memory extraction config |
| `gate.silentTtlMs` | number | `90000` | Max age of a stay_silent flag before it expires instead of silencing a reply |
| `decide.model` | string | `""` | Model override for decide |
| `decide.temperature` | number | `0.2` | Decide temperature |
| `humanize.*` | object | — | Naturalization model config |
| `timing.typingWpm` | number | `40` | Typing speed for delay calc |
| `timing.maxTypingMs` | number | `60000` | Max delay per dispatch |
| `timing.nightMode` | bool | `true` | Longer delays at night |

## State files

| Path | Purpose |
|------|---------|
| `state/social-learning-cache.json` | Voice card cache (disk-persisted) |
| `state/social-memory/<agentId>/<sessionKey>.json` | Social memory profiles per agent × session |
| `state/.soul_auto_enhanced` | Marker that auto-enhance has run |
| `state/*.bak` | SOUL.md backup from `/soul enhance` |

All under `<plugin-dir>/state/` — created at runtime, not committed.

## Secrets

No secrets or credentials. The plugin uses the host's built-in LLM exclusively.
No API keys, no tokens.
