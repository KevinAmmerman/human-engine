# Plan 617: Make the Initiative store a durable open-loop ledger (cooldowns, expiry, shadow budget, stable topic key)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 08d9c9a..HEAD -- lib/initiative.js lib/initiative-store.js lib/config.js openclaw.plugin.json test/initiative.test.js test/initiative-store.test.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (this is the foundation for plans 618/619)
- **Category**: correctness / direction
- **Planned at**: commit `08d9c9a`, 2026-09-11

## Why this matters

`initiative` is the plugin's per-agent×scope task engine (Plan 613). It is
meant to be the durable "open loop" memory ("she remembers"), but three of
its knobs are dead and one identity is unstable, so it cannot serve as a
reliable ledger:

- `cooldowns` is **read** but never written → the per-task cooldown gate can
  never fire. A task can be re-acted on every tick after `minGapMinutes`.
- `taskExpiryDays` has **no consumer** → stale open tasks never expire and
  keep surfacing.
- In `shadow:true` the act counters are not incremented → the gate always
  sees `actsToday:0`/`lastActAt:0`, so the daily cap and min-gap cannot be
  validated during shadow, and the shadow log over-reports candidates.
- The task id is `sha1(text + createdAt)` → the same topic re-extracted
  later gets a **new** id, so nothing can dedupe by topic.

After this plan, `initiative` keeps a stable, dedupable per-topic record with
a working cooldown/expiry/budget lifecycle. Plans 618/619 then let the DM
follow-up path read and write this ledger.

## Current state

- `lib/initiative-store.js` — durable per-agent×scope store. State shape:
  `defaultState()` at lines 18–34 (`tasks`, `directives`, `actsToday`,
  `acts`, `replies`, `cooldowns: {}`). `save`/`getOrInit`/`load` at 131–143.
  `listScopesForAgent` at 242–261. `scopeToPath` at 13–16.
- `lib/initiative.js` — engine.
  - `KEYWORD_RE` at line 28.
  - `evaluateInitiative(candidate, ctx)` at 56–85 (pure gate; `cooldown`
    reason at line 70, `budget` at 65, `min-gap` at 66).
  - `taskId()` at 127–129: `"t-" + sha1(normalizedText + "|" + createdAt)`.
  - `scrollCandidates(stateObj, now)` at 446–459 (no age cutoff).
  - `tickScope` at 528–683; cooldown is read at line 556
    (`stateObj.cooldowns?.[candidate.id]?.until`); sentIds set at 586–587;
    shadow branch at 608–626 (returns **without** incrementing counters);
    live state updates at 643–661 (`actsToday++`, `lastActAt = now`,
    `acts.push`, `attempts++`, `lastActKind`) — but **no cooldown write**.
- `lib/config.js` — `initiative` defaults at 112–139; `cooldownBaseMinutes:
  240`, `taskExpiryDays: 30` already exist.
- Repo conventions: state via tmp+rename 0600 / dir 0700; versioned state;
  every new field must survive `evictToCap` (`lib/initiative-store.js:61-75`).
  Test style: `node:test` with inline fakes — model after
  `test/initiative.test.js` and `test/initiative-store.test.js`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| All tests | `cd ~/human-engine && npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | full coverage, exit 0 |
| Focused | `node --test test/initiative.test.js test/initiative-store.test.js` | all pass |
| Lint/typecheck | — | repo has none (plain ESM, Node 24+) |

## Scope

**In scope** (the only files you should modify):
- `lib/initiative.js`
- `lib/initiative-store.js`
- `test/initiative.test.js` (extend)
- `test/initiative-store.test.js` (extend)
- `test/parity-matrix.mjs` (add rows only)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):
- `lib/dm-proactive.js`, `lib/dm-gate-core.js`, `bin/followup-gate.mjs`
  (plans 618/619).
- `lib/config.js`/`openclaw.plugin.json` — the needed keys already exist.
- Live config flips — `initiative.enabled` stays `false`.

## Git workflow

- Branch: `advisor/617-initiative-open-loop-ledger`.
- Conventional commits, e.g.
  `fix(initiative): durable cooldown/expiry/shadow-budget + stable topic key (plan 617)`.
- Do NOT push or open a PR. Do NOT flip the feature live.

## Steps

### Step 1: Stable, date-independent `topicKey`

Add a helper next to `taskId()` (`lib/initiative.js:127-129`):

```js
function topicKeyOf(normalizedText) {
  return "tk-" + createHash("sha1").update(normalizedText).digest("hex").slice(0, 16);
}
```

In the extract-merge path (where tasks are inserted), set
`task.topicKey = topicKeyOf(normalize(task.text))` and dedupe/merge on
`topicKey` when it already exists (keep the existing task, refresh
`lastUpdateTs`). Keep `taskId` unchanged for backward compatibility with
existing state files.

**Verify**: `node -e "import('./lib/initiative.js').then(m=>console.log('ok'))"` → `ok` (no syntax error), then `node --test test/initiative.test.js` → pass.

### Step 2: Write the per-task cooldown on a live ACT

In `tickScope`'s LIVE branch, after `stateObj.acts.push(...)` (around
`lib/initiative.js:655`), add:

```js
const cooldownMs = (ini.cooldownBaseMinutes ?? 240) * 60000;
if (!stateObj.cooldowns || typeof stateObj.cooldowns !== "object") stateObj.cooldowns = {};
stateObj.cooldowns[candidate.id] = { until: now + cooldownMs };
```

Do this **before** `store.save(scope, stateObj)` (line 677). The existing
gate read at line 556 then becomes live. (Shadow does not write a cooldown —
shadow has no real send.)

**Verify**: `node --test test/initiative.test.js` → pass; add a focused test
(below) and see it pass.

### Step 3: Enforce `taskExpiryDays`

In `scrollCandidates` (`lib/initiative.js:446-459`), before returning, mark
open tasks older than `taskExpiryDays` as `expired` and exclude them:

```js
const expiryMs = (ini.taskExpiryDays ?? 30) * 86400000;
for (const t of stateObj.tasks || []) {
  if (t.status === "open" && t.createdAt && now - t.createdAt > expiryMs) {
    t.status = "expired";
    t.expiredAt = now;
  }
}
```

Keep the function returning the filtered open candidates as before. The state
is saved by the caller via the normal dirty/flush mechanics; if not, call
`store.save(scope, stateObj)` once when any task changed.

**Verify**: `node --test test/initiative.test.js` → pass; a task created
`taskExpiryDays+1` ago is not returned by `scrollCandidates`.

### Step 4: Count budget in shadow

In the shadow branch (`lib/initiative.js:608-626`), mirror the live
accounting so the gate sees reality and the log is faithful:

```js
stateObj.actsToday = (stateObj.actsToday || 0) + 1;
stateObj.lastActAt = now;
if (!Array.isArray(stateObj.acts)) stateObj.acts = [];
stateObj.acts.push({ ts: now, taskId: candidate.id, id: candidateId, kind: candidate.kind || "task", shadow: true });
if (stateObj.acts.length > ACTS_CAP) stateObj.acts = stateObj.acts.slice(-ACTS_CAP);
candidate.attempts = (candidate.attempts || 0) + 1;
candidate.lastActAt = now;
store.save(scope, stateObj);
```

Add the existing log entry and return as before. Note: this changes shadow
KPIs intentionally — document it in the plan report.

**Verify**: `node --test test/initiative.test.js` → pass; a second simulated
tick in the same day hits `budget` (when `actsToday >= maxActsPerDay`) or
`min-gap`.

### Step 5: Store accessors for a topic ledger

In `lib/initiative-store.js`, add:

```js
function findByTopicKey(scope, topicKey) {
  const st = load(scope);
  if (!st || !Array.isArray(st.tasks)) return null;
  return st.tasks.find((t) => t.topicKey === topicKey) || null;
}
function listOpenTasksForAgent(agentId) {
  return listScopesForAgent(agentId).flatMap((st) =>
    (st.tasks || []).filter((t) => t.status === "open").map((t) => ({ scope: st.scope, ...t })));
}
```

Export both in the returned object (lines 263–276).

**Verify**: `node --test test/initiative-store.test.js` → pass.

### Step 6: Parity rows + README

Add parity-matrix rows for: cooldown-write, task-expiry, shadow-budget,
topic-key dedupe, store accessors. Tag each with the new test name.

**Verify**: `node test/parity-matrix.mjs --check` → exit 0, full coverage.

## Test plan

- `test/initiative.test.js`: (a) a live ACT writes `cooldowns[task.id]` and
  the next tick within `cooldownBaseMinutes` is blocked with reason
  `cooldown`; (b) a task older than `taskExpiryDays` is marked `expired` and
  not returned; (c) two shadow ticks on the same day increment `actsToday`
  and the second is blocked by `budget`/`min-gap`; (d) re-extraction of the
  same task text produces the same `topicKey` and does not duplicate.
- `test/initiative-store.test.js`: `findByTopicKey` round-trip,
  `listOpenTasksForAgent` filters non-open, and `topicKey` survives
  save/load and `evictToCap`.
- Pattern: model after the existing gate/tick tests in
  `test/initiative.test.js`.
- Verify: `cd ~/human-engine && npm test` → all pass, 0 fail.

## Done criteria

- [ ] `cd ~/human-engine && npm test` exits 0
- [ ] `node test/parity-matrix.mjs --check` exits 0, new rows covered
- [ ] `grep -n "cooldowns\[candidate.id\]" lib/initiative.js` returns a write
- [ ] `grep -n "taskExpiryDays" lib/initiative.js` returns a consumer
- [ ] `grep -n "topicKey" lib/initiative.js lib/initiative-store.js` returns matches
- [ ] `initiative.enabled` is still `false` in `lib/config.js`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report (do not improvise) if:
- The `initiative` code at the cited lines does not match the excerpts
  (drift).
- Counting shadow acts breaks an existing shadow test in a way that is not
  just an intentional expectation update.
- Writing the cooldown requires touching `dm-proactive.js`/`dm-gate-core.js`.
- Any real name/phone/JID would need to enter code, tests, fixtures, or docs
  (repo is PUBLIC).

## Maintenance notes

- The shadow-budget change intentionally makes the shadow KPI window reflect
  what live would do; note it in the operator activation review.
- If a future plan adds multi-task acting, the cooldown write must move per
  acted task (it is per `candidate.id` here).
- `topicKey` dedupe assumes normalized text; if the extract prompt changes
  task wording, two phrasings of one topic will still be two entries — a
  future embedding-based key is the follow-up (out of scope).
