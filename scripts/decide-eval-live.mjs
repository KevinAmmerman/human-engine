#!/usr/bin/env node

/**
 * decide-eval-live.mjs — Manual live-model evaluation for decide scenarios.
 *
 * Usage:
 *   node scripts/decide-eval-live.mjs [--help] [--model <model>]
 *
 * This script loads ./test/fixtures/decide-scenarios.json and runs each
 * scenario against a REAL LLM via the configured engine (NOT stubbed).
 * It prints per-scenario accuracy + confusion notes.
 *
 * Requires: api.runtime.llm (the host's built-in LLM client) — no
 * live-gateway config needed. If the host LLM is unavailable, run:
 *   node scripts/decide-eval-live.mjs --help
 * to see the fallback command for using a local model directly.
 *
 * This script is MANUAL and NOT included in `npm test`.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalEngine, getState } from "../lib/local-engine.js";
import * as timing from "../lib/timing-engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`
decide-eval-live.mjs — Manual live-model decide evaluation

Usage:
  node scripts/decide-eval-live.mjs [--help] [--model <model>]

Options:
  --help           Print this usage message and exit
  --model <model>  Override the default LLM model (default: uses host LLM)

Description:
  Loads decide scenarios from test/fixtures/decide-scenarios.json and runs
  each against a REAL LLM via the host's built-in llm.complete. Results are
  printed as a table with per-scenario accuracy.

  No gateway config is needed — the script uses the same llm.complete that
  the plugin uses at runtime.

Example:
  node scripts/decide-eval-live.mjs

Fallback (if host LLM is unavailable):
  Install a local model via ollama and run:
    # Set OPENCLAW_LLM_ENDPOINT or use the host's LLM config
    node scripts/decide-eval-live.mjs
`);
}

if (process.argv.includes("--help")) {
  usage();
  process.exit(0);
}

const scenariosPath = resolve(__dirname, "..", "test", "fixtures", "decide-scenarios.json");
if (!existsSync(scenariosPath)) {
  console.error("FATAL: scenarios file not found at", scenariosPath);
  process.exit(1);
}

const raw = readFileSync(scenariosPath, "utf8");
const { scenarios } = JSON.parse(raw);

if (!scenarios || scenarios.length === 0) {
  console.error("FATAL: no scenarios loaded");
  process.exit(1);
}

async function main() {
  const llm = await tryGetLLM();
  if (!llm) {
    console.warn("WARN: no host LLM available — running with stubs for structure check only.\n");
  }

  const engine = createLocalEngine({
    cfg: { decide: { temperature: 0.2 } },
    llm,
    timing,
    log: { info() {}, warn() {}, debug() {}, error() {} },
  });

  let correct = 0;
  let total = 0;
  const results = [];

  for (const sc of scenarios) {
    getState().epochs.clear();

    const transcript = (sc.transcript || []).map(([speaker, text]) => ({ speaker, text }));
    const messages = (sc.messages || []).map((m) => ({
      text: m.text || "",
      content: m.text || "",
      hasMedia: m.hasMedia || false,
    }));

    try {
      const result = await engine.decide({
        sessionKey: `live-eval-${total}`,
        isDM: sc.isDM,
        hasMedia: sc.hasMedia,
        prompt: sc.prompt || (sc.transcript || []).map(([, t]) => t).join(" "),
        agentName: sc.agentName || "OpenClaw",
        messages,
        transcript,
        persona: null,
        voiceCard: null,
      });

      const decision = result?.decision || "null";
      const expected = sc.expect;
      const pass = decision === expected;
      if (pass) correct++;

      results.push({
        name: sc.name,
        expected,
        got: decision,
        pass,
        rationale: sc.rationale,
      });
    } catch (err) {
      results.push({
        name: sc.name,
        expected: sc.expect,
        got: `ERROR: ${err.message}`,
        pass: false,
        rationale: sc.rationale,
      });
    }
    total++;
  }

  console.log(`\nDecide live eval: ${correct}/${total} correct (${(correct / total * 100).toFixed(1)}%)\n`);

  const table = results.map((r) => {
    const mark = r.pass ? "✓" : "✗";
    return `${mark} ${r.name.padEnd(40)} expect=${r.expected.padEnd(12)} got=${(r.got + "").padEnd(12)} — ${r.rationale}`;
  });

  console.log(table.join("\n"));
  console.log();

  if (correct < total) {
    const failures = results.filter((r) => !r.pass);
    console.log("Confusion notes:");
    for (const f of failures) {
      console.log(`  • ${f.name}: expected ${f.expected}, got ${f.got}`);
    }
    console.log();
    process.exit(correct === total ? 0 : 2);
  }

  process.exit(0);
}

async function tryGetLLM() {
  try {
    const { default: openclaw } = await import("openclaw");
    if (openclaw?.runtime?.llm?.complete) {
      return openclaw.runtime.llm;
    }
  } catch {}
  return null;
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
