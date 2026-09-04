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
import { resolveConfig } from "../lib/config.js";

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
  const scope = sessionKey ? (agentId || "?") + "::" + sessionKey : null;
  const counter = scope && state?.scopes?.[scope] ? state.scopes[scope] : null;
  const sentIds = Array.isArray(state?.sentIds) ? state.sentIds : [];

  const candidate = candidateFromEnvelope(parsed.envelope, parsed.draftText, sessionKey, agentId);
  const gate = evaluateDmGate(candidate, {
    dcfg: cfg?.dmProactive || {},
    now,
    counter,
    agentName: cfg?.agentName || null,
    newestSpeaker: null, // no transcript context in the CLI — hook-only check
    duplicate: sentIds.includes(parsed.envelope.id),
  });

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
