# Plan 620: Repair the memory/thread open-loop state (schemaV2 population, thread status, two-sided observed store)

> **Executor instructions**: Follow this plan step by step; run every
> verification and confirm the expected result. STOP and report on any STOP
> condition. Update the status row in `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 08d9c9a..HEAD -- lib/social-memory.js lib/threads.js lib/gate.js lib/local-prompts.js test/social-memory.test.js`
> On drift, compare the excerpts; mismatch = STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (independent of 617/618/619; complements them)
- **Category**: correctness
- **Planned at**: commit `08d9c9a`, 2026-09-11

## Why this matters

The two sources that *could* hold a durable "open commitment" are effectively
empty in production, so nothing else can rely on them:

- `socialMemory` schemaV2 is enabled (`openclaw.json`: `schemaV2:true`,
  `personStore:true`) but the live person store has **0** `open_threads`,
  **0** `relationship`, **0** `emotional_state`. `threads.js` builds its
  `openTopics` exclusively from those, so every live `state/social-threads/*`
  file has `openTopics: []`.
- The DM observed store records only the agent's own replies (inbound is
  written only on the silence path), so a restart/rebuild cannot reconstruct
  what the user asked.

Additionally, the thread model can never *close*: memory extraction drops
the agent's own utterances and there is no resolution field, so a fulfilled
commitment stays "open".

After this plan: schemaV2 population is observable and tested, threads carry a
timestamp/owner/status, and the observed store is two-sided — so plans 617/619
have a second, recoverable source of open loops.

## Current state

- `lib/social-memory.js`:
  - schemaV2 merge at `:377-395` (fields `relationship`, `open_threads`,
    `emotional_state`; absent field silently keeps the previous value).
  - self-speaker drop at `:271-272`; extract window `:327-329` (buffer only).
  - the agent's own replies are ingested by `naturalize.js:383` but dropped
    by the self-filter.
- `lib/threads.js`:
  - `collectOpenTopics` at `:95-123`; `entryTs` falls back to person
    `lastSeenTs` (`:104`); `awaiting` is `"agent"` only when an own name is in
    `whoOwesWhat`, else `"member"` (`:108-111`) — there is no `"none"`.
  - `rebuild` at `:125-141` (uses observed store).
- `lib/gate.js`: `persist()` at `:64-69`; only `markStaySilent` calls
  `pushObserved` + `persist` (`:161-168`). The speak path does not persist the
  inbound.
- Config: `socialMemory.schemaV2` and `threads.enabled` are already live.
- Convention: `node:test` with inline fakes; model after
  `test/social-memory.test.js` and `test/threads.test.js`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| All tests | `cd ~/human-engine && npm test` | all pass |
| Parity | `node test/parity-matrix.mjs --check` | exit 0 |
| Focused | `node --test test/social-memory.test.js test/threads.test.js` | pass |

## Scope

**In scope**:
- `lib/social-memory.js`, `lib/threads.js`, `lib/gate.js`
- `lib/local-prompts.js` (only the `buildMemoryExtractPromptV2` instruction text, if needed)
- `test/social-memory.test.js`, `test/threads.test.js`, `test/parity-matrix.mjs`
- `plans/README.md`

**Out of scope**:
- `lib/dm-proactive.js`, `lib/initiative*.js` (other plans).
- Changing extraction cadence defaults or the person-store privacy scope
  (separate decision).

## Git workflow

- Branch: `advisor/620-memory-thread-open-loop-repair`.
- Commit: `fix(social-memory,threads): durable open-loop state repair (plan 620)`.
- Do NOT push.

## Steps

### Step 1: Observability for empty schemaV2 fields

In the extract merge (`lib/social-memory.js:371-404`), after building
`mergedPeople`, when `schemaV2 === true` and there was at least one extracted
person, compute how many entries have a non-empty `open_threads` /
`relationship` / `emotional_state`. If all three are empty across all
extracted people, emit one warn line:

```
human-engine: memory-v2 fields empty agent=<agentId> people=<n> — check buildMemoryExtractPromptV2
```

Use the resolved scope agentId (fix the existing bug at `:375` that passes
`parsed?.agentId` to `isSelfName` — use the scope's agentId, matching `:343`).

**Verify**: `node --test test/social-memory.test.js` → pass; a new test with a
fake LLM returning people without v2 fields asserts the warn is logged once.

### Step 2: Assert the v2 prompt requests the fields

Open `lib/local-prompts.js` `buildMemoryExtractPromptV2` (around `:220-239`).
Confirm the JSON schema in the prompt explicitly lists `open_threads`
(with `topic`/`lastExchange`/`whoOwesWhat`), `relationship`, and
`emotional_state`. If any is missing, add it verbatim to the prompt. Add a
prompt unit test asserting all three keys appear in the system prompt.

**Verify**: `node --test test/local-prompts.test.js` → pass.

### Step 3: Thread status/owner/timestamp

In `lib/threads.js` `collectOpenTopics` (`:95-123`):
- `entryTs` prefers an explicit per-thread `lastUpdateTs`, then `lastTs`,
  then person `lastSeenTs` (`:104`).
- Compute `owner`: `"agent"` if an own name appears in `whoOwesWhat`;
  `"member"` if a non-empty `whoOwesWhat` without an own name; `"none"` when
  `whoOwesWhat` is empty. Keep `awaiting === owner` for backward
  compatibility with the decide guard (`lib/threads.js:235`).
- Add `status` passthrough: if the memory thread carries `status === "resolved"`,
  skip it.

**Verify**: `node --test test/threads.test.js` → pass; new cases: empty
`whoOwesWhat` → `awaiting:"none"`; `status:"resolved"` thread excluded;
`lastUpdateTs` drives expiry.

### Step 4: Two-sided observed store

At the `markSpeak(...)` call site in `lib/gate.js` (the speak branch of
`before_agent_reply`), persist the inbound exactly as `markStaySilent` does:

```js
persist(sk, senderName, prompt);   // observed-store line for the inbound
```

(Do not add `pushObserved`/peek here if that would duplicate the peek line —
peek already carries the inbound; only the observed-store persistence is
missing.) If `markSpeak` is the natural place, extend it to accept `prompt`
and call `persist(sk, senderName, prompt)` when provided; update its caller to
pass the cleaned body.

**Verify**: `node --test test/gate.test.js test/index.test.js` → pass; a new
test asserts a speak decision writes one observed-store row with the inbound
speaker/text.

### Step 5: Parity + README

Add rows: schemaV2-empty observability, thread owner/enum, observed inbound on
speak.

**Verify**: `node test/parity-matrix.mjs --check` → exit 0.

## Test plan

- `test/social-memory.test.js`: empty-v2 warn; v2 fields round-trip; correct
  self-exclusion agentId.
- `test/threads.test.js`: owner enum, resolved skip, `lastUpdateTs` expiry.
- `test/gate.test.js`/`test/index.test.js`: inbound persisted on speak.
- Verify: `cd ~/human-engine && npm test` → all pass.

## Done criteria

- [ ] `npm test` exits 0; parity exit 0
- [ ] `grep -n "memory-v2 fields empty" lib/social-memory.js` matches
- [ ] `grep -n '"none"' lib/threads.js` matches the owner enum
- [ ] a speak turn writes an observed-store row (new test)
- [ ] No files outside scope modified (`git status`)

## STOP conditions

Stop and report if:
- Persisting the inbound on speak causes the decide transcript to show a
  duplicate user line (the observed-store layer must not double the current
  message — the existing tail-dedup should handle it; if not, STOP).
- The v2 prompt already lists the fields (the empty state is then a model
  regression — report and land only Steps 1/3/4).
- Real PII would enter tests/fixtures/docs.

## Maintenance notes

- The observed store rotates at 200 lines (`lib/observed-store.js:5-6`); a
  two-sided DM store doubles the write rate. If DM volume grows, revisit the
  cap.
- `threads.js` consumes `open_threads`; once Step 1/2 make them populate,
  re-check `state/social-threads/hori-wa` after a few extractions.
