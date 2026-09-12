# Plan 613: Initiative — a modular, multi-tenant proactive task & memory engine

> **Executor instructions**: This is a phased design + implementation plan.
> Read the whole plan before writing code. Build Phase 0–2 behind the
> `initiative.enabled:false` default; only Phase 3 turns anything live, and
> only via the operator checklist. Run the verification after every phase.
> If anything in "STOP conditions" occurs, stop and report. When done, update
> the plan's status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat ad34c15..HEAD -- lib/ config.js index.js openclaw.plugin.json lib/local-prompts.js lib/config.js`
> (Use the full in-scope list from the Scope section.) If anything changed,
> re-read the "Building blocks" cuts against live code before proceeding.

## Status

- **Priority**: P1 (direction/feature)
- **Effort**: L (multi-day; phased)
- **Risk**: MED (proactive outbound to real group chats once live)
- **Depends on**: plan 036 (message formatting) for human-readable output; recommended before the live phase
- **Category**: direction / feature / architecture
- **Planned at**: commit `ad34c15`, 2026-09-10

## Why this matters

Human Engine already reacts well, but it cannot *own* anything. Today
proactivity exists in three disconnected, scope-specific pieces (`proactive.js`
generic group funnel, `dm-proactive.js` DM follow-ups, `threads.js` open-topic
state), all default-off, and none of them remembers a task a member handed to
the agent ("organize the videocall", "remember X", "follow up with Y"). The
result observed live: the agent agreed to organize a group call but only acted
when someone messaged again.

This plan adds **Initiative**: one first-class, per-agent, per-scope engine that
(a) captures tasks/standing instructions from the conversation, (b) keeps them
durably and injects the open ones into the agent's context ("she remembers"),
and (c) runs a configurable, heartbeat-like tick that acts on due tasks through
an anti-annoyance gate. It is built exactly like the existing multi-tenant
features: declarative `agentProfiles` overrides, per-agent state namespacing,
shadow-first rollout, parity-matrix contract. Adding a new group/agent means
config, not code.

## Research findings (inlined — do not re-research)

Platform (OpenClaw 2026.9.3), from the live docs:

- **`api.runtime.subagent.run({ sessionKey, message, deliver:true, idempotencyKey })`** — starts a background agent turn in a session and delivers the reply. Already used by `lib/proactive.js:807` and `lib/dm-proactive.js:1005` against group/DM session keys. This is the delivery primitive for Initiative.
- **`api.runtime.system.requestHeartbeat({source,intent,reason})` / `runHeartbeatOnce(...)`** — can wake the agent's *main* session, but heartbeat is a single main-session turn per agent, not per group, and needs an owner DM route. Not suitable for per-group cadence; the plugin's own `setInterval` (already used at `index.js:171-174`) is the right mechanism. Initiative is "heartbeat-like": configurable interval + active hours + quiet hours + budget, scoped per group/agent.
- **`api.runtime.state.openKeyedStore/...`** — durable SQLite plugin state, but the docs mark it "available only to bundled plugins and trusted official plugin installations". Human Engine loads from a symlinked local extension (`~/.openclaw/extensions/human-engine`), so do **not** depend on it. Keep the repo's proven file-state pattern (`state/`, 0600/0700, version field, tmp+rename).
- **`api.runtime.agent.session.getSessionEntry / listSessionEntries`** and **`openclaw/plugin-sdk/session-transcript-runtime`** (`readSessionTranscriptEvents`) — available; the gate already reads transcripts this way (`index.js:99-131`). Initiative can reuse a `readTranscript` callback if it needs live messages, but the first version should rely on the observed store + in-memory peek + threads snapshot (cheaper, no sessionId dependency).
- **Hooks**: `message_received`, `before_prompt_build`, `gateway_start`/`gateway_stop` (already wired in `index.js:150-184`). No plugin-level scheduler hook exists.
- Docs: [Plugin runtime background work](https://docs.openclaw.ai/plugins/sdk-runtime/background-work), [Plugin runtime agent helpers](https://docs.openclaw.ai/plugins/sdk-runtime/agent), [Plugin runtime state and system](https://docs.openclaw.ai/plugins/sdk-runtime/state-and-system), [Heartbeat](https://docs.openclaw.ai/gateway/heartbeat).

Repo building blocks to reuse (read these before coding):

- **`lib/threads.js`** — the canonical per-agent×scope durable-state pattern: `scopeToPath(stateDir, agentId, sessionKey)`, `defaultState()` with a `version`, `loadFromFile`/`writeFile` (tmp+rename, 0600), 2 s debounced `flush`, `CACHE_CAP`, `snapshotFor`, `stop()`. Copy this shape for the Initiative state store.
- **`lib/dm-proactive.js`** — budget/cooldown/ignore-streak/engagement attribution and shadow-log: per-agent buckets (`budgetByAgent`, `sentBuckets`, `byKindBuckets`), `getBudget`/`bumpBudget`, `onMessageReceived` reply attribution (`lastSentCandidateId` + 48 h window), `appendLog`/`pruneLog`, `resolveByKind` (ignoreStreak ≥2 → ×0.5, ≥4 → paused), shadow vs live. Reuse the *patterns*, not the DM-specific envelope code.
- **`lib/proactive.js`** — the 30-min tick (`index.js:171`), `evaluate()` anti-annoyance (budget, min-gap, cooldown, quiet hours via `isQuietHour` + `localDayKey` in Berlin TZ, velocity), `shadowOrSkip`, `fire()` → `subagent.run`, `MESSAGE_TEMPLATES`. `localDayKey`/`isQuietHour`/`capObject` are already exported from this file — import them.
- **`lib/social-memory.js`** — the extraction cadence pattern (`extractEvery`/`extractMinutes`, in-flight guard, tolerant JSON parse, caps, per-agent vs per-session `personStore`), and the schemaV2 `open_threads`/`whoOwesWhat` data that can seed task capture.
- **`lib/observed-store.js`** — `readObserved(sessionKey, n)` gives the recent conversation (including silenced messages and the agent's own replies); use it for capture windows and "is the room hot".
- **`lib/config.js`** — `defaultConfig()`, `NESTED_KEYS` (one-level merge), `resolveAgentConfig`/`resolveAgentConfigForSession`, `isScopedAgent`. Adding a key here is what makes it per-agent overridable.
- **`lib/gate.js:516-554` (`onBeforePromptBuild`)** — where context is injected (`appendContext`, `appendSystemContext`); Initiative hooks the same place.
- **`lib/anti-tell.js`** — `sanitizeTells` and (after plan 036) `expandInlineLists`; run composed proactive text through these before sending.

## Design

### Conceptual model

Two durable record types per scope (agent × chat):

- **Task** — something the agent owns and should act on/follow up:
  `"Organize the group videocall"`, `"Ask T. for the missing slot"`,
  `"Remember to bring X on Friday"`.
- **Directive** — a standing instruction/preference the agent should always obey
  in this scope: `"Never ping before 10:00"`, `"Always write in lowercase"`,
  `"Use 'du', not 'Sie'"`.

The engine has three flows: **capture** (conversation → records), **recall**
(records → agent context), **initiative** (due records → gated proactive act).

### Data model

Per-agent×scope state file `state/initiative/<agentId>/<scopeSafe>.json`:

```jsonc
{
  "version": 1,
  "scope": "agent:<agentId>:<channel>:<kind>:<rest>",
  "agentId": "<agentId>",
  "tasks": [{
    "id": "t-<sha1(text+createdAt),16>",
    "kind": "task|reminder|commitment|question",
    "text": "<imperative, <=160 chars>",
    "people": ["<name>", "..."],
    "createdAt": 0, "dueAt": null,
    "status": "open|snoozed|done|expired",
    "source": { "speaker": "<name>", "excerpt": "<<=160 chars>", "messageTs": 0 },
    "attempts": 0, "lastActAt": null, "lastActKind": null,
    "ignoreStreak": 0, "doneAt": null
  }],
  "directives": [{ "id": "d-...", "text": "<<=160 chars>", "createdAt": 0 }],
  "lastCaptureTs": 0,
  "lastActAt": 0,
  "lastHumanAt": 0,
  "day": "YYYY-MM-DD", "actsToday": 0,
  "acts": [{ "ts": 0, "taskId": "t-...", "id": "<candidateId>", "kind": "task" }],
  "replies": [{ "ts": 0 }],
  "cooldowns": { "<taskId>": { "until": 0 } }
}
```

Caps: `tasks` ≤ `initiative.maxOpenTasks` (evict `done` first, then oldest);
`directives` ≤ `initiative.directives.maxPerScope`; `acts` rolling 14 days;
file ≤ 64 KB with same eviction discipline as `social-memory.js:248-255`.
All writes tmp+rename, mode 0600, directory 0700.

Shadow/live log `state/initiative.jsonl`, one entry per candidate:
`{ ts, day, mode, candidateId, taskId, kind, scope, agentId, gate:{pass,reasons},
decide:{decision,reason}, render:{preview,draft}, outcome:{repliedWithin48h},
sent:bool }` — 14-day prune, same as `lib/dm-proactive.js:381-411`.

### Config schema (`initiative`, per-agent overridable)

Add to `lib/config.js` `defaultConfig()` and to `NESTED_KEYS`, and mirror in
`openclaw.plugin.json` (top-level `properties.initiative` + the
`agentProfiles.additionalProperties.properties.initiative` entry):

```jsonc
"initiative": {
  "enabled": false,            // master switch, default OFF
  "shadow": true,              // log candidates, never send
  "agents": [],                // optional allowlist; empty = cfg.agents
  "scopes": ["group"],         // "group" and/or "dm"
  "everyMinutes": 60,          // tick cadence per scope; 0 = no ambient tick
  "activeHours": { "start": "08:00", "end": "22:00", "timezone": "Europe/Berlin" },
  "quietStart": "22:00",
  "quietEnd": "07:00",
  "maxActsPerDay": 2,
  "minGapMinutes": 240,
  "minGapAfterAgentSpeakMinutes": 30,
  "hotWindowMinutes": 15,      // room considered "hot" after a human message
  "capture": {
    "keywords": true,          // deterministic keyword trigger (no extra LLM when false)
    "everyMessages": 20,       // extraction cadence (0 = disabled)
    "everyMinutes": 0
  },
  "firstNudgeMinutes": 120,    // age before an un-acted task becomes a candidate
  "taskExpiryDays": 30,
  "probability": 0.8,
  "cooldownBaseMinutes": 240,
  "directives": { "enabled": true, "maxPerScope": 10 },
  "maxContextChars": 600
}
```

`initiative.everyMinutes` is the user-facing "wie häufig gecheckt werden soll".
Because the tick is throttled (see below), it can be set per agent through
`agentProfiles["<agentId>"].initiative.everyMinutes`.

### Flows

**Capture** (`onMessageReceived` → buffer; extraction on trigger)
1. Append `{speaker, text, ts}` to a per-scope buffer (cap 200, like social-memory).
2. Trigger extraction when the newest text matches the keyword regex
   (German + English verbs "merk dir", "kümmere dich", "plane", "organisier",
   "denk dran", "vergiss nicht", "erinner", "schau nach", "frag nach",
   "remember", "organize", "follow up", "remind me", …) **or** the
   `capture.everyMessages`/`everyMinutes` cadence fires.
3. One LLM call `human-engine-initiative-extract` over the last N messages +
   the existing records, strict JSON:
   `{"tasks":[{"text","kind","people","dueAt"?}],"directives":[{"text"}],"done":[taskIds],"drop":[taskIds]}`.
   Parse tolerantly (`raw.indexOf("{")`/`lastIndexOf("}")`, like
   `social-memory.js:363-369`); merge with caps and normalized-text dedupe;
   an in-flight guard prevents overlapping extracts per scope.
4. `done`/`drop` mark tasks `done`/`expired`. Keep an audit trail (status
   change + ts), never hard-delete.

**Recall** (`onBeforePromptBuild`)
- `contextFor(sk, agentId)` renders a bounded block (`maxContextChars`):
  ```
  Open tasks you own in this chat (keep them in mind, do not force them):
  - <text> (open since <Nd>, with <people>)
  Standing instructions for this chat:
  - <directive>
  ```
- Wrap the whole block in the untrusted markers (`wrapUntrusted`) — it is
  derived from member messages. Append via `appendSystemContext` only when the
  block is non-empty. Never inject in heartbeat/non-chat sessions.

**Initiative** (`tick`)
- `index.js` registers ONE master `setInterval(tick, 5 * 60 * 1000)` (unref'd)
  in addition to the existing proactive tick; `initiative.js` throttles each
  scope by its resolved `everyMinutes` (`lastTickAt` in memory). This supports
  per-agent cadence without dynamic intervals.
- For each known scope (populated in `onMessageReceived`; also seeded from the
  state dir on `gateway_start`), load state and build candidates:
  open task where `dueAt <= now`, or `attempts == 0 && now - createdAt >=
  firstNudgeMinutes`, or `now - lastActAt >= everyMinutes` (re-check cadence).
- Run the **anti-annoyance gate** (deterministic), then one LLM decide.
- On pass + ACT: render, sanitize, send (`shadow:true` → log only).

### Anti-annoyance gate (the "ohne auf die Nerven zu gehen" core)

Ordered, cheapest first; any hit → log `skip:<reason>` and stop:

1. `enabled === true`; scope kind ∈ `scopes`; agent in the allowlist.
2. Active hours + quiet hours in the scope's timezone (`isQuietHour` already
   handles wrap-around; add an `isActiveHour` sibling using the same
   `BERLIN_FMT` machinery in `proactive.js:102-124`).
3. `actsToday < maxActsPerDay`.
4. `now - lastActAt >= minGapMinutes`.
5. **Room not hot**: `now - lastHumanAt > hotWindowMinutes` (do not interrupt a
   live conversation). Velocity from `state.transcriptPeekBySession` may
   reinforce this.
6. **Agent has not just spoken**: `threads.snapshotFor(sk, agentId).lastAgentSpeakTs`
   older than `minGapAfterAgentSpeakMinutes`.
7. Per-task cooldown not active; task not `done`/`expired`.
8. `ignoreStreak`: ≥2 → budget ×0.5; ≥4 → scope paused for 48 h (mirrors
   `dm-proactive.js:546-559`).
9. Seeded probability (`probability`).
10. **LLM decide** `human-engine-initiative-decide`:
    `{"decision":"ACT"|"SKIP"|"DONE","reason":"<=8 words"}` — DONE marks the
    task complete without sending.

Engagement attribution: on any inbound, set `lastHumanAt`; if the last act is
≤48 h old, record a reply, reset `ignoreStreak`, backfill the shadow-log
`outcome.repliedWithin48h` (reuse the `dm-proactive.js:563-609` pattern).

### Delivery & formatting

- Compose with `buildInitiativeRenderPrompt` (persona + voice + task + optional
  one memory reference), then `sanitizeTells` + `expandInlineLists` (plan 036)
  so the text obeys the group's style and never arrives as a mangled list.
- Send via `runtime.subagent.run({ sessionKey, message, deliver:true,
  idempotencyKey: "human-engine-initiative-" + candidateId })`.
- `sentIds` per agent (bounded LRU) for idempotency across restarts/ticks.
- If `subagent.run` is unavailable, log and skip (never lose the task; the next
  tick retries).

### Multi-tenancy

- `initiative` is a `NESTED_KEYS` entry → `agentProfiles[agentId].initiative`
  merges one level over globals (`resolveAgentConfig`). State is namespaced by
  agentId. Allowlist via `cfg.agents` or explicit `initiative.agents`.
- A new group/agent needs only: contacts/SOUL + an `agentProfiles` entry with
  `initiative` overrides. No code — same contract as `wiki/operations/onboarding-multi-tenant.md`.

### Interaction with existing proactivity

`proactive` (group) and `dmProactive` (DM) stay as-is and default-off/shadow.
Initiative initially accounts only its own sends. Phase 3 should unify the
outbound budget (one "last proactive outbound per scope" marker shared by
`proactive`/`initiative`; `dmProactive` remains DM) so two systems can never
stack a nudge. That unification is deliberately a separate decision (see Open
questions).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Tests | `cd ~/human-engine && npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | full coverage, exit 0 |
| Focused | `node --test test/initiative.test.js` | all pass |
| Lint/typecheck | — | repo has none (plain ESM, Node 24+) |

## Scope

**In scope (create/modify):**
- `lib/initiative-store.js` (new) — durable per-agent×scope state + shadow log
- `lib/initiative.js` (new) — capture, recall, tick, gate, decide, dispatch
- `lib/local-prompts.js` — three new prompt builders
- `lib/config.js` — `initiative` defaults + `NESTED_KEYS`
- `openclaw.plugin.json` — `initiative` schema (top-level + agentProfiles)
- `index.js` — instantiate, hooks, master tick, `gateway_stop`
- `test/initiative-store.test.js`, `test/initiative.test.js` (new)
- `test/register.test.js` — update the exact hook counts (Phase 0 adds
  `message_received` 3→4 and `before_prompt_build` 3→4; `Object.keys(hooks).length`
  stays 9 because only existing hook names are reused)
- `test/harness.test.js` — update the static "no-residue" hook snapshot
  (`plugin registers exactly the expected hooks + commands + lifecycle`,
  sorted string array ~lines 185-198) to 4× `message_received` and
  4× `before_prompt_build`; the `gateway_start`/`gateway_stop` count assertions
  stay 1
- `test/parity-matrix.mjs` — new rows
- `package.json` + `openclaw.plugin.json` version + `CHANGELOG.md` head (0.5.0)
- `wiki/` quickstart/environment/source-map/plans + `plans/README.md`
- `plans/036-vertical-list-formatting.md` is a hard dependency for the render path

**Out of scope:**
- Changing `proactive.js`/`dm-proactive.js` behavior (only reading their state
  for budget unification, which is Phase 3 and optional).
- Backend/cron changes; no OpenClaw `cron` jobs are created by this plugin.
- A user-facing task-board UI.
- Committing any real names, numbers, or session keys (repo is PUBLIC).

## Git workflow

- Branch: `advisor/613-initiative-engine`.
- One commit per phase, e.g.
  `feat(initiative): phase 0 — config, state store, feature flag (plan 613)`.
- Do NOT push or open a PR. Do NOT flip live config — that is the operator phase.

## Phases

### Phase 0 — Skeleton, config, durable store (no behavior)

1. Add the `initiative` config block to `lib/config.js` (`defaultConfig()` +
   `NESTED_KEYS`) and the matching JSON Schema to `openclaw.plugin.json`
   (top-level + `agentProfiles`). Bump version to `0.5.0` in
   `package.json`, `openclaw.plugin.json`, and `CHANGELOG.md` head.
2. Implement `lib/initiative-store.js` modeled on `lib/threads.js`:
   `scopeToPath`, `defaultState()` with `version:1`, `load`, `save`
   (tmp+rename 0600, 0700 dir), 2 s debounced flush, `CACHE_CAP`, `stop()`,
   `appendLog`/`pruneLog` for `state/initiative.jsonl` (14-day retention),
   and `__stateForTests()`.
3. Create a minimal `lib/initiative.js` exporting `createInitiative({ cfg,
   stateDir, log })` whose `onMessageReceived`, `onBeforePromptBuild`, `tick`,
   `stop` are early-return no-ops when `cfg.initiative.enabled !== true`.
4. Wire `index.js`: instantiate `createInitiative(...)`; register
   `api.on("message_received", wrap(initiative.onMessageReceived))` and
   `api.on("before_prompt_build", wrap(initiative.onBeforePromptBuild))`; add
   the 5-minute master tick (`setInterval`, unref'd, calling
   `initiative.tick()`) and call `initiative.stop()` in the existing
   `gateway_stop` handler.
5. Update the two exact-count test files:
   - `test/register.test.js`: the count assertions at lines ~57/60 (and the
     duplicate block ~83/86, ~103) become `message_received` 4 and
     `before_prompt_build` 4; `Object.keys(hooks).length` stays 9. The
     "invoking every captured handler" test must still pass (the new handlers
     are no-ops on a minimal ctx).
   - `test/harness.test.js`: the "no-residue static proof" hook snapshot
     (sorted array ~lines 185-198) gains one `message_received` and one
     `before_prompt_build` entry (the `gateway_start`/`gateway_stop` count
     assertions stay 1).
6. Guard everything behind `cfg.initiative.enabled === true` — with the default
   off, `npm test` behavior must be byte-identical (parity unchanged).

**Verify**: `npm test` all pass; `node test/parity-matrix.mjs --check` unchanged;
`node --test test/register.test.js` and `node --test test/harness.test.js` all
pass; `node --test test/initiative-store.test.js` passes (round-trip, version
migration from a frozen v1 fixture, caps/eviction, 0600 mode).

### Phase 1 — Capture + recall ("she remembers")

1. Add `buildTaskExtractPrompt` to `lib/local-prompts.js` (strict JSON, caps,
   `UNTRUSTED_DIRECTIVE`, self-exclusion of the agent name).
2. Implement capture in `lib/initiative.js`: buffer, keyword regex,
   cadence trigger, in-flight guard, one `llm.complete` call
   (`purpose:"human-engine-initiative-extract"`, `agentId`,
   `allowAgentIdOverride:true`, 30 s timeout), tolerant parse, merge with
   normalized dedupe and caps.
3. Implement `contextFor` + `onBeforePromptBuild` injection (bounded,
   untrusted-wrapped, group/DM per `scopes`), using `resolveAgentConfigForSession`.
4. Tests: extraction merge (fake LLM), dedupe, caps, `done`/`drop`, context
   rendering + `maxContextChars`, per-agent isolation, disabled = zero files.

**Verify**: `npm test`; focused `node --test test/initiative.test.js`; assert
`state/initiative/` is NOT created when `enabled:false`.

### Phase 2 — Initiative tick (shadow)

1. Add `buildInitiativeDecidePrompt` + `buildInitiativeRenderPrompt` to
   `lib/local-prompts.js` (persona + voice, "one short message, no lists/no
   markdown", strict decision JSON).
2. Implement the COMPLETE deterministic gate as a pure function
   `evaluateInitiative(candidate, ctx)` — all 10 rules in the "Anti-annoyance
   gate" section, including `isActiveHour` (added here), `lastHumanAt` hot-room,
   after-agent-speak, per-task cooldown, ignoreStreak multiplier/pause, and the
   seeded probability. Unit-testable, no I/O.
3. Implement `tick()`: scope discovery, per-scope `everyMinutes` throttle,
   candidate build, gate, decide, render + `sanitizeTells`/`expandInlineLists`,
   `sentIds`, shadow log, and the `actsToday`/`lastActAt`/`acts[]` counter
   updates. Live branch (`runtime.subagent.run`) is structured but guarded on
   `shadow !== true`; with the default `shadow:true` it is never reached.
4. Update `index.js` to pass the new deps into `createInitiative` (`llm`,
   `runtime: api.runtime`, `state`, `threads`); `tick` is already wired to the
   5-minute master interval.
5. Tests: each gate reason; decision parse tolerantly; shadow never calls
   `subagent.run`; idempotent candidate id; log pruning.

**Verify**: `npm test`; `node --test test/initiative.test.js`; a simulated tick
over a fixture scope produces exactly one shadow log entry per due task and
zero `subagent.run` calls.

### Phase 3 — Engagement attribution + shared budget + operator live path

1. Engagement attribution + outcome backfill: on inbound set `lastHumanAt` (the
   Phase-2 hot-room rule consumes it); attribute a reply ≤48 h after the last
   act → reset `ignoreStreak` and backfill the shadow-log
   `outcome.repliedWithin48h` (reuse `dm-proactive.js:563-609`).
2. **Required** (decision confirmed): unify the outbound budget with
   `proactive` so the two funnels cannot stack. Add a small shared
   "last proactive outbound per scope" helper (a versioned
   `state/proactivity-outbox.json`, or read `proactive.json`'s per-scope
   `lastSentAt`) that both `initiative` and `proactive` consult; `dmProactive`
   stays DM-only. Keep the read side fail-open (a missing/corrupt file must not
   block an otherwise valid act).
3. Write the operator runbook in `wiki/operations/environment.md`: shadow
   window KPIs (≥ N candidates, ≥ X% engaged, 0 gate violations), per-agent
   `shadow:false` flip, kill-switch (`initiative.enabled:false`), backup steps.
4. Do NOT flip anything live in code; the live flip is an operator step.

**Verify**: `npm test`; runbook reviewed; `initiative.enabled:false` still the
default in `defaultConfig()` and the manifest.

### Phase 4 — Multi-tenant docs, parity, wiki sync

1. Add parity rows (e.g. 83 capture-merge, 84 recall-injection, 85
   initiative-shadow, 86 anti-annoyance-gate, 87 multi-tenant isolation) with
   tags matching new test names.
2. Update `wiki/quickstart.md`, `wiki/architecture/overview.md`,
   `wiki/operations/environment.md`, `wiki/source-map.md`, `wiki/plans.md`.
3. Update `wiki/operations/onboarding-multi-tenant.md` with the `initiative`
   profile keys and a per-group cadence example.
4. Update `plans/README.md` status.

**Verify**: `npm test`; `node test/parity-matrix.mjs --check` full coverage;
`wiki` docs mention `initiative` and its defaults.

## Test plan

- `test/initiative-store.test.js`: file round-trip, v1→v1 no-op, caps/eviction,
  corrupted file recovery, 0600 perms, log prune boundary.
- `test/initiative.test.js`: keyword + cadence capture, extract merge/dedupe,
  `done`/`drop`, context bounded + untrusted-wrapped, every gate reason,
  decide parse (fenced/garbage/token), shadow logs and never sends, live branch
  calls `subagent.run` with idempotencyKey (fake runtime), engagement resets
  ignoreStreak, multi-tenant isolation (two agents same scope family).
- Pattern: model after `test/dm-proactive.test.js` (gate + shadow/live) and
  `test/threads.test.js` (state + rebuild). Use inline fakes; no network.
- Verification: `npm test` → all pass; parity fully covered.

## Done criteria (overall)

- [ ] `cd ~/human-engine && npm test` exits 0
- [ ] `node test/parity-matrix.mjs --check` exits 0, new rows covered
- [ ] `initiative.enabled` defaults to `false` in `lib/config.js` AND the manifest
- [ ] `grep -n "initiative" lib/config.js openclaw.plugin.json index.js` shows wiring
- [ ] `initiative` is in `NESTED_KEYS` and `agentProfiles` schema
- [ ] No files outside the Scope list are modified (`git status`)
- [ ] Version 0.5.0 in `package.json`, manifest, and CHANGELOG head
- [ ] `plans/README.md` status updated

## STOP conditions

Stop and report (do not improvise) if:

- A required runtime API (`subagent.run`, `llm.complete`, hooks) differs from
  the documented contract above.
- The change cannot be kept behind `initiative.enabled:false` without altering
  current behavior/parity.
- A gate rule cannot be made deterministic and unit-testable.
- Implementing delivery requires touching `proactive.js`/`dm-proactive.js`
  behavior (budget unification is a separate decision).
- Any real name/phone/JID would need to enter code, tests, fixtures, or docs.

## Decisions (confirmed with operator, 2026-09-10)

1. **Scopes**: **groups first** (`initiative.scopes = ["group"]`); DMs stay on
   the existing `dmProactive`.
2. **Relationship to existing funnels**: **coexist, share the outbound budget**
   — `initiative` and `proactive` consult one shared "last proactive outbound
   per scope" marker (Phase 3, required); `dmProactive` stays DM-only.
3. **Cadence baseline**: `everyMinutes: 60`, `maxActsPerDay: 2`,
   `minGapMinutes: 240` (4 h); per group/agent overridable via `agentProfiles`.
4. **Capture cost**: keyword trigger **plus** `capture.everyMessages: 20`
   (no always-on minute cadence in v1; `capture.everyMinutes: 0`).
5. **Delivery style**: **plugin-composed + `sanitizeTells`/`expandInlineLists`**
   in v1 (guaranteed formatting); in-session agent turns are a later option.
6. **Standing instructions**: **directives are in v1** (`directives.enabled:true`)
   — this is the "sich merkt" half.
7. **Operator surface**: v1 audits via `state/initiative.jsonl` + per-scope
   state files; a `/initiative` command (list/add/done) is a **follow-up**
   (reserved slot 614, not part of this plan).

## Alternatives considered and rejected

- **Use OpenClaw heartbeat for per-group proactivity**: heartbeat is one
  main-session turn per agent with an owner-DM route; it cannot express
  per-group cadence or per-group state. Rejected as the mechanism — reused only
  as the *design analogy* (interval + active hours + budget).
- **Use `api.runtime.state.openKeyedStore`**: refused for non-bundled/local
  plugins. Rejected; file-state pattern retained.
- **Put tasks into the schemaV2 person profile**: tasks are scope-level
  (events, group commitments), not per-person; mixing them would break the
  person-store semantics and caps. Rejected.
- **Live-first rollout**: violates the repo's shadow-first contract and the
  operator-gated activation used by every prior proactive feature. Rejected.

## Maintenance notes

- The tick and the reactive gate share anti-annoyance concepts but not code
  (yet); a future unification should extract `isActiveHour`/budget/cooldown into
  one shared module used by `proactive`, `dm-proactive`, and `initiative`.
- Extraction cost scales with scope count; keep `capture.everyMessages` sane and
  the in-flight guard per scope.
- Task text is model-generated: keep it capped, dedupe on normalized text, and
  never let it carry instructions verbatim into an LLM prompt without the
  untrusted wrapper.
- When plan 036 lands, the render path should call `expandInlineLists` too —
  otherwise long task lists regress to the horizontal-line bug.
- `state/` is gitignored; never commit state fixtures with real content.
