# Plan 614: `/initiative` command — inspect and manage tasks & directives

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. Commit in the worktree. Skip the
> `plans/README.md` status update — your reviewer maintains the index.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (read/write of the plugin's own state; no live sends)
- **Depends on**: plan 613 (Initiative engine; branch is already in the worktree)
- **Category**: feature / dx
- **Planned at**: commit `d5e8490` (branch `advisor/613-initiative-engine`), 2026-09-10

## Why this matters

Plan 613's decision 7 deferred the operator surface: v1 audits tasks only via
`state/initiative.jsonl` + per-scope JSON files. That is invisible to the
operator in chat. This plan adds a `/initiative` plugin command so a user can
list, add, complete, or drop the agent's tasks and standing instructions in the
current conversation — the missing manual control and visibility.

## Current state (facts the executor needs)

- Command registration: `index.js` uses `api.registerCommand({ name: "soul", … })`
  near the end of `register()`. Command handlers get
  `ctx = { agentId?, sessionKey?, sessionId?, args?, channel, … }`
  (`PluginCommandContext`, OpenClaw 2026.9.3 `plugin-entry-C_DISS2h.d.ts:19900`).
  `ctx.sessionKey` is the stable host session key for the active conversation
  "when available"; `ctx.args` is the raw argument string.
- `createInitiative({ cfg, stateDir, log, llm, runtime, state, threads, outbox, now, rng })`
  (from plan 613) returns `{ onMessageReceived, onBeforePromptBuild, contextFor, tick, stop, __store }`.
  The durable store is `createInitiativeStore({ stateDir, log })` with
  `getOrInit(scope, agentId)`, `save(scope, stateObj)`, `load(scope)`,
  `scopeToPath`, `__stateForTests()`.
- Scope composite key format: `<agentId>::<sessionKey>` (parse via
  `parseAgentScope` from `lib/scope.js`).
- State shape: `{ version, scope, agentId, tasks:[{id,kind,text,people,createdAt,dueAt,status,source,attempts,lastActAt,lastActKind,ignoreStreak,doneAt}], directives:[{id,text,createdAt}], … }`.
- Command tests assert exact command sets and WILL need updating (in scope):
  - `test/register.test.js` asserts `commands.length === 1` and
    `commands[0].name === "soul"` (multiple occurrences).
  - `test/harness.test.js` `"no-residue static proof"` asserts
    `assert.deepEqual(commands, ["soul"])`.

## Scope

**In scope (modify ONLY these):**
- `lib/initiative.js` — add command-facing helpers to the returned instance
- `lib/initiative-store.js` — add `listScopesForAgent(agentId)`
- `index.js` — register the `initiative` command (AFTER the `soul` command)
- `test/initiative-command.test.js` (new) — command handler tests
- `test/register.test.js`, `test/harness.test.js` — command count/snapshot
- `wiki/quickstart.md`, `wiki/operations/environment.md` — document the command

**Out of scope:** changing capture/tick/gate behavior; any live config flip; parity
rows (covered by existing 83–87); any real names/numbers/JIDs.

## Steps

### Step 1: store helper `listScopesForAgent(agentId)`

In `lib/initiative-store.js`, add `listScopesForAgent(agentId)` that reads
`stateDir/initiative/<pathSafe(agentId)>/*.json`, parses each, and returns the
array of parsed states that carry a `scope` (fail-safe: ignore bad files).
Expose it on the returned store object.

### Step 2: command helpers on the initiative instance (`lib/initiative.js`)

Add to the object returned by `createInitiative` (keep existing exports):
- `adminList(sk, agentId)` → `{ scope, tasks, directives }` for one scope, or
  `{ scopes: [ {scope, tasks, directives}, … ] }` when `sk` is null (agent-wide).
- `adminAddTask(sk, agentId, text)` → normalize (trim/collapse, ≤160), require a
  non-empty text and a scope; dedupe against open tasks by lowercased text; push
  `{ id: taskId(key, now), kind:"task", text, people:[], createdAt: now,
  dueAt:null, status:"open", source:{speaker:"manual",excerpt:"",messageTs:now},
  attempts:0, lastActAt:0, lastActKind:null, ignoreStreak:0, doneAt:0 }`; save.
  Return the new task (or the existing one on duplicate).
- `adminSetTaskStatus(sk, agentId, ref, status)` → resolve `ref` against the
  scope's OPEN tasks as either a 1-based index (from the listed order) or a
  short-id prefix (first 8+ chars); set `status` (`done`|`expired`) + `doneAt`;
  save. Return `{ ok, task }` or `{ ok:false, reason }`.
- `adminAddDirective(sk, agentId, text)` → dedupe + cap `directives.maxPerScope`;
  save.
All helpers must be gated only by scope resolvability (work even when
`initiative.enabled === false`, since it is a manual operator surface), must not
throw, and must use `parseAgentScope` (never hand-split).

### Step 3: register the command (`index.js`)

After the existing `api.registerCommand({ name: "soul", … })`, add:

```js
api.registerCommand({
  name: "initiative",
  description: "Inspect or manage your open tasks and standing instructions.",
  acceptsArgs: true,
  handler: async (ctx) => { /* see Step 3a */ },
});
```

**Step 3a — handler behavior** (return `{ text }`; never throw):
- `agentId = ctx?.agentId`; if absent → `"/initiative requires an agent context."`.
- `sk = ctx?.sessionKey || null`.
- `args = String(ctx?.args || "").trim()`; `[sub, ...rest] = args.split(/\s+/)`.
- `list` or empty → `adminList(sk, agentId)`; render:
  - one scope: `Offene Tasks:\n- [<id8>] <text> (seit <Nd>)\nStanding Instructions:\n- <text>`
  - agent-wide: group by scope (label the scope with its kind/channel tail, not the raw JID — e.g. `…group:…`), same item format.
  - empty → `"Keine offenen Tasks."`
- `add <text>` → require `sk` (else `"Nutze /initiative add <text> in einem Chat (kein Session-Kontext)."`); call `adminAddTask`; confirm `"Notiert: <text> [<id8>]"` or `"Steht schon auf der Liste: <text> [<id8>]"`.
- `done <ref>` / `forget <ref>` → require `sk`; call `adminSetTaskStatus(sk, agentId, ref, "done"|"expired")`; confirm or `"Nicht gefunden: <ref>. Nutze /initiative list."`.
- `directives` → list directives of the scope (or agent-wide).
- `directive <text>` → require `sk`; `adminAddDirective`; confirm.
- `help` or unknown sub → a one-block usage text listing the subcommands.
- Bound every rendered reply (e.g. ≤ 1500 chars; append `…` if truncated). No markdown tables.

### Step 4: tests

- `test/initiative-command.test.js` (new): import `createInitiative`, extract the
  command handler by capturing `registerCommand` defs from a fake api (mirror
  `test/register.test.js`), or test the `admin*` helpers directly plus a
  handler-level test. Cover: add (in a session scope), list, duplicate add,
  done by index, done by id-prefix, forget, directive add/list, agent-wide list
  when no sessionKey, and the no-agent-context error. Use a temp state dir; no
  network.
- `test/register.test.js`: update the command assertions (`commands.length` 1→2;
  keep `commands[0].name === "soul"` since `initiative` is registered after).
- `test/harness.test.js`: update the `commands` snapshot to
  `["initiative", "soul"]` (sorted).

### Step 5: docs

- `wiki/quickstart.md`: add `/initiative` to the notes/commands mention.
- `wiki/operations/environment.md`: document the subcommands + that it works
  even with the engine disabled (manual surface).

### Step 6: full gate + commit

- `npm test` → 0 fail; `node test/parity-matrix.mjs --check` → 87/87, exit 0.
- Commit: `feat(initiative): /initiative command (plan 614)`.

## Done criteria

- [ ] `npm test` exits 0; parity 87/87
- [ ] `grep -n 'name: "initiative"' index.js` shows the command
- [ ] command handler returns a helpful text for list/add/done/forget/directive/help and the no-agent error
- [ ] `test/initiative-command.test.js` exists and passes
- [ ] `git status` shows only in-scope files (+ node_modules symlink)

## STOP conditions

- `ctx.sessionKey`/`ctx.agentId` are not available on the command context in this host (verify against `PluginCommandContext`); report instead of inventing a scope.
- A test outside the in-scope list must change to pass.
- Any real name/phone/JID would need to enter code, tests, or docs.
