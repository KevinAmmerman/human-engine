# Plan 621: Context hygiene — escape untrusted delimiters and label quoted voice transcripts

> **Executor instructions**: Follow step by step; run every verification. STOP
> and report on any STOP condition. Update the status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 08d9c9a..HEAD -- lib/local-prompts.js lib/gate.js test/local-prompts.test.js test/gate.test.js`
> On drift, compare excerpts; mismatch = STOP.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security / correctness
- **Planned at**: commit `08d9c9a`, 2026-09-11

## Why this matters

Two context defects make the DM feel unnatural and add injection surface:

1. `wrapUntrusted` uses fixed, unescaped delimiter constants
   (`lib/local-prompts.js:4-9`). Member/agent text that itself contains
   `<<<END GROUP CHAT LOG>>>` can terminate the untrusted block early, putting
   the remainder in instruction position.
2. Inbound voice messages whose user quote-replied to an earlier voice note
   arrive as `[Audio]\nUser text:\n<U>\nTranscript:\n<T>`, where `<T>` is the
   transcription of the **quoted** message — often the agent's own prior voice
   note. The plugin feeds the whole string to the model as the current user
   turn, so the agent's own follow-up text re-enters as if the user had said
   it (live: lcm conv 3297 shows the model's thinking wrestling with "Die
   Transkript-Ansage ist merkwürdig"). This feedback can reinforce a topic as
   still-open.

After this plan, delimiter content cannot break out of the untrusted block,
and a quoted voice transcript is clearly labelled as quoted context (and
wrapped) instead of masquerading as the user's own words. (The host-side media
pipeline that attaches the quoted transcript is addressed separately in the
Track-2 workspace plan `~/plans/637-…`.)

## Current state

- `lib/local-prompts.js:1-9`:

```js
export const UNTRUSTED_DIRECTIVE = "Context lines are quoted chat messages ...";
export const LOG_START = "<<<GROUP CHAT LOG (untrusted)>>>";
export const LOG_END = "<<<END GROUP CHAT LOG>>>";
export function wrapUntrusted(content) {
  return LOG_START + "\n" + String(content ?? "") + "\n" + LOG_END;
}
```

- The `[Audio] User text/Transcript` format is produced by the host
  (`dist/apply-*.mjs` `formatMediaUnderstandingBody`: emits
  `User text:\n<body>` when >1 media output, then `Transcript:\n<stt>`), and
  stored verbatim as a `role:"user"` message (verified in `lcm.db`).
  `lib/gate.js` reads it back via `readSessionTranscript` and merges it into
  the decide transcript (`mergeTranscriptLayers`, `:80-117`).
- `buildDecidePrompt` wraps context with `wrapUntrusted` (`:512`); the split
  prompt (`buildSplitPrompt`) does NOT (`lib/local-prompts.js:410-411`).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| All tests | `cd ~/human-engine && npm test` | all pass |
| Parity | `node test/parity-matrix.mjs --check` | exit 0 |
| Focused | `node --test test/local-prompts.test.js test/gate.test.js` | pass |

## Scope

**In scope**:
- `lib/local-prompts.js` (escaping)
- `lib/messages.js` or `lib/gate.js` (quoted-audio normalization — put the
  helper in `lib/messages.js` if it fits the existing message-utils role)
- `test/local-prompts.test.js`, `test/messages.test.js`/`test/gate.test.js`
- `test/parity-matrix.mjs`, `plans/README.md`

**Out of scope**:
- OpenClaw dist / the host media pipeline.
- Changing what the host stores in `lcm.db`.

## Git workflow

- Branch: `advisor/621-context-hygiene`.
- Commit: `fix(prompts): escape untrusted delimiters + label quoted voice (plan 621)`.
- Do NOT push.

## Steps

### Step 1: Escape delimiter tokens inside `wrapUntrusted`

Add:

```js
function escapeUntrustedDelimiters(s) {
  return String(s ?? "").split(LOG_START).join("[escaped-log-start]")
                        .split(LOG_END).join("[escaped-log-end]");
}
export function wrapUntrusted(content) {
  return LOG_START + "\n" + escapeUntrustedDelimiters(content) + "\n" + LOG_END;
}
```

**Verify**: `node --test test/local-prompts.test.js` → pass; new test: a
string containing `LOG_END` is escaped and the produced block contains exactly
one `LOG_END` (at the very end).

### Step 2: Normalize quoted-audio bodies

Add a pure helper (in `lib/messages.js`):

```js
// Returns { userText, quotedTranscript } for the host's
// "[Audio]\nUser text:\n<U>\nTranscript:\n<T>" body; otherwise
// { userText: text, quotedTranscript: "" }.
export function splitQuotedAudioBody(text) { /* parse the two labelled sections */ }
```

Rule: `userText` is the content after `User text:`; `quotedTranscript` is the
content after the last `Transcript:`. If the pattern is absent, return the
whole text as `userText`. Cap both at 2000 chars.

### Step 3: Use the normalized form in the decide path

In `lib/gate.js`, where the inbound `prompt` is prepared for the decide (the
`before_agent_reply` body — the same value passed to `markStaySilent`/
`markSpeak`), replace the raw body with a normalized form when
`splitQuotedAudioBody` finds a quoted transcript:

```
<userText>
[quoted earlier message (context, not the current ask):] <quotedTranscript>
```

and ensure the quoted part is inside the untrusted wrapper when the decide
prompt is built (route the whole normalized transcript through the existing
`wrapUntrusted` path). Do NOT change what is persisted to the observed store
(keep the original body there) — only the model-facing decide string.

**Verify**: `node --test test/gate.test.js` → pass; new test: a body with
`User text: A\nTranscript: B` produces a decide prompt containing `A` as the
user line and `B` under the quoted-context marker, both inside the untrusted
block.

### Step 4: Wrap the split prompt too

Route `buildSplitPrompt`'s transcript lines through `wrapUntrusted` the same
way `buildDecidePrompt` does (`lib/local-prompts.js:312` vs `:410-411`).

**Verify**: `node --test test/local-prompts.test.js` → pass; the split prompt
contains `LOG_START`/`LOG_END` around the transcript.

### Step 5: Parity + README

Rows: delimiter escaping, quoted-audio labeling, split-prompt wrapping.

**Verify**: `node test/parity-matrix.mjs --check` → exit 0.

## Test plan

- `test/local-prompts.test.js`: escape test; split prompt wrapping.
- `test/messages.test.js`: `splitQuotedAudioBody` happy path, no-pattern
  fallback, cap.
- `test/gate.test.js`: decide prompt labeling.
- Verify: `cd ~/human-engine && npm test` → all pass.

## Done criteria

- [ ] `npm test` exits 0; parity exit 0
- [ ] a content string containing `LOG_END` cannot break the block (new test)
- [ ] a `[Audio] … Transcript:` body is labelled as quoted context (new test)
- [ ] No files outside scope modified (`git status`)

## STOP conditions

Stop and report if:
- The `[Audio]...Transcript:` body is not present in the decide path in the
  way described (the host format may have changed — report the real shape).
- Normalizing the body changes what is persisted to the observed store
  (it must not).
- Real PII would enter tests/fixtures/docs.

## Maintenance notes

- The host still attaches the quoted (possibly self-authored) transcript; this
  plan only makes the plugin's context handling safe. The durable fix is the
  Track-2 host/config plan — keep both consistent.
- If `wrapUntrusted` is used for new prompt surfaces, the escaping is
  automatic (it lives inside the function).
