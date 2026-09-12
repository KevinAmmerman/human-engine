# Plan 618: Fix the layer-1 gate's state path and expose a read-only open-loop ledger CLI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP condition" occurs, stop and report. Update this plan's status row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 08d9c9a..HEAD -- bin/followup-gate.mjs lib/initiative-store.js bin/initiative-ledger.mjs test/dm-proactive.test.js`
> On drift, compare the excerpts below against the live code; mismatch = STOP.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: plans/617-initiative-durable-open-loop-state.md
- **Category**: correctness / dx
- **Planned at**: commit `08d9c9a`, 2026-09-11

## Why this matters

The followup-cron is required to pre-check every candidate with
`bin/followup-gate.mjs` (layer-1 defense in depth). Today that pre-check is
**blind to real duplicate state**: it reads the pre-v3 flat `state.sentIds`
shape, but the plugin writes v4 `{version:4, agents:{<agentId>:{sentIds:[]}}}`
(`lib/dm-proactive.js:277-289`). Against live state the CLI therefore computes
`duplicate=false` for every id, so the cron forwards duplicates the CLI was
supposed to stop.

Separately, the new durable ledger (plan 617, `state/initiative/<agentId>/
<scope>.json`) is invisible to the cron. The cron needs a **read-only** way to
ask: "is this topic already open / recently attempted / paused?" so it can
skip before it even builds an envelope.

This plan (a) fixes the v4 sentIds lookup and (b) adds a read-only
`bin/initiative-ledger.mjs` CLI that the cron and an operator can query. It
does NOT change the plugin hook (plan 619).

## Current state

- `bin/followup-gate.mjs` — layer-1 CLI. The budget read already uses the v4
  path (`:135-141`), but the sentIds read does not:

```js
// bin/followup-gate.mjs:142-153  (BROKEN — flat v2/v3 shapes)
const agentSent = bucketList(state?.sentIds, agentId || LEGACY_BUCKET);
const legacySent = bucketList(state?.sentIds, LEGACY_BUCKET);
const duplicate = agentSent.includes(parsed.envelope.id) || legacySent.includes(parsed.envelope.id);
```

- Live state shape (`~/human-engine/state/dm-proactive-state.json`, first
  line): `{"version":4,"agents":{"hori-wa":{"sentIds":[...],"byKind":{...},
  "budget":{...}},"__legacy__":{...}}}` — no top-level `sentIds`.
- `lib/initiative-store.js` — the ledger store (plan 617 added
  `findByTopicKey`/`listOpenTasksForAgent`). State path:
  `state/initiative/<pathSafe(agentId)>/<pathSafe(sessionKey)>.json`
  (`:13-16`); each task carries `topicKey`, `status`, `attempts`,
  `lastActAt`, and `stateObj.cooldowns[taskId].until`.
- CLI conventions (`bin/followup-gate.mjs`): plain ESM, `--flag value` parser
  (`:76-84`), single-line JSON on stdout via `emit()` (`:64-67`), exit codes
  0 pass / 1 block / 2 invalid / 3 usage (`:15`). Reuse these.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| All tests | `cd ~/human-engine && npm test` | all pass |
| Parity | `node test/parity-matrix.mjs --check` | exit 0 |
| CLI smoke | `node bin/followup-gate.mjs check --session 'agent:x:telegram:direct:1' --agent x --state ~/human-engine/state/dm-proactive-state.json < /dev/null` | usage/exit 2 or 1, never exit 0 with `duplicate:true` |

## Scope

**In scope**:
- `bin/followup-gate.mjs` (fix sentIds path; read ledger for topic gates)
- `bin/initiative-ledger.mjs` (create — read-only)
- `test/dm-proactive.test.js` (extend the CLI cases)
- `test/parity-matrix.mjs` (rows)
- `plans/README.md` (status)

**Out of scope**:
- `lib/dm-proactive.js`, `lib/dm-gate-core.js` (plan 619).
- Any write to state (this CLI is strictly read-only).

## Git workflow

- Branch: `advisor/618-ledger-cli`.
- Commit style: `fix(followup-gate): v4 sentIds path + read-only ledger CLI (plan 618)`.
- Do NOT push.

## Steps

### Step 1: Fix the v4 sentIds read

Replace the broken block (`bin/followup-gate.mjs:142-153`) with a v4-first
lookup, keeping the legacy flat fallback:

```js
function bucketListV4(state, agentId, name) {
  const v4 = state?.agents?.[agentId]?.sentIds;
  if (Array.isArray(v4)) return v4.slice(0, SENT_IDS_MAX);
  return bucketList(state?.sentIds, agentId); // legacy flat fallback
}
const agentSent = bucketListV4(state, agentId || LEGACY_BUCKET);
const legacySent = bucketList(state?.sentIds, LEGACY_BUCKET);
const duplicate = agentSent.includes(parsed.envelope.id) || legacySent.includes(parsed.envelope.id);
```

**Verify**: `node --test test/dm-proactive.test.js` → pass; add a test that
feeds a v4-shaped state and asserts `duplicate:true` for a present id.

### Step 2: Create `bin/initiative-ledger.mjs` (read-only)

New CLI, same conventions as `followup-gate.mjs`:

```
usage: node bin/initiative-ledger.mjs list [--agent <agentId>] [--session <sessionKey>] [--state-dir <dir>] [--now <epoch-ms>] [--json]
       node bin/initiative-ledger.mjs get  --topic-key <tk-...> [--agent <agentId>] [--session <sessionKey>] [--state-dir <dir>] [--json]
```

- `--state-dir` defaults to `process.env.HUMAN_ENGINE_STATE_DIR ||
  <pluginRoot>/state` (mirror `followup-gate.mjs:107`).
- `list` prints one JSON line per open task:
  `{scope, agentId, topicKey, text, status, attempts, lastActAt,
  cooldownUntil, dueAt, createdAt}`; absent `--session` lists all scopes for
  `--agent` via `listOpenTasksForAgent`.
- `get` returns the matching task for `--topic-key` (scope from
  `--session`/`--agent`) or `{found:false}`.
- Exit 0 on success (even when empty), 3 on usage error, 2 on bad input.
- **Read-only**: it imports `lib/initiative-store.js` accessors and never
  calls `save`. It must not create any file.

**Verify**: on a machine with no `state/initiative/`, `node bin/initiative-ledger.mjs list --agent hori-wa` → `[]` (or a single `{"tasks":[]}` line) and exit 0; confirm no new files: `git status --porcelain state/ | wc -l` unchanged.

### Step 3: Add the topic-cooldown / attempt-cap pre-check

In `followup-gate.mjs`, after the `duplicate` computation, if the envelope
carries a `topicKey` (the producer will send it — plan 635), read the ledger
via the store accessor and add verdicts:

- `topic-cooldown`: block when a task with this `topicKey` has
  `cooldowns[task.id].until > now`.
- `topic-attempts`: block when `task.attempts >= (cfg.dmProactive.topicMaxAttempts ?? 3)`.
- `topic-open`: block when a task with this `topicKey` has
  `status === "open"` and an act within `cfg.dmProactive.openAttemptCooldownMinutes`
  (i.e. an unanswered attempt is pending).

Add these keys to the CLI's `verdicts` and to `reasons`; the CLI import of
`evaluateDmGate` stays authoritative for the existing rules. If no
`topicKey` is present, skip these checks (fail-open, backward compatible).

**Verify**: `node --test test/dm-proactive.test.js` → pass; new CLI test:
ledger file with `cooldowns` in the future → exit 1, `reasons` contains
`topic-cooldown`.

### Step 4: Parity rows + README

Add rows for: v4 sentIds lookup, ledger `list`, ledger `get`,
topic-cooldown CLI verdict, topic-attempts CLI verdict.

**Verify**: `node test/parity-matrix.mjs --check` → exit 0.

## Test plan

- `test/dm-proactive.test.js`: v4-state duplicate detection; ledger
  topic-cooldown block; topic-attempts block; no-`topicKey` fail-open;
  `initiative-ledger.mjs list/get` output shape and read-only (no file
  created). Model after the existing CLI test around
  `test/dm-proactive.test.js:1277` (legacy-state case) — that test must keep
  passing and a v4 sibling added.
- Verify: `cd ~/human-engine && npm test` → all pass.

## Done criteria

- [ ] `cd ~/human-engine && npm test` exits 0
- [ ] `node test/parity-matrix.mjs --check` exits 0
- [ ] `node bin/initiative-ledger.mjs list --agent nobody` exits 0 and creates no file
- [ ] `grep -n "agents?\.\[.*\]\.sentIds" bin/followup-gate.mjs` matches
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

Stop and report if:
- The v4 state test fixture cannot be constructed without copying real state
  (use obviously-fake ids).
- The topic checks cannot be added without changing `evaluateDmGate` (which
  is plan 619's scope).
- Any real name/phone/JID would enter a fixture/doc.

## Maintenance notes

- `bin/initiative-ledger.mjs` and `bin/followup-gate.mjs` share the store
  accessors; keep them read-only forever — the plugin hook is the only
  writer of `sentIds` and the ledger.
- The `topicKey` field only reaches the CLI once the producer (plan 635)
  emits it; until then the new checks are inert (fail-open by design).
