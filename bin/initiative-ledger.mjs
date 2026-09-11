#!/usr/bin/env node
/*
 * Plan 618: read-only operator/cron view over the durable initiative ledger
 * (plan 617, `state/initiative/<agentId>/<sessionKey>.json`). The followup-cron
 * uses this to ask "is this topic already open / recently attempted / paused?"
 * before it builds an envelope. It NEVER writes: no `save`, no file creation.
 *
 * Usage:
 *   node bin/initiative-ledger.mjs list [--agent <agentId>] [--session <sessionKey>]
 *        [--state-dir <dir>] [--now <epoch-ms>] [--json]
 *   node bin/initiative-ledger.mjs get --topic-key <tk-...> [--agent <agentId>]
 *        [--session <sessionKey>] [--state-dir <dir>] [--json]
 *
 * Output: `list` prints one JSON line per open task (or `[]` when empty; with
 * `--json` a single `{"tasks":[…]}` line). `get` prints the matching task or
 * `{"found":false}`. Exit codes: 0 success, 2 bad input, 3 usage error.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInitiativeStore } from "../lib/initiative-store.js";
import { parseAgentScope, agentIdFromSessionKey } from "../lib/scope.js";

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function usage() {
  return [
    "usage: node bin/initiative-ledger.mjs list [--agent <agentId>] [--session <sessionKey>]",
    "             [--state-dir <dir>] [--now <epoch-ms>] [--json]",
    "       node bin/initiative-ledger.mjs get --topic-key <tk-...> [--agent <agentId>]",
    "             [--session <sessionKey>] [--state-dir <dir>] [--json]",
  ].join("\n");
}

function fail(code, obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(code);
}

function taskRow(task, stateObj, scope, agentId) {
  const parsed = parseAgentScope(scope);
  return {
    scope,
    agentId: agentId || parsed?.agentId || stateObj?.agentId || null,
    topicKey: task.topicKey ?? null,
    text: task.text ?? "",
    status: task.status ?? null,
    attempts: task.attempts ?? 0,
    lastActAt: task.lastActAt ?? 0,
    cooldownUntil: stateObj?.cooldowns?.[task.id]?.until || 0,
    dueAt: task.dueAt ?? null,
    createdAt: task.createdAt ?? null,
  };
}

function main(argv) {
  const cmd = argv[0];
  if (cmd !== "list" && cmd !== "get") {
    process.stderr.write(usage() + "\n");
    process.exit(3);
  }

  const opts = { json: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      opts.json = true;
    } else if (a === "--agent" || a === "--session" || a === "--state-dir" || a === "--now" || a === "--topic-key") {
      opts[a.slice(2)] = argv[++i];
    } else {
      process.stderr.write(`unknown argument: ${a}\n` + usage() + "\n");
      process.exit(3);
    }
  }

  const stateDir = opts["state-dir"] || process.env.HUMAN_ENGINE_STATE_DIR || path.join(PLUGIN_ROOT, "state");
  // Accepted for interface parity with followup-gate; validated as bad input.
  if (opts.now !== undefined && !Number.isFinite(Number(opts.now))) fail(2, { error: "bad-now" });

  const agentId = opts.agent || null;
  const sessionKey = opts.session || null;
  const scope = sessionKey ? (agentId || agentIdFromSessionKey(sessionKey) || "?") + "::" + sessionKey : null;

  const store = createInitiativeStore({ stateDir });

  if (cmd === "list") {
    if (!scope && !agentId) {
      process.stderr.write(usage() + "\n");
      process.exit(3);
    }
    let rows;
    if (scope) {
      const st = store.load(scope);
      const tasks = (Array.isArray(st?.tasks) ? st.tasks : []).filter((t) => t.status === "open");
      rows = tasks.map((t) => taskRow(t, st, scope, agentId));
    } else {
      const open = store.listOpenTasksForAgent(agentId);
      const byScope = new Map();
      for (const st of store.listScopesForAgent(agentId)) {
        if (st && typeof st.scope === "string") byScope.set(st.scope, st);
      }
      rows = open.map((t) => taskRow(t, byScope.get(t.scope), t.scope, agentId));
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify({ tasks: rows }) + "\n");
    } else if (rows.length === 0) {
      process.stdout.write("[]\n");
    } else {
      for (const row of rows) process.stdout.write(JSON.stringify(row) + "\n");
    }
    process.exit(0);
  }

  // cmd === "get"
  const topicKey = opts["topic-key"];
  if (!topicKey) {
    process.stderr.write(usage() + "\n");
    process.exit(3);
  }

  let found = null;
  let foundScope = null;
  let foundState = null;
  if (scope) {
    const st = store.load(scope);
    const task = store.findByTopicKey(scope, topicKey);
    if (task) { found = task; foundScope = scope; foundState = st; }
  }
  if (!found && agentId) {
    for (const st of store.listScopesForAgent(agentId)) {
      const task = (Array.isArray(st?.tasks) ? st.tasks : []).find((t) => t.topicKey === topicKey);
      if (task) { found = task; foundScope = st.scope; foundState = st; break; }
    }
  }

  if (!found) {
    process.stdout.write(JSON.stringify({ found: false, topicKey }) + "\n");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ found: true, ...taskRow(found, foundState, foundScope, agentId) }) + "\n");
  process.exit(0);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`initiative-ledger: ${err?.message || err}\n`);
  process.exit(3);
}
