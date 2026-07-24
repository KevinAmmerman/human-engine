# Changelog

## 0.2.1 — live-debug fixes (turn-taking reliability)

- **silentEpoch TTL**: stay_silent flags now carry a timestamp and expire after
  `gate.silentTtlMs` (default 90s). Stale flags from turns that died before
  `before_agent_reply` no longer swallow the next legitimate speak reply.
- **Decide sees conversation context**: the gate fed only the single inbound
  message to the decide LLM when the host provided no transcript; it now falls
  back to the plugin's per-session transcript peek buffer (last 20 lines).
  Fixes wrong stay_silent decisions on follow-up messages in active exchanges.
- **Naturalize transcript bugfix**: `state.transcriptBySession` did not exist —
  respond now receives the transcript peek buffer as intended.
- **Voice card honors kill-switch and agent scoping**: `onBeforePromptBuild`
  now checks `enabled` and `agents` like every other handler.
- **Transcript dedup**: messages pushed by both `message_received` and
  `before_agent_run` no longer appear twice in the peek buffer.

## 0.2.0 — renamed to human-engine, fully local engine

- Renamed from `humalike` to `human-engine`.
- Humalike transport removed; all logic runs via the host's built-in LLM.
- New config path: `plugins.entries["human-engine"].config.*`.
- Fully self-hosted, no external API dependencies.

## 0.1.0 — initial Humalike-API port

- Initial port of the Hermes humalike plugin behavioral concepts.
- Turn-taking gate, bubble naturalization, voice card, social memory.
