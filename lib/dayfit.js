import fs from "node:fs";
import path from "node:path";

/*
 * Plan 531 / design-dm-proactive-v2 §2.2 (DayFit): activity-aware timing
 * from ~/.openclaw/state/kevin-activity.json (Plan 521, read-only). The
 * file carries `{ lastKnownKevinActivityAtMs }`. If Kevin has been idle
 * too long, soft-tier followups are throttled or blocked entirely — no
 * ping into the void. Hard reminders (deadline/event) are DayFit-independent
 * and always run through the same gate (handled by the caller).
 *
 * Bands (mtime-cached, ≤ 60 s, fail-safe):
 *   age <  dayFitReduceHours   -> 1.0  (full — normal cap)
 *   age <  dayFitPauseHours    -> 0.5  (reduced — cap halved)
 *   age >= dayFitPauseHours    -> null (paused — soft-tier BLOCKED, dayfit-stale)
 *   signal > 36 h old          -> null (plausibility guard, dayfit-stale)
 *   file missing/unreadable    -> null (dayfit-unknown, warn-once)
 *
 * This module is read-only state input (never writes), so no shared mutable
 * state — separate from Plan 525's usage of the same 4/12 h thresholds.
 */

export const SIGNAL_MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const DEFAULT_ACTIVITY_PATH = path.join(
  process.env.HOME || "/home/openclaw",
  ".openclaw",
  "state",
  "kevin-activity.json",
);

let warnedOnce = false;
// Module-level cache so repeated gate calls (per candidate) reuse the ≤ 60 s
// read. Tests inject a fresh per-test `cache` to avoid cross-test pollution.
const defaultCache = { mtimeMs: 0, value: null };

export function resetDayFitWarn() {
  warnedOnce = false;
}

// Returns { value, reason } where value is 1.0 | 0.5 | null and reason is
// one of: "dayfit-full" | "dayfit-reduced" | "dayfit-stale" |
// "dayfit-unknown". Inject `now`, `filePath` and a fresh `cache` object in
// tests (the real plugin passes its own long-lived cache). mtime-cached
// ≤ 60 s so we never stat/read on every candidate.
export function dayFitFactor({
  now = Date.now(),
  filePath = DEFAULT_ACTIVITY_PATH,
  reduceHours = 4,
  pauseHours = 12,
  cache,
  log,
} = {}) {
  const _cache = cache || defaultCache;
  if (now - _cache.mtimeMs < 60000) {
    return _cache.value;
  }

  let raw = null;
  let stat = null;
  try {
    stat = fs.statSync(filePath);
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    _cache.mtimeMs = now;
    _cache.value = { value: null, reason: "dayfit-unknown" };
    if (!warnedOnce) {
      warnedOnce = true;
      (log && log.warn ? log : console).warn(
        `human-engine: dayfit: activity file missing/unreadable (${filePath}) — soft-tier blocked (dayfit-unknown)`,
      );
    }
    return _cache.value;
  }

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    _cache.mtimeMs = now;
    _cache.value = { value: null, reason: "dayfit-unknown" };
    if (!warnedOnce) {
      warnedOnce = true;
      (log && log.warn ? log : console).warn(
        `human-engine: dayfit: activity file malformed (${filePath}) — soft-tier blocked (dayfit-unknown)`,
      );
    }
    return _cache.value;
  }

  const signal =
    data && typeof data === "object" && typeof data.lastKnownKevinActivityAtMs === "number"
      ? data.lastKnownKevinActivityAtMs
      : null;

  // Age of the activity signal; fall back to file mtime if the signal field
  // is absent (tolerant read — the shape may grow, we only read the one field).
  const fileAge = Date.now() - (stat.mtimeMs || 0);
  const age = signal !== null && Number.isFinite(signal) && signal > 0 ? now - signal : fileAge;

  const reduceMs = reduceHours * 60 * 60 * 1000;
  const pauseMs = pauseHours * 60 * 60 * 1000;

  _cache.mtimeMs = now;

  const result = (() => {
    if (age < 0) return { value: 1.0, reason: "dayfit-full" }; // clock skew → full
    if (age < reduceMs) return { value: 1.0, reason: "dayfit-full" };
    if (age < pauseMs) return { value: 0.5, reason: "dayfit-reduced" };
    return { value: null, reason: "dayfit-stale" };
  })();

  _cache.value = result;
  return result;
}
