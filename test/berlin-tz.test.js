import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localDayKey, isQuietHour } from "../lib/proactive.js";
import { defaultConfig } from "../lib/config.js";

// Plan 531 §2.2 TZ-Pflichtarbeit: the host runs on UTC, but quiet-hours and
// the day boundary must be evaluated in Europe/Berlin. These tests fix the
// Berlin values with explicit Intl timeZone — they are HOST-TZ-INDEPENDENT
// (no process.env.TZ mutation). 23:00 Berlin = 21:00 UTC (summer, UTC+2).

const H = 60 * 60 * 1000;

// A fixed UTC instant that is 22:30 Berlin (summer) = 20:30 UTC.
const BERLIN_2230_UTC = new Date("2026-08-04T20:30:00Z").getTime();

describe("Europe/Berlin timezone handling (Plan 531 TZ fix)", () => {
  it("22:30 Berlin (20:30 UTC, summer) is NOT quiet — before 23:00 start", () => {
    // 20:30 UTC = 22:30 Berlin (UTC+2 summer) — 22:30 < 23:00 so NOT quiet.
    assert.equal(isQuietHour(BERLIN_2230_UTC, "23:00", "07:00"), false, "22:30 Berlin is before quiet start");
  });

  it("isQuietHour true around 01:00 Berlin (23:00 UTC prev day, summer)", () => {
    // 23:00 UTC (summer) = 01:00 Berlin next day — inside quiet window.
    const ts = new Date("2026-08-04T23:00:00Z").getTime();
    assert.equal(isQuietHour(ts, "23:00", "07:00"), true, "01:00 Berlin is inside 23:00-07:00");
  });

  it("host-UTC demonstration: 21:00 UTC = 23:00 Berlin is quiet; 20:00 UTC = 22:00 Berlin is not", () => {
    // 21:00 UTC (summer) = 23:00 Berlin → quiet start inclusive
    assert.equal(isQuietHour(new Date("2026-08-04T21:00:00Z").getTime(), "23:00", "07:00"), true);
    // 20:00 UTC (summer) = 22:00 Berlin → before quiet
    assert.equal(isQuietHour(new Date("2026-08-04T20:00:00Z").getTime(), "23:00", "07:00"), false);
  });

  it("localDayKey rolls over at 00:00 Berlin, not 00:00 UTC", () => {
    // 22:00 UTC (summer) = 00:00 Berlin (Aug 5) — the day in Berlin is Aug 5.
    const beforeMidnight = new Date("2026-08-04T21:59:00Z").getTime(); // 23:59 Berlin Aug 4
    const atMidnight = new Date("2026-08-04T22:00:00Z").getTime(); // 00:00 Berlin Aug 5
    assert.equal(localDayKey(beforeMidnight), "2026-08-04");
    assert.equal(localDayKey(atMidnight), "2026-08-05", "day must roll at 00:00 Berlin, not 00:00 UTC");
  });

  it("23:00 UTC (01:00 Berlin) and 22:30 UTC (00:30 Berlin) both map to the Berlin day", () => {
    // 22:30 UTC (summer) = 00:30 Berlin Aug 5
    assert.equal(localDayKey(new Date("2026-08-04T22:30:00Z").getTime()), "2026-08-05");
    // 23:00 UTC = 01:00 Berlin Aug 5
    assert.equal(localDayKey(new Date("2026-08-04T23:00:00Z").getTime()), "2026-08-05");
  });

  it("localDayKey remains stable across a day (same Berlin date, different UTC)", () => {
    // 09:00 UTC (summer) = 11:00 Berlin Aug 4; 18:00 UTC = 20:00 Berlin Aug 4
    assert.equal(localDayKey(new Date("2026-08-04T09:00:00Z").getTime()), "2026-08-04");
    assert.equal(localDayKey(new Date("2026-08-04T18:00:00Z").getTime()), "2026-08-04");
  });
});

describe("schema/config sync (Plan 531)", () => {
  it("config.js dmProactive defaults match openclaw.plugin.json schema properties", () => {
    const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const schema = JSON.parse(fs.readFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "utf8"));
    const props = schema.configSchema.properties.dmProactive.properties;
    const cfg = defaultConfig().dmProactive;

    const schemaKeys = Object.keys(props).sort();
    const cfgKeys = Object.keys(cfg).sort();
    assert.deepEqual(cfgKeys, schemaKeys, "config.js defaults and plugin.json schema must define the same keys");

    for (const key of cfgKeys) {
      assert.equal(props[key].default, cfg[key], `default mismatch for dmProactive.${key}`);
    }
  });

  it("new DayFit fields present in both config.js and plugin.json", () => {
    const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const schema = JSON.parse(fs.readFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "utf8"));
    const props = schema.configSchema.properties.dmProactive.properties;
    assert.equal(defaultConfig().dmProactive.dayFitReduceHours, 4);
    assert.equal(defaultConfig().dmProactive.dayFitPauseHours, 12);
    assert.equal(props.dayFitReduceHours.default, 4);
    assert.equal(props.dayFitPauseHours.default, 12);
  });
});
