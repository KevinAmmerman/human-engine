# Plan 616: Reply-target anchors to the member's message, not the agent's own

> **Executor instructions**: Follow step by step; run every verification. Commit
> in the worktree. Skip the `plans/README.md` update (reviewer maintains it).

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (current branch `advisor/613-initiative-engine`)
- **Category**: bug
- **Planned at**: commit `3efa38a`, 2026-09-10

## Why this matters

In the `hori-wa-public-group` WhatsApp group, when a member replies to Yuki
(quotes her message), Yuki's answer quotes **her own** message instead of the
member's. Live evidence from the group log + `contacts.md` (`<agent-lid>@lid`
= "Yuki (Bot)"): `reply-context captured … sender=<agent-lid>@lid` →
`reply-resolve … quotedName=Yuki (Bot) replyToAgent=true`, and the member then
sees Yuki's reply anchored to her own message.

Root cause: `lib/gate.js:230` sets the outbound anchor to the **quoted** message
id first:
```js
const msgId = quotedId || ctx?.messageId || event?.messageId || "";
```
For a quote-reply, `quotedId` is the agent's own message, so the outbound
`replyToId` (mapped by the host to WhatsApp `quotedMessageKey`) points at the
agent's message. It should point at the **inbound** message (the member's
message). `quotedId` must stay available for the reply-detection
(`quotedName`/`replyToAgent`), but must not win the outbound anchor.

## Current state (anchors)

- `lib/gate.js:220-236` — `onMessageReceived` captures the reply context;
  `quotedId = ctx?.replyToId || event?.replyToId || ""`; `msgId = quotedId || ctx?.messageId || event?.messageId || ""`.
- `lib/gate.js:347-363` — `persistReplyTarget` writes
  `replyToId: replyCtx.msgId` into `replyTargetBySession`.
- `lib/naturalize.js` flush reads `replyTargetBySession` and passes
  `replyTarget.replyToId` as the first bubble's `replyToId` (plan 035).
- `test/gate.test.js` covers gate behavior; add the regression there (or in
  `test/hook-contract.test.js` if it fits the hook-ctx shape better).

## Scope

- `lib/gate.js` — swap the anchor priority (one line + comment)
- `test/gate.test.js` — regression test

**Out of scope:** the reply-context queue fallback, naturalize, prompts, config,
live config.

## Steps

### Step 1: swap the anchor priority (`lib/gate.js`)

Change `lib/gate.js:230` to:
```js
// Outbound anchor (plan 616): the reply must quote the INBOUND member message
// (ctx.messageId), not the message the member quoted — quoting the quoted
// message makes the agent appear to reply to its own message. `quotedId` is
// still used below for reply detection (`quotedName`/`replyToAgent`).
const msgId = ctx?.messageId || event?.messageId || quotedId || "";
```
Keep `quotedId` defined and used for detection. Update the stale comment above.

### Step 2: regression test (`test/gate.test.js`)

Add a test in the gate `message_received` + `before_agent_reply` flow: an inbound
from a member whose `ctx.replyToId` = `"agent-own-msg-id"` and
`ctx.messageId` = `"member-msg-id"`, with `replyToSender` resolving to the
agent's own contact (so `replyToAgent` is true, i.e. the member quoted Yuki).
Assert that after the speak turn, `state.replyTargetBySession.get(sk).replyToId`
=== `"member-msg-id"` (NOT `"agent-own-msg-id"`). Use the existing gate-test
setup/fakes in that file; no network.

**Verify**: `node --test test/gate.test.js` → all pass, including the new test.

### Step 3: full gate + commit

- `npm test` → 0 fail; `node test/parity-matrix.mjs --check` → 88/88, exit 0.
- Commit: `fix(gate): anchor agent replies to the member's message, not its own (plan 616)`.

## Done criteria

- [ ] `npm test` exits 0; parity 88/88
- [ ] the new gate test fails on the old line order and passes after the swap
- [ ] `git status` shows only `lib/gate.js` + `test/gate.test.js` (+ node_modules symlink)

## STOP conditions

- `ctx.messageId`/`event.messageId` are absent in the WhatsApp `message_received`
  context (then the fix cannot anchor to the inbound message — report, do not
  invent an id).
- A test outside the in-scope list must change.
