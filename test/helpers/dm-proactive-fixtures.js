import fs from "node:fs";
import path from "node:path";

/*
 * Plan 534 (AP e) consolidation — shared dm-proactive fixtures + log helpers.
 *
 * (a) One `readLog()` used everywhere the shadow log is inspected (was
 *     duplicated inline in every test).
 * (b) One entry-shape validator for the v2 shadow-log shape — the v2 fields
 *     are a SUPERSET of the legacy 532 fields (candidate/gate/render/
 *     suggestedText/sent stay, v2 adds day/candidateId/kind/scope/source/
 *     gateVerdicts/gatePassed/outcome/envelope/renderPreview|render). Central
 *     so a single test asserts the superset contract instead of re-asserting
 *     fragments in many places.
 * (c) Retention constants + the Berlin day-key cutoff logic are sourced from
 *     here (shared with the retention/prune tests).
 *
 * Fixtures use ONLY fake session keys (public repo — AGENTS.md rule).
 */

export const SK = "agent:hori-wa:telegram:direct:999999999"; // fake session key
export const SCOPE = "hori-wa::" + SK;

// Mirrors lib/dm-proactive.js LOG_RETENTION_DAYS (Plan 533 AP d). Kept in sync
// by the parity/consolidation suite — a single source for both the lib test
// and any consumer that needs the retention window.
export const LOG_RETENTION_DAYS = 14;

export function readLog(stateDir) {
  try {
    return fs
      .readFileSync(path.join(stateDir, "dm-proactive.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// Asserts the v2 entry-shape superset contract on `e` (Plan 533 AP d). All
// legacy fields are required to remain; the v2 fields must be present.
export function assertV2EntryShape(assert, e) {
  assert.equal(typeof e.ts, "number");
  assert.equal(typeof e.day, "string");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(e.day), "day must be yyyy-mm-dd");
  assert.equal(typeof e.candidateId, "string");
  assert.equal(typeof e.kind, "string");
  assert.equal(typeof e.scope, "string");
  assert.equal(typeof e.source, "string");
  assert.ok(e.gateVerdicts && typeof e.gateVerdicts === "object");
  assert.equal(typeof e.gatePassed, "boolean");
  assert.ok(e.gate && typeof e.gate === "object");
  assert.deepEqual(e.outcome, { repliedWithin48h: null });
  assert.ok(e.envelope && typeof e.envelope === "object");
  assert.equal(typeof e.suggestedText, "string");
  assert.equal(typeof e.sent, "boolean");
  // legacy fields remain (superset contract — 527 rollup keeps consuming them)
  assert.ok(e.candidate && typeof e.candidate === "object");
  assert.ok(e.render && typeof e.render === "object");
  assert.equal(typeof e.agentId, "string");
  assert.equal(typeof e.sessionKey, "string");
}
