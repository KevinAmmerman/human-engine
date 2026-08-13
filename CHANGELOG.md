# Changelog

## 0.4.0 — the observability & hygiene wave

A large wave that fixes how the plugin behaves on real hook semantics, hardens
it against prompt injection, and cleans up the config surface, state layout,
and docs so everything reflects what actually ships.

- **Observed store (plugin-local)**: silenced messages are now persisted to
  `state/observed/<sessionKey>.jsonl` by the plugin itself (the previous
  host-transcript append never worked in practice), layered into the decide
  transcript alongside the in-memory peek and hydrated session transcript.
- **Decide reactivation**: the turn-taking decide was rebuilt on real hook
  semantics — `before_agent_reply` fires *before* the model run with the
  cleaned inbound body, so silencing happens in the same hook as the decide
  (no cross-turn flags). Group sessions fail closed (silenced) on decide
  errors; DMs stay fail-open. New hard triggers short-circuit to speak with
  zero LLM calls: DMs, media, the agent's own name, and a mention of the
  agent's contact ID from `contactsPath`.
- **Naturalize repair**: bubbles are built from the agent's actual reply
  captured at `reply_payload_sending`, not from inbound text. Reply payloads
  are debounced into one draft, humanized, and re-delivered as timed bubbles;
  the original payload is cancelled. Speak-epoch expiry (`naturalize.speakEpochTtlMs`)
  prevents a dead turn from capturing a later turn's reply.
- **Security hardening**: prompt-injection barriers on inbound content, sender
  labels, PII handling modes, stricter voice-card scoping, and uniform
  enabled/scoping checks on every handler. Group gate errors never leak a
  reply; residual block text is cancelled at `message_sending`.
- **Proactive turn-taking (shadow-first)**: an opt-in three-stage funnel lets
  the agent initiate (triggers → anti-annoyance gate → `subagent.run`
  delivery). Off by default; in `shadow:true` it only logs would-be sends.
  Budgets/cooldowns persist to `state/proactive.json`.
- **Soul merge**: `/soul enhance` and startup auto-enhance no longer overwrite
  SOUL.md wholesale — the enhanced persona lives in a marked
  `<!-- human-engine:persona:start/end -->` section that is appended if missing
  and replaced in place on re-enhance, preserving operator content.
- **Config truth sync**: removed the dead `decide.model`/`humanize.model`
  overrides (the host's `llm.complete` surface doesn't accept them) and the
  unused social-learning/timing keys are now actually wired
  (`refreshEvery`, `window`, `enabled`, `maxTypingMs`, `maxBubbleGapMs`).
  Nested config objects deep-merge one level, so a partial override never
  drops sibling defaults. `socialLearning.perSessionCard` default is now
  `true` (the effective behavior). Version bumped to `0.4.0`.
- **Hygiene**: social-memory writes are coalesced (≤1 disk write per 2 s
  window per session), the ingest/extract metadata race is closed, and the
  profile cache is capped at 256 scopes. Dead state maps and the unused
  constructor `state` parameter were removed. Real-looking contact data in the
  README and tests was replaced with obviously-fake values.

## 0.3.2 — session-transcript hydration for decide

- **Decide context survives restarts**: when the in-memory transcript peek is
  thin (<6 entries, e.g. right after a gateway restart), the gate hydrates
  the decide transcript from the persisted session transcript via the
  official `session-transcript-runtime` SDK (`readSessionTranscriptEvents`,
  user + assistant roles, last 20 messages). Fixes stay_silent on the first
  turns after every restart — the decide previously saw only the single
  inbound message.
- Current message is appended to the hydrated transcript if not yet persisted.

## 0.3.1 — two-sided decide context (reply-to-agent fix)

- **Agent's own replies now land in the transcript peek**: `reply_payload_sending`
  pushes captured reply text as `[agentName] …` so the decide LLM sees both
  sides of the conversation. Fixes stay_silent on direct follow-ups/replies
  to the agent's own messages (previously the decide only saw the user side
  and judged follow-ups as noise).
- **Decide prompt**: explicit rule that a follow-up to the agent's own recent
  message leans SPEAK.
- New decide scenarios for reply-to-agent follow-ups (24 total).

## 0.3.0 — architecture rebuilt on real hook semantics (leak fix)

Live debugging against OpenClaw 2026.6.11 proved the plugin's core assumption
wrong: `before_agent_reply` fires **before the model run with the cleaned
inbound body** (`{handled:true}` short-circuits the turn with `NO_REPLY`),
not with the agent's reply text. The old design's silence flag therefore
always landed one turn late (silencing the *next* message while the current
reply leaked), and the naturalize "draft" was the user's own message.

- **Gate: decide + silence moved to `before_agent_reply`.** stay_silent now
  returns `{handled:true}` in the same hook that ran the decide — the turn is
  silenced before the LLM call, inside its own turn. No cross-turn flags at
  all: the entire `silentEpoch`/TTL machinery is deleted (the whole bug class
  with it). Group fail-closed works the same way.
- **Naturalize: real reply capture via `reply_payload_sending`.** On speak
  turns, `reply_dispatch` stashes the dispatcher; the final reply payload is
  captured (`{cancel:true}` suppresses the original), debounced, humanized,
  and re-delivered as timed bubbles via `dispatcher.sendBlockReply`. Raw-draft
  fallback if the humanize LLM fails or the turn is superseded.
- speak epochs carry timestamps (120s TTL) so a dead turn can never capture a
  later turn's reply.
- `before_agent_run` no longer decides; it only feeds transcript/social
  memory for turns that actually run. Heartbeat triggers are skipped by the
  gate.
- Sender name cached from `message_received` so `before_agent_reply` (which
  only carries senderId) resolves contacts correctly.

## 0.2.2 — sender attribution + social memory hygiene

- **Contacts resolution**: new `contactsPath` config pointing at a
  contacts.md-style table (`| @lid | phone | name | notes |`). Sender IDs
  (phone numbers, @lid) resolve to display names in transcript peek, observed
  context, decide prompts, and social memory profiles. mtime-cached, tolerant
  of missing files.
- **Social memory ingest restricted to real chat sessions**: cron,
  commitments, and heartbeat session keys no longer create junk person
  profiles (previously one throwaway file per cron run, speaker "User").
- Social memory recall and own-reply ingest follow the same chat-session
  filter.

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
