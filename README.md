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
hooks (message_received → before_agent_reply → before_agent_run →
before_prompt_build → reply_dispatch → reply_payload_sending)
  │
  ├── gate          ← decides speak/stay_silent at before_agent_reply;
  │                     stay_silent returns {handled:true} (turn silenced
  │                     before the LLM call)
  ├── voice-card    ← persona context injected before prompt
  ├── naturalize    ← captures the real reply at reply_payload_sending,
  │                     re-delivers as timed bubbles
  └── social-memory ← ingest on message, recall on speak
```

## Install

```bash
# Clone anywhere (e.g. ~/human-engine)
git clone https://github.com/KevinAmmerman/human-engine ~/human-engine
cd ~/human-engine && npm install

# Symlink for OpenClaw discovery
ln -s ~/human-engine ~/.openclaw/extensions/human-engine

# Enable
openclaw plugins enable human-engine

# (Optional) restrict to agents
openclaw config set plugins.entries["human-engine"].config.agents '["my-agent"]'

# (Optional) scoped groups — agent reads all messages there
openclaw config set channels.telegram.groups.'"<chatId>"'.requireMention false

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
| `contactsPath` | string | `""` | contacts.md-style table for sender-ID → name resolution |
| `soulAutoEnhance` | bool | `true` | Auto-enhance on startup |
| `antiTell` | bool | `true` | Suppress tell-like phrases |
| `styleStats` | bool | `true` | Log style stats |
| `socialLearning.enabled` | bool | `true` | Voice card learning (gates the whole prompt-build handler) |
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

### Sender name resolution (optional)

Group channels often deliver sender IDs (phone numbers, `@lid`) instead of
display names. Point `contactsPath` at a markdown table and IDs resolve to
names everywhere (transcript, decide context, social memory):

```
| @lid | phone | name | notes |
|------|-------|------|-------|
| 81000000000004 | +4915000000000 | Ada Example | |
```

The file is re-read when it changes; a missing file is ignored.

## State Files

All under `<plugin-dir>/state/`, created at runtime and never committed
(0600/0700 file/dir modes):

| Path | Purpose |
|------|---------|
| `state/social-learning-cache.json` | Voice card cache (disk-persisted) |
| `state/social-memory/<agentId>/<sessionKey>.json` | Person-centric memory profiles per agent × session |
| `state/observed/<sessionKey>.jsonl` | Silenced-message observation log (plugin-local) |
| `state/proactive.json` | Proactive budgets/cooldowns (persisted) |
| `<soul-dir>/.soul_auto_enhanced` | Marker that auto-enhance has run (next to SOUL.md) |
| `<soul-dir>/SOUL.md.bak` | SOUL.md backup from `/soul enhance` (next to SOUL.md) |

To reset: delete the relevant file and restart.

## Auto-enhance & operator content

`/soul enhance` (and startup auto-enhance) never overwrites your SOUL.md
wholesale: the enhanced persona is written inside a marked section,
`<!-- human-engine:persona:start --> … <!-- human-engine:persona:end -->`,
appended if missing and replaced in place on re-enhance. Any operator content
outside the section survives untouched. A `.bak` of the pre-enhance file is
kept next to SOUL.md.

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
