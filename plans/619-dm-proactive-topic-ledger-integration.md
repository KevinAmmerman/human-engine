# Plan 619: Make dm-proactive consume the durable open-loop ledger (topic cooldown, attempt cap, agent-owed skip, shared outbox)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm its expected result before moving on. If a
> "STOP condition" occurs, stop and report. Update this plan's status row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 08d9c9a..HEAD -- lib/dm-proactive.js lib/dm-gate-core.js lib/proactivity-outbox.js lib/initiative.js lib/config.js openclaw.plugin.json index.js test/dm-proactive.test.js`
> On drift, compare the excerpts below; mismatch = STOP.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/617-initiative-durable-open-loop-state.md, plans/618-ledger-read-surface-and-gate-cli-fix.md
- **Category**: correctness / architecture
- **Planned at**: commit `08d9c9a`, 2026-09-11

## Why this matters

The DM follow-up path repeats topics because it has no durable per-topic
memory: idempotency is keyed on the amnesiac cron's date-scoped envelope id
(`fu-<yyyyMMdd>-<slug>`), gate-failed candidates are re-offered every tick
with no attempt memory, and the "open commitment" state is a single
`lastSentCandidateId` slot per scope that a newer topic overwrites. The
durable ledger built in plans 617/618 fixes the storage; this plan makes
`dm-proactive` actually **use** it:

- topic cooldown and attempt cap block re-nudging the same topic across days
  and across re-slugged ids;
- "agent-owed" candidates (the agent itself already committed to do the
  thing) are skipped;
- only one unanswered attempt per topic is allowed at a time;
- every producer shares one outbound min-gap budget;
- malformed `[[fu:` candidates fail **closed** (never delivered ungated);
- inbound replies resolve the matching topic.

## Current state

- `lib/dm-gate-core.js` — the ONE gate shared by hook + CLI.
  - `evaluateDmGate(candidate, ctx)` at `:79-190`; `ctx` carries
    `{dcfg, now, counter, agentName, newestSpeaker, duplicate, byKind, dayFit}`.
  - `envelopeError` validates the envelope at `:198-209` — currently rejects
    unknown *invalid* values but ignores extra keys; no `topicKey`/`owner`.
  - `candidateFromEnvelope` at `:240-252` does not copy a `topicKey`.
- `lib/dm-proactive.js` — hook + state.
  - `onMessageSending` at `:703-782`; malformed branch at `:724-758` returns
    `{ content: draftOnly }` in shadow (`:754-756`) — **an ungated delivery**.
  - `evaluateGate` at `:787-824` injects state into `evaluateDmGate`.
  - `handleCandidate` at `:959-1023`; shadow branch records only
    `lastSentAt`/`lastSentCandidateId` and never bumps budget (`:976-995`);
    live records `bumpBudget` + `recordSentId` (`:1012-1013`).
  - `onMessageReceived` attribution at `:563-609` uses the single
    `lastSentCandidateId` slot.
- `lib/proactivity-outbox.js` — shared per-scope min-gap store, used by
  `proactive` and `initiative` only (`:7-10`); `record(scope, source, ts)` /
  `lastOutbound(scope)`.
- `lib/initiative.js` — `createInitiative({cfg, stateDir, log, llm, runtime,
  state, threads, now, rng, outbox})` at `:87`; it creates its own store at
  `:91` (`createInitiativeStore`). Plan 617 added `findByTopicKey` /
  `listOpenTasksForAgent` to the store.
- `index.js` — wires modules; `createDmProactive(...)` and
  `createInitiative(...)` call sites plus the shared `outbox`.
- Conventions: state writes tmp+rename 0600 / dir 0700; versioned state;
  `wrapUntrusted` for model-injected text; no real PII in the PUBLIC repo.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| All tests | `cd ~/human-engine && npm test` | all pass |
| Parity | `node test/parity-matrix.mjs --check` | exit 0 |
| Focused | `node --test test/dm-proactive.test.js test/initiative.test.js` | pass |

## Scope

**In scope**:
- `lib/dm-gate-core.js`, `lib/dm-proactive.js`, `lib/proactivity-outbox.js`
- `lib/initiative.js` (accept an injected store; no behavior change when absent)
- `lib/config.js` + `openclaw.plugin.json` (new dmProactive keys + schema)
- `index.js` (share one ledger store + one outbox across modules)
- `test/dm-proactive.test.js`, `test/initiative.test.js`, `test/config.test.js` (extend)
- `test/parity-matrix.mjs`, `plans/README.md`

**Out of scope**:
- `bin/` CLIs (plan 618).
- The cron prompt and any OpenClaw config (Track 2 plans 635–639).
- Flipping `dmProactive.shadow`/`initiative.enabled` live.

## Git workflow

- Branch: `advisor/619-dm-proactive-ledger`.
- Commit style: `feat(dm-proactive): durable topic ledger integration (plan 619)`.
- Do NOT push.

## Steps

### Step 1: Envelope + gate accept `topicKey` / `owner`

In `lib/dm-gate-core.js`:
- In `envelopeError` (`:198-209`), after existing checks, tolerate optional
  fields: if `envelope.topicKey` is present it must be a non-empty string
  (`/^tk-[a-z0-9]{8,}$/`), else `"bad-topic-key"`; if `envelope.owner` is
  present it must be `"agent"` or `"user"`, else `"bad-owner"`. Absent =
  valid (backward compatible).
- In `candidateFromEnvelope` (`:240-252`), copy `topicKey` and `owner`.
- In `evaluateDmGate`, add an injected `ctx.topicState` (nullable):
  `{ attempts, cooldownUntil, openAttemptAt }` and `candidate.owner`. Add
  verdicts (only when `candidate.topicKey` is set — fail-open otherwise):
  - `topic-cooldown`: `!(topicState?.cooldownUntil > now)`
  - `topic-attempts`: `!((topicState?.attempts ?? 0) >= (dcfg.topicMaxAttempts ?? 3))`
  - `topic-open`: `!(topicState?.openAttemptAt && now - topicState.openAttemptAt < (dcfg.openAttemptCooldownMinutes ?? 240) * 60000)`
  - `agent-owed`: `candidate.owner !== "agent"`

**Verify**: `node --test test/dm-proactive.test.js` → pass (existing cases
unaffected because `topicState` is absent); add focused unit assertions for
each new verdict.

### Step 2: Share ONE ledger store and ONE outbox in `index.js`

- Change `createInitiative` to accept an optional `store` in its options
  (`lib/initiative.js:87`): `const store = opts.store || createInitiativeStore({stateDir, log});`
  (add `store` to the destructured options; when absent behavior is
  byte-identical).
- In `index.js`: create `const initiativeStore = createInitiativeStore({stateDir, log})`
  and `const outbox = createProactivityOutbox({...})` **once**, then pass
  `store: initiativeStore` to `createInitiative` and a new `ledger:
  initiativeStore`, `outbox` to `createDmProactive`.
- `createDmProactive` accepts optional `ledger`/`outbox` (`lib/dm-proactive.js:74`)
  and no-ops those features when absent (keeps existing tests green).

**Verify**: `npm test` → all pass; `grep -n "createInitiativeStore" index.js`
shows a single shared instance.

### Step 3: dm-proactive reads/writes the ledger

In `evaluateGate` (`lib/dm-proactive.js:787-824`): when `candidate.topicKey`
is set and `ledger` is available, resolve `topicState` via
`ledger.findByTopicKey(scopeKey(candidate.agentId, candidate.sessionKey),
candidate.topicKey)` and inject:
`topicState = { attempts: t?.attempts ?? 0, cooldownUntil: t?.cooldowns?.[t.id]?.until ?? 0, openAttemptAt: t?.status === "open" ? (t.lastActAt || 0) : 0 }`.

In `handleCandidate` (`:959-1023`), after a gate-pass attempt in BOTH modes:
- Upsert the ledger task for the topic:
  - if none exists: `{ id: "lt-" + sha1(topicKey).slice(16), topicKey, text:
    candidate.suggestedText.slice(0,160), status: "open", attempts: 0,
    createdAt: now }`
  - `attempts += 1`; `lastActAt = now`; set `stateObj.cooldowns[task.id] =
    { until: now + (dcfg.topicCooldownMinutes ?? 240) * 60000 }`.
  - `ledger.save(scope, stateObj)`.
- Record the shared outbox: `outbox?.record(scopeKey(...), "dm-proactive", now)`.

In `onMessageReceived` (`:563-609`), before the existing single-slot
attribution: if a ledger topic for this scope is `status:"open"` and the
inbound text token-overlaps its `text` by ≥ 2 content tokens, mark it
`status:"resolved"`, `resolvedAt: now`, clear its cooldown → `ledger.save`.
Keep the existing `lastSentCandidateId` logic for byKind/outcome backfill.

**Verify**: `node --test test/dm-proactive.test.js` → pass; new tests:
two deliveries of the same `topicKey` on different days → second is blocked
by `topic-cooldown`/`topic-attempts`; a resolved topic → `topic-open` clears.

### Step 4: Fail closed on malformed envelopes

In the malformed branch (`lib/dm-proactive.js:724-758`): in shadow, return
`{ cancel: true }` as well (strip + log stays, but never deliver the draft
ungated). Update the comment.

**Verify**: `node --test test/dm-proactive.test.js` → pass; a malformed
`[[fu:`-prefixed send in shadow returns `{cancel:true}` and appends a
`malformed-envelope` log entry (regression test).

### Step 5: Config + schema

Add to `lib/config.js` `dmProactive` defaults and `openclaw.plugin.json`
(top-level `dmProactive.properties` and
`agentProfiles.additionalProperties.properties.dmProactive`):

```
topicMaxAttempts: 3,
topicCooldownMinutes: 240,
openAttemptCooldownMinutes: 240,
```

Then stringify and re-run schema validation tests.

**Verify**: `npm test` → pass; `node -e "JSON.parse(require('fs').readFileSync('openclaw.plugin.json'))"` → no throw.

### Step 6: Parity + README

Add parity rows: topic-cooldown, topic-attempts, topic-open, agent-owed,
shared-outbox, malformed-fail-closed.

**Verify**: `node test/parity-matrix.mjs --check` → exit 0.

## Test plan

- `test/dm-proactive.test.js`: envelope `topicKey` tolerance/rejection; each
  new verdict; two-day same-topic block; resolve-on-reply; malformed
  fail-closed; outbox recorded; ledger upsert idempotent.
- `test/initiative.test.js`: injected-store path produces byte-identical
  behavior when omitted.
- `test/config.test.js`: new keys resolve + deep-merge + per-agent override.
- Pattern: model after the existing gate/shadow tests in
  `test/dm-proactive.test.js`.
- Verify: `npm test` → all pass, 0 fail.

## Done criteria

- [ ] `cd ~/human-engine && npm test` exits 0
- [ ] `node test/parity-matrix.mjs --check` exits 0
- [ ] `grep -n "topicState\|topic-cooldown\|topic-attempts" lib/dm-gate-core.js` matches
- [ ] `grep -n "findByTopicKey\|outbox" lib/dm-proactive.js` matches
- [ ] malformed branch returns `{ cancel: true }` in shadow
- [ ] `dmProactive.shadow` and `initiative.enabled` unchanged in config
- [ ] No files outside scope modified (`git status`)

## STOP conditions

Stop and report if:
- Sharing the store requires changing `initiative`'s behavior when the
  feature is disabled (it must remain a strict no-op).
- The topic resolution heuristic cannot be made deterministic/testable
  without an embedding dependency (if so, land only the delivery-side ledger
  and defer resolve-on-reply to a follow-up).
- A verification fails twice after a reasonable fix.
- Real PII would enter code/tests/docs.

## Maintenance notes

- The ledger is now written by two modules (`initiative` capture and
  `dm-proactive`); the shared store instance in `index.js` is what keeps the
  in-memory cache coherent. If a third writer appears, route it through the
  same instance.
- `topicKey` must remain date-independent; the producer (plan 635) is
  responsible for stable keys.
- Reviewer: check that shadow-gate-fail never records a "delivered" ledger
  attempt, and that resolve-on-reply cannot mark an unrelated topic resolved
  (token-overlap threshold).
