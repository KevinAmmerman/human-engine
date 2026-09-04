import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dayFitFactor, resetDayFitWarn } from "../lib/dayfit.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dayfit-test-"));
const H = 60 * 60 * 1000;

function makeFile(activityAtMs) {
  const p = path.join(tmp, "kevin-activity.json");
  fs.writeFileSync(p, JSON.stringify({ lastKnownKevinActivityAtMs: activityAtMs }));
  return p;
}

function freshCache() {
  return { mtimeMs: 0, value: null };
}

describe("dayfit bands (Plan 531 §2.2)", () => {
  beforeEach(() => {
    resetDayFitWarn();
    for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { force: true });
  });

  it("age 1h (< reduceHours) -> full 1.0", () => {
    const p = makeFile(Date.now() - 1 * H);
    const r = dayFitFactor({ now: Date.now(), filePath: p, cache: freshCache() });
    assert.equal(r.value, 1.0);
    assert.equal(r.reason, "dayfit-full");
  });

  it("age 6h (4-12h band) -> reduced 0.5", () => {
    const p = makeFile(Date.now() - 6 * H);
    const r = dayFitFactor({ now: Date.now(), filePath: p, cache: freshCache() });
    assert.equal(r.value, 0.5);
    assert.equal(r.reason, "dayfit-reduced");
  });

  it("age 20h (>= pauseHours) -> paused null (dayfit-stale)", () => {
    const p = makeFile(Date.now() - 20 * H);
    const r = dayFitFactor({ now: Date.now(), filePath: p, cache: freshCache() });
    assert.equal(r.value, null);
    assert.equal(r.reason, "dayfit-stale");
  });

  it("missing file -> unknown null + warn-once", () => {
    const logs = [];
    const log = { warn: (m) => logs.push(m) };
    const missing = path.join(tmp, "does-not-exist.json");
    const r1 = dayFitFactor({ now: Date.now(), filePath: missing, cache: freshCache(), log });
    assert.equal(r1.value, null);
    assert.equal(r1.reason, "dayfit-unknown");
    assert.equal(logs.length, 1, "must warn on first miss");
    // warn-once: second call with a different cache must NOT warn again
    const r2 = dayFitFactor({ now: Date.now(), filePath: missing, cache: freshCache(), log });
    assert.equal(r2.value, null);
    assert.equal(logs.length, 1, "warn-once must suppress repeated warnings");
  });

  it("signal older than 36h -> stale (dayfit-stale), not reduced/full", () => {
    const p = makeFile(Date.now() - 40 * H);
    const r = dayFitFactor({ now: Date.now(), filePath: p, cache: freshCache() });
    assert.equal(r.value, null);
    assert.equal(r.reason, "dayfit-stale");
  });

  it("mtime cache serves repeated calls within 60s", () => {
    const p = makeFile(Date.now() - 6 * H);
    const cache = freshCache();
    const r1 = dayFitFactor({ now: Date.now(), filePath: p, cache });
    const r2 = dayFitFactor({ now: Date.now() + 1000, filePath: p, cache });
    assert.equal(r1.value, 0.5);
    assert.equal(r2.value, 0.5, "cached value must be reused");
  });

  it("config thresholds are honored (custom reduce/pause)", () => {
    const p = makeFile(Date.now() - 3 * H);
    const r = dayFitFactor({ now: Date.now(), filePath: p, cache: freshCache(), reduceHours: 2, pauseHours: 4 });
    assert.equal(r.value, 0.5);
    assert.equal(r.reason, "dayfit-reduced");
  });
});
