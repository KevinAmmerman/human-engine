#!/usr/bin/env node
/*
 * Plan 530 / design-dm-proactive-v2 §2.1 (layer 1, "defense in depth"):
 * pre-send gate check for the followup-cron. Imports the SAME gate-core
 * library as the plugin hook (lib/dm-gate-core.js) so the cron-side
 * convention and the authoritative message_sending hook can never drift.
 *
 * Usage:
 *   node bin/followup-gate.mjs check [--file <env.json>|-] [--config <cfg.json>]
 *        [--state <state.json>] [--session <sessionKey>] [--agent <agentId>]
 *        [--now <epoch-ms>]
 *
 * Input: the candidate message (envelope first line + draft) via --file or
 * STDIN. Output: single-line verdict JSON on stdout.
 * Exit codes: 0 = pass, 1 = block, 2 = invalid/no envelope, 3 = usage error.
 *
 * Limitations (documented, by design): the CLI has no transcript context —
 * double-text is only enforceable in the plugin hook (layer 2).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFollowupEnvelope, evaluateDmGate, candidateFromEnvelope } from "../lib/dm-gate-core.js";
import { resolveConfig, isScopedDmAgent, resolveAgentConfig } from "../lib/config.js";
import { parseAgentScope } from "../lib/scope.js";
import { createInitiativeStore } from "../lib/initiative-store.js";

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function usage() {
  return [
    "usage: node bin/followup-gate.mjs check [--file <env.json>|-] [--config <cfg.json>]",
    "             [--state <state.json>] [--session <sessionKey>] [--agent <agentId>]",
    "             [--now <epoch-ms>]",
  ].join("\n");
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Accepts either a full openclaw.json (plugins.entries["human-engine"].config)
// or a bare plugin-config object.
function pluginConfigFrom(parsed) {
  if (!parsed || typeof parsed !== "object") return {};
  const nested = parsed?.plugins?.entries?.["human-engine"]?.config;
  return nested && typeof nested === "object" ? nested : parsed;
}

function emit(obj, exitCode) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(exitCode);
}

// Plan 618: read-only ledger lookup. Returns the matching task plus its owning
// state object (needed for `stateObj.cooldowns[task.id].until`), or null. The
// scope's own file is checked first, then every scope file for the agent.
function findLedgerRecord(store, { agentId, scope, topicKey }) {
  if (!topicKey) return null;
  const states = [];
  if (scope) {
    const st = store.load(scope);
    if (st) states.push(st);
  }
  if (agentId) {
    for (const st of store.listScopesForAgent(agentId)) states.push(st);
  }
  for (const st of states) {
    const task = (Array.isArray(st?.tasks) ? st.tasks : []).find((t) => t.topicKey === topicKey);
    if (task) return { task, stateObj: st };
  }
  return null;
}

// Plan 618: topic-level gate verdicts from the durable initiative ledger. All
// three fail-open (verdict true) when no ledger entry exists; the whole block
// is skipped when the envelope carries no `topicKey` (inert until plan 635).
function evaluateTopicGates(record, { now, dcfg }) {
  const verdicts = {};
  const reasons = [];
  const check = (name, pass) => {
    verdicts[name] = pass === true;
    if (verdicts[name] === false) reasons.push(name);
  };
  if (!record) {
    check("topic-cooldown", true);
    check("topic-attempts", true);
    check("topic-open", true);
    return { verdicts, reasons };
  }
  const { task, stateObj } = record;
  const cooldownUntil = stateObj?.cooldowns?.[task.id]?.until || 0;
  check("topic-cooldown", !(cooldownUntil > now));
  check("topic-attempts", !((task.attempts || 0) >= (dcfg.topicMaxAttempts ?? 3)));
  const openCdMs = (dcfg.openAttemptCooldownMinutes ?? 180) * 60000;
  const pendingOpen = task.status === "open" && task.lastActAt > 0 && now - task.lastActAt < openCdMs;
  check("topic-open", !pendingOpen);
  return { verdicts, reasons };
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd !== "check") {
    process.stderr.write(usage() + "\n");
    process.exit(3);
  }
  const opts = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" || a === "--config" || a === "--state" || a === "--session" || a === "--agent" || a === "--now") {
      opts[a.slice(2)] = argv[++i];
    } else {
      process.stderr.write(`unknown argument: ${a}\n` + usage() + "\n");
      process.exit(3);
    }
  }

  let content;
  if (opts.file && opts.file !== "-") {
    try {
      content = fs.readFileSync(opts.file, "utf8");
    } catch (err) {
      emit({ valid: false, error: "file-unreadable", detail: String(err?.message || err), pass: false, reasons: ["file-unreadable"], verdicts: {} }, 3);
    }
  } else {
    content = await readStdin();
  }

  const parsed = parseFollowupEnvelope(content);
  if (parsed === null) {
    emit({ valid: false, error: "no-envelope", pass: false, reasons: ["no-envelope"], verdicts: {}, note: "not a followup candidate — nothing to gate" }, 2);
  }
  if (!parsed.ok) {
    emit({ valid: false, error: parsed.error, pass: false, reasons: ["invalid-envelope:" + parsed.error], verdicts: {} }, 2);
  }

  const cfg = resolveConfig({ pluginConfig: pluginConfigFrom(readJson(opts.config || path.join(os.homedir(), ".openclaw", "openclaw.json"))) });
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const stateDir = process.env.HUMAN_ENGINE_STATE_DIR || path.join(PLUGIN_ROOT, "state");
  const stateFile = opts.state || path.join(stateDir, "dm-proactive-state.json");
  const state = readJson(stateFile) || {};

  const sessionKey = opts.session || null;
  const agentId = opts.agent || null;

  // Plan 005: the CLI decides only pre-send — never delivers anything raw.
  // If the agent is not in the DM-proactive allowlist, block (agent-not-scoped).
  if (agentId && !isScopedDmAgent(cfg, agentId)) {
    emit({
      valid: true,
      pass: false,
      reasons: ["agent-not-scoped"],
      verdicts: {},
      candidate: null,
      scope: null,
      reason: "agent-not-scoped",
    }, 1);
  }

  const scope = sessionKey ? (agentId || "?") + "::" + sessionKey : null;
  // Plan 017: budget is per-agent (v4 shape `agents.<agentId>.budget[scope]`).
  // The CLI only READS the counter — resolve the agent's own bucket first, then
  // fall back to the pre-tenancy flat `scopes` map (read-only, no behavior
  // change). The scope's composite carries the agentId (`agentId::sessionKey`),
  // so a caller that passes only --session still resolves the right bucket.
  let counter = null;
  if (scope) {
    const parsedScope = parseAgentScope(scope);
    const bucketAgentId = agentId || parsedScope?.agentId || "?";
    const ownBucket = state?.agents?.[bucketAgentId]?.budget?.[scope];
    if (ownBucket !== undefined) counter = ownBucket;
    else if (state?.scopes?.[scope] !== undefined) counter = state.scopes[scope];
  }
  // Plan 005: read the sentIds pool per agent — the agent's own bucket first,
  // then the migrated `__legacy__` bucket (transition dedup stays effective).
  // Plan 618: the plugin writes v4 `state.agents.<agentId>.sentIds[]` (see
  // lib/dm-proactive.js); read that first, then keep the pre-v3 flat fallback.
  const SENT_IDS_MAX = 512;
  const LEGACY_BUCKET = "__legacy__";
  function bucketList(bucketObj, name) {
    const b = bucketObj?.[name];
    return Array.isArray(b) ? b.slice(0, SENT_IDS_MAX) : [];
  }
  function bucketListV4(state, agentId) {
    const v4 = state?.agents?.[agentId] && state?.agents?.[agentId].sentIds;
    if (Array.isArray(v4)) return v4.slice(0, SENT_IDS_MAX);
    return bucketList(state?.sentIds, agentId); // legacy flat fallback
  }
  const agentSent = bucketListV4(state, agentId || LEGACY_BUCKET);
  const legacySent = bucketList(state?.sentIds, LEGACY_BUCKET);
  const duplicate = agentSent.includes(parsed.envelope.id) || legacySent.includes(parsed.envelope.id);

  const candidate = candidateFromEnvelope(parsed.envelope, parsed.draftText, sessionKey, agentId);
  const gate = evaluateDmGate(candidate, {
    dcfg: cfg?.dmProactive || {},
    now,
    counter,
    agentName: resolveAgentConfig(cfg, agentId).agentName || "Agent",
    newestSpeaker: null, // no transcript context in the CLI — hook-only check
    duplicate,
  });

  // Plan 618: optional ledger pre-check. Only runs when the envelope carries a
  // `topicKey` (plan 635 producer); otherwise these verdicts stay absent and
  // behavior is unchanged. Read-only — the store is never saved here.
  const topicKey = typeof parsed.envelope.topicKey === "string" && parsed.envelope.topicKey ? parsed.envelope.topicKey : null;
  if (topicKey) {
    const store = createInitiativeStore({ stateDir });
    const record = findLedgerRecord(store, { agentId, scope, topicKey });
    const topic = evaluateTopicGates(record, { now, dcfg: cfg?.dmProactive || {} });
    Object.assign(gate.verdicts, topic.verdicts);
    gate.reasons.push(...topic.reasons);
    if (topic.reasons.length > 0) gate.pass = false;
  }

  emit({
    valid: true,
    pass: gate.pass,
    reasons: gate.reasons,
    verdicts: gate.verdicts,
    candidate: {
      id: parsed.envelope.id,
      kind: parsed.envelope.kind,
      sensitivity: parsed.envelope.sensitivity,
      confidence: parsed.envelope.confidence,
      dueWindow: parsed.envelope.dueWindow,
      source: parsed.envelope.source,
    },
    scope,
    limitations: ["double-text is only enforceable in the plugin hook (no transcript context in the CLI)"],
  }, gate.pass ? 0 : 1);
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`followup-gate: ${err?.message || err}\n`);
  process.exit(3);
});
