# Human Engine — Local Conversation Engine for OpenClaw

A fully self-hosted OpenClaw plugin that adds social intelligence to your
agents: turn-taking gate, bubble naturalization with human timing, voice
card, persona/soul enhancement, and social memory.

**No external APIs, no Humalike transport, no cloud dependency.** Runs
entirely on the host's built-in LLM.

## Features

- **Turn-taking gate** — decides when the agent should speak or stay silent
  (DM fail-open, group fail-closed).
- **Bubble naturalization** — multi-bubble replies with human-like timing
  (typing speed, night mode).
- **Voice card / persona** — per-agent persona prompts, soul auto-enhance
  via local LLM.
- **Social memory** — bounded person-centric memory extracted on cadence,
  recalled on speak.
- **Agent scoping** — restrict to named agent IDs.
- **Kill-switch** — disable without unloading: `enabled: false`.

## Architecture

```
hooks (message_received → before_agent_run → before_prompt_build →
before_agent_reply → reply_dispatch)
  │
  ├── gate          ← decides speak/stay_silent (via local engine)
  ├── voice-card    ← persona context injected before prompt
  ├── naturalize    ← timing engine splits & delays bubbles
  └── social-memory ← ingest on message, recall on speak
```

## Install

```bash
# Clone anywhere (e.g. ~/human-engine)
git clone https://github.com/your-org/human-engine ~/human-engine
cd ~/human-engine && npm install

# Symlink for OpenClaw discovery
ln -s ~/human-engine ~/.openclaw/extensions/human-engine

# Enable
openclaw plugins enable human-engine

# (Optional) restrict to agents
openclaw config set plugins.entries["human-engine"].config.agents '["my-agent"]'

# (Optional) scoped groups — agent reads all messages there
openclaw config set channels.telegram.groups.'"<chatId>"'.requireMention false

# (Optional) decide model override
openclaw config set plugins.entries["human-engine"].config.decide.model gpt-4o

# Timing defaults (40 wpm, 60s max)
openclaw config set plugins.entries["human-engine"].config.timing.typingWpm 60
```

If your gateway uses a `plugins.allow` list, add `"human-engine"`.

Restart the gateway or wait for hot-reload (if supported).

## Disable / Kill-switch

```bash
# Soft kill — no restart needed
openclaw config set plugins.entries["human-engine"].config.enabled false

# Full unload
openclaw plugins disable human-engine
systemctl --user restart openclaw-gateway.service
```

## Config Reference

All keys under `plugins.entries["human-engine"].config`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Master switch |
| `agents` | string[] | `[]` | Allowed agent IDs (empty = all) |
| `agentName` | string | `"OpenClaw"` | Agent display name |
| `soulPath` | string | `""` | Custom SOUL.md path |
| `soulAutoEnhance` | bool | `true` | Auto-enhance on startup |
| `antiTell` | bool | `true` | Suppress tell-like phrases |
| `styleStats` | bool | `true` | Log style stats |
| `socialLearning.enabled` | bool | `true` | Voice card learning |
| `socialLearning.perSessionCard` | bool | `false` | Per-session voice card |
| `socialLearning.refreshEvery` | number | `5` | Message count between refreshes |
| `socialLearning.refreshMinutes` | number | `0` | Time-based refresh |
| `socialLearning.window` | number | `100` | Context window |
| `socialMemory.enabled` | bool | `true` | Social memory |
| `socialMemory.extractEvery` | number | `25` | Extraction cadence (messages) |
| `socialMemory.extractMinutes` | number | `0` | Time-based extraction |
| `socialMemory.maxPeople` | number | `50` | Max tracked people |
| `socialMemory.recallLimit` | number | `800` | Max recall chars |
| `autoconfig` | bool | `false` | Suggest config changes |
| `gate.silentTtlMs` | number | `90000` | Max age of a stay_silent flag before it expires instead of silencing a reply |
| `decide.model` | string | `""` | Model for decide engine |
| `decide.temperature` | number | `0.2` | Decide temperature |
| `humanize.model` | string | `""` | Model for naturalization |
| `humanize.maxBubbles` | number | `5` | Max reply bubbles |
| `humanize.temperature` | number | `0.9` | Naturalization temperature |
| `timing.typingWpm` | number | `40` | Typing speed for delay calc |
| `timing.maxTypingMs` | number | `60000` | Max delay per dispatch |
| `timing.nightMode` | bool | `true` | Longer delays at night |

## State Files

| Path | Purpose |
|------|---------|
| `state/social-learning-cache.json` | Voice card cache (disk-persisted) |
| `state/.soul_auto_enhanced` | Marker that auto-enhance has run |
| `state/*.bak` | SOUL.md backup from `/soul enhance` |

To reset: delete the relevant file and restart.

## Live Smoke Test

1. Enable for ONE agent in ONE Telegram group.
2. Send a message. Observe `human-engine:` in logs.
3. Verify the agent reply arrives in bubbles with human timing.
4. `openclaw plugins disable human-engine` + restart and confirm baseline
   behavior (agent replies directly, no turn-taking).

## Known Limitations

- No on-demand typing indicator (OpenClaw has no plugin API for this;
  `agents.defaults.typingMode` is the lever; bubbles arrive without typing
  animation).

## License

MIT — see [LICENSE](LICENSE).
