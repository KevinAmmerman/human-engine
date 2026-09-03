# Meaningful Absence — Thread-Kontinuität über Tage (SPIKE)

## Problem

Real group members are meaningfully absent: they vanish for days and return to
pick up a thread, or resume one they owe an answer to. Today the engine cannot
represent any of it: the decide context is at most the last 20 merged lines
(`gate.js:107`), the observed store rotates to 200 lines per session
(`observed-store.js:5`), in-memory state is capped Maps (`state.js:13`, 4096),
and a 30-min proactive tick (`index.js:125`) means the agent is never truly
"away". This spike designs the smallest state model giving multi-day thread
continuity AND meaningful absence, without becoming over-referential.

Design inputs that exist on main (read in Step 1):

- `wiki/design/conversational-time.md` (plan 512): message-age semantics,
  `[speaker](vor Xd) text`, `timestamp` from the observed-store path, `formatAge`
  thresholds (<30 min / <24 h / days), over-apology guard.
- `wiki/design/social-memory-v2.md` (plan 513): `open_threads` per-person
  `[{topic, lastExchange, whoOwesWhat}]`, cap 3, plus the `callbackWorthy`
  channel feeding the proactive funnel.

## 1. Thread state model

A per-scope persisted JSON file
`state/social-threads/<agentId>/<sessionKey>.json` (0600, matching the
observed-store write mode and the 0700 `social-memory` dir pattern), shape:

```json
{
  "openTopics": [
    { "topic": "<short label>", "summary": "<≤2 sentences>",
      "lastTs": 0, "awaiting": "agent" | "member" | "none" }
  ],
  "lastAgentSpeakTs": 0,
  "lastGroupActivityTs": 0,
  "agentAbsentSince": 0
}
```

- `openTopics` cap 3 (aligned with social-memory-v2 `open_threads`); each
  `awaiting` answers "who owes what".
- Updated on the SAME cadence as memory extraction — reuse the `socialMemory`
  flush pattern (`lib/social-memory.js:61-118`): dirty-scope flag + a 2 s
  unref'd flush timer (`FLUSH_MS = 2000`), plus an extract-triggered refresh
  at `extractEvery` (default 25 messages) / `extractMinutes`. NOT per message.
  If `socialMemory.schemaV2` is on, it reads the same `open_threads` source so
  the two never diverge.
- `agentAbsentSince` is set on write when previously 0 and the agent has not
  spoken; cleared when the agent next speaks.

## 2. Decide integration

One context line injected above the transcript when
`agentAbsentSince > 24 h` OR `openTopics` contains an `awaiting: "agent"`
topic:

```
You last spoke here <N> days ago. Open threads: <topic summaries>.
A returning member briefly acknowledges the gap or picks up a thread — pick ONE, naturally.
```

Guards:

- Only ONE acknowledgment candidate per return (never list multiple callbacks
  in one turn).
- Never for gaps < 24 h.
- Purely DATA + bounded instruction; "pick ONE, naturally" must not be read as
  a command to always reference a thread (parallel to plan 512's over-apology
  guard).

## 3. Meaningful absence mechanics

Define when the agent is ALLOWED to be silent for days:

- No unanswered direct address to the agent (no un-replied question / no
  `awaiting: "agent"` topic) and no pending `awaiting: "agent"` open thread.
- Group is quiet (no new group activity) OR last group activity is a
  self-contained exchange not requiring the agent.

Mechanics:

- Add a `return_greeting` proactive trigger (see §4) with its own budget; the
  decide learns "absence is fine here" because the funnel only fires on
  qualifying triggers, never a blanket "should I speak" timer.
- Anti-pattern to design against: the 30-min tick (`index.js:125`) + proactive
  budget making the agent always-present. The tick stays (housekeeping /
  memory flush) but must NOT itself generate speaking turns; absence is
  preserved by the trigger-only funnel.

## 4. Return quality

The first message after a gap references ONE concrete open thread (from
`openTopics`) or the gap itself — never a generic "hi again".

- Route through the existing proactive funnel (`lib/proactive.js`).
- New trigger `return_greeting`: fires only when `agentAbsentSince > 24 h` and
  the gap is meaningful (see §3), budget 1/day, shadow-first (staged through
  the existing shadow/DM-proactive path before going live).
- The minutes-scale delays in `proactive.js` (8-15 / 20-40 / 120 min) stay for
  existing triggers; `return_greeting` is the only days-scale trigger and uses
  `agentAbsentSince` as its "age". `COOLDOWN_CAP_MS` (48 h) must be re-examined
  so it does not suppress multi-day returns.

## 5. Restart persistence

`thread-state.json` survives gateway restarts (unlike in-memory Maps,
`state.js`). Rebuild path if the file is missing:

- Derive `openTopics` from the observed store (`state/observed/*.jsonl`,
  timestamps via the plan-512 ts source) + the memory profile's
  `open_threads` (social-memory-v2).
- `lastAgentSpeakTs` / `lastGroupActivityTs` from the most recent observed
  records' timestamps.
- `agentAbsentSince` from the gap between `lastAgentSpeakTs` and `now`; if no
  observed data exists, start at 0 and rebuild over the next extraction cycle.

## 6. Risks & guards

- **Over-referentiality**: cap 1 callback per return; never reference a
  thread on two consecutive returns; the context line is only added on
  qualifying conditions (§2).
- **Hallucinated summaries**: produced by the extraction LLM from observed
  transcript only — never invented (mirror social-memory-v2 "extract-only").
  A topic with no observed support is dropped, not invented.
- **PII**: all state in 0600 files under `state/social-threads/`; redaction
  rules from plan 503 apply to every new log output; no member names or
  message content in logs.
- **Staleness**: topics expire after 14 days (removed on the extraction
  cadence).
- **Divergence**: `openTopics` and social-memory-v2 `open_threads` stay in sync
  when `schemaV2` is on — single source, not two.

## 7. Open questions

Before implementation (needs live measurement):

1. Real gap-length distribution: how often are observed-store gaps > 24 h,
   48 h, multi-day? `state/observed/` has 1 session file today; sample
   timestamps before choosing thresholds.
2. Does the host surface reliable cross-restart session identity? If not, the
   §5 rebuild can't key reliably and needs a fallback.
3. Is 24 h the right absence threshold, or should it scale per group/session
   (some groups have daily traffic, some weekly)?
4. Does the existing proactive cooldown/budget interact correctly with a
   days-scale `return_greeting`, or does `COOLDOWN_CAP_MS` need a carve-out?
5. Token budget of the decide context line for many concurrent threads (cap 3
   assumed — verify against real thread volume).
6. Shadow-first staging: what does "shadow" mean for a return greeting — log
   only, or stage through the DM-proactive render path?
