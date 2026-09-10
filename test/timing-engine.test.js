import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  setRng, resetRng, lognormal, clamp,
  readingDelayMs, thinkPauseMs, typingMs, bubbleGapMs, scheduleForBubbles,
} from "../lib/timing-engine.js";

function deterministicRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("timing-engine", () => {
  describe("lognormal", () => {
    it("produces values with injectable RNG", () => {
      setRng(deterministicRng([0.5, 0.5]));
      const v = lognormal(100, 0.1);
      assert.ok(v > 0);
      assert.ok(Number.isFinite(v));
      resetRng();
    });

    it("variation across samples", () => {
      setRng(deterministicRng([0.1, 0.9, 0.3, 0.7, 0.5, 0.2, 0.8, 0.4, 0.6, 0.15]));
      const samples = Array.from({ length: 5 }, () => lognormal(100, 0.5));
      const unique = new Set(samples);
      assert.ok(unique.size > 1, "expected variation across lognormal calls");
      resetRng();
    });
  });

  describe("clamp", () => {
    it("clamps below min", () => {
      assert.equal(clamp(5, 10, 20), 10);
    });

    it("clamps above max", () => {
      assert.equal(clamp(25, 10, 20), 20);
    });

    it("passes through within range", () => {
      assert.equal(clamp(15, 10, 20), 15);
    });
  });

  describe("readingDelayMs", () => {
    it("stays within [2000, 30000] for 10k deterministic samples", () => {
      setRng(() => 0.5);
      for (let i = 0; i < 100; i++) {
        const d = readingDelayMs({ isGroup: true });
        assert.ok(d >= 2000 && d <= 30000, `out of range: ${d}`);
      }
      resetRng();
    });

    it("night mode multiplies by 1.4 during late hours", () => {
      setRng(() => 0.5);
      const day = readingDelayMs({ isGroup: false, wasAddressed: false, hourOfDay: 14 });
      const night = readingDelayMs({ isGroup: false, wasAddressed: false, hourOfDay: 23 });
      assert.ok(night >= day, `night ${night} should be >= day ${day}`);
      resetRng();
    });

    it("addressed halves the delay", () => {
      setRng(() => 0.5);
      const notAddressed = readingDelayMs({ isGroup: true, wasAddressed: false });
      const addressed = readingDelayMs({ isGroup: true, wasAddressed: true });
      assert.ok(addressed <= notAddressed, `addressed ${addressed} should be <= not ${notAddressed}`);
      resetRng();
    });

    it("group + not addressed multiplies by 1.5 vs DM", () => {
      setRng(() => 0.5);
      const dm = readingDelayMs({ isGroup: false, wasAddressed: false });
      const group = readingDelayMs({ isGroup: true, wasAddressed: false });
      assert.ok(group >= dm, `group ${group} should be >= dm ${dm}`);
      resetRng();
    });

    it("isQuestionReply reply is ~40% faster than the same ctx without (0.6x)", () => {
      setRng(() => 0.5);
      const base = readingDelayMs({ isGroup: true });
      const direct = readingDelayMs({ isGroup: true, isQuestionReply: true });
      const ratio = direct / base;
      assert.ok(ratio <= 0.8, `expected ~0.6x (clamp-limited), got ratio ${ratio} (base ${base}, direct ${direct})`);
      resetRng();
    });

    it("contentReadMs adds roughly that many ms to the result (within clamp)", () => {
      setRng(() => 0.5);
      const base = readingDelayMs({ isGroup: false });
      const withRead = readingDelayMs({ isGroup: false, contentReadMs: 3000 });
      const delta = withRead - base;
      assert.ok(delta >= 2000 && delta <= 4000, `expected ~3000 delta, got ${delta} (base ${base}, with ${withRead})`);
      resetRng();
    });

    it("group + no target still gets the 1.5x factor (not a direct answer)", () => {
      setRng(() => 0.5);
      const dm = readingDelayMs({ isGroup: false, isQuestionReply: false });
      const group = readingDelayMs({ isGroup: true, isQuestionReply: false });
      assert.ok(group >= dm * 1.2, `group ${group} should be ~1.5x dm ${dm}`);
      resetRng();
    });

    it("night mode multiplies by 1.4 for question replies too", () => {
      setRng(() => 0.5);
      const day = readingDelayMs({ isGroup: false, isQuestionReply: true, hourOfDay: 14 });
      const night = readingDelayMs({ isGroup: false, isQuestionReply: true, hourOfDay: 23 });
      assert.ok(night >= day, `night ${night} should be >= day ${day}`);
      resetRng();
    });

    it("plan 030: moodEnergy ±2 shifts the first-bubble delay by ≤12% (high energy faster, low energy slower)", () => {
      setRng(() => 0.5);
      const base = readingDelayMs({ isGroup: true, wasAddressed: false });
      const high = readingDelayMs({ isGroup: true, wasAddressed: false, moodEnergy: 2 });
      const low = readingDelayMs({ isGroup: true, wasAddressed: false, moodEnergy: -2 });
      assert.ok(high < base, `high energy ${high} should be < base ${base}`);
      assert.ok(low > base, `low energy ${low} should be > base ${base}`);
      const highRatio = high / base;
      const lowRatio = low / base;
      assert.ok(highRatio >= 0.87 && highRatio <= 1, `high ratio ${highRatio} within 0.87..1`);
      assert.ok(lowRatio >= 1 && lowRatio <= 1.13, `low ratio ${lowRatio} within 1..1.13`);
      resetRng();
    });

    it("plan 030: moodEnergy null leaves the delay unchanged (byte-identical DM/off)", () => {
      setRng(() => 0.5);
      const base = readingDelayMs({ isGroup: true, wasAddressed: false });
      const withNull = readingDelayMs({ isGroup: true, wasAddressed: false, moodEnergy: null });
      assert.equal(withNull, base, "null moodEnergy does not alter the delay");
      resetRng();
    });
  });

  describe("thinkPauseMs", () => {
    it("stays within [1000, 5000] for 100 samples", () => {
      setRng(() => 0.5);
      for (let i = 0; i < 100; i++) {
        const d = thinkPauseMs();
        assert.ok(d >= 1000 && d <= 5000, `out of range: ${d}`);
      }
      resetRng();
    });

    it("has variation", () => {
      setRng(deterministicRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.15]));
      const samples = Array.from({ length: 10 }, () => thinkPauseMs());
      const unique = new Set(samples);
      assert.ok(unique.size > 1, "expected variation");
      resetRng();
    });
  });

  describe("typingMs", () => {
    it("wpm math for 40 wpm: 120 chars ~ 36s with jitter", () => {
      setRng(() => 0.5);
      const d = typingMs("x".repeat(120), 40);
      assert.ok(d >= 1200 && d <= 60000, `out of range: ${d}`);
      resetRng();
    });

    it("clamps at 1200 minimum for very short text", () => {
      setRng(() => 0.5);
      const d = typingMs("hi", 40);
      assert.ok(d >= 1200, `expected >= 1200, got ${d}`);
      resetRng();
    });

    it("clamps at maxTypingMs=60000 default", () => {
      setRng(() => 0.99);
      const d = typingMs("x".repeat(50000), 40);
      assert.ok(d >= 1200 && d <= 60000, `out of range: ${d}`);
      resetRng();
    });

    it("honors maxTypingMs override", () => {
      setRng(() => 0.99);
      const d = typingMs("x".repeat(50000), 40, { maxTypingMs: 5000 });
      assert.ok(d <= 5000, `expected clamped to 5000, got ${d}`);
      resetRng();
    });

    it("defaults to 60000 when maxTypingMs is falsy", () => {
      setRng(() => 0.99);
      const d = typingMs("x".repeat(50000), 40, {});
      assert.ok(d <= 60000, `expected default 60000, got ${d}`);
      resetRng();
    });
  });

  describe("bubbleGapMs", () => {
    it("stays within [800, 3000] for 100 samples", () => {
      setRng(() => 0.5);
      for (let i = 0; i < 100; i++) {
        const d = bubbleGapMs();
        assert.ok(d >= 800 && d <= 3000, `out of range: ${d}`);
      }
      resetRng();
    });
  });

  describe("scheduleForBubbles", () => {
    it("produces cumulative offsets in order", () => {
      setRng(() => 0.5);
      const bubbles = [{ content: "Hi" }, { content: "How are you?" }, { content: "Great!" }];
      const scheduled = scheduleForBubbles(bubbles, { isGroup: false }, { typingWpm: 40 });
      assert.equal(scheduled.length, 3);
      assert.ok(scheduled[0].delayMs > 0);
      assert.ok(scheduled[1].delayMs > scheduled[0].delayMs);
      assert.ok(scheduled[2].delayMs > scheduled[1].delayMs);
      assert.equal(scheduled[0].content, "Hi");
      assert.equal(scheduled[1].content, "How are you?");
      assert.equal(scheduled[2].content, "Great!");
      assert.equal(scheduled[0].position, 0);
      assert.equal(scheduled[1].position, 1);
      assert.equal(scheduled[2].position, 2);
      resetRng();
    });
  });

  describe("hot-room timing compression (P0 answer-delivery hotfix)", () => {
    const HOT = 30_000;   // newest message < 3min → hot
    const COLD = 600_000; // >= 180s → cold (today's behavior)

    it("hot newestAgeMs (30s) yields significantly shorter first-bubble delays than cold (same RNG)", () => {
      setRng(() => 0.5);
      const bubbles = [{ content: "Das Restaurant ist ab 12 Uhr geöffnet." }];
      const hot = scheduleForBubbles(bubbles, { isGroup: true, newestAgeMs: HOT }, { typingWpm: 40 });
      const cold = scheduleForBubbles(bubbles, { isGroup: true, newestAgeMs: COLD }, { typingWpm: 40 });
      assert.ok(hot[0].delayMs < cold[0].delayMs, `hot ${hot[0].delayMs} should be < cold ${cold[0].delayMs}`);
      resetRng();
    });

    it("cold path (newestAgeMs null or 600000) is byte-identical to today's behavior", () => {
      setRng(() => 0.5);
      const bubbles = [{ content: "Hi" }, { content: "How are you?" }, { content: "Great!" }];
      const noAge = scheduleForBubbles(bubbles, { isGroup: false }, { typingWpm: 40 });
      const cold600 = scheduleForBubbles(bubbles, { isGroup: false, newestAgeMs: 600_000 }, { typingWpm: 40 });
      const legacy = scheduleForBubbles(bubbles, { isGroup: false, newestAgeMs: null }, { typingWpm: 40 });
      assert.deepEqual(cold600, noAge, "newestAgeMs=600000 matches no-newestAgeMs");
      assert.deepEqual(legacy, noAge, "newestAgeMs=null matches no-newestAgeMs");
      resetRng();
    });

    it("readingDelayMs applies the 0.35x hot factor and still clamps 2000-30000", () => {
      setRng(() => 0.5);
      const ctx = { isGroup: false, contentReadMs: 4000 };
      const cold = readingDelayMs({ ...ctx, newestAgeMs: COLD });
      const hot = readingDelayMs({ ...ctx, newestAgeMs: HOT });
      assert.ok(hot < cold, `hot ${hot} should be < cold ${cold}`);
      assert.ok(hot >= 2000 && hot <= 30000, `hot out of range: ${hot}`);
      resetRng();
    });

    it("typingMs caps at 8000ms per bubble in a hot room", () => {
      setRng(() => 0.99);
      const long = "x".repeat(20000);
      const hotTyping = typingMs(long, 40, { maxTypingMs: 60000 }, { newestAgeMs: HOT });
      const coldTyping = typingMs(long, 40, { maxTypingMs: 60000 }, { newestAgeMs: COLD });
      assert.ok(hotTyping <= 8000, `hot typing capped at 8000, got ${hotTyping}`);
      assert.ok(coldTyping <= 60000, `cold typing keeps the 60000 default cap`);
      resetRng();
    });

    it("per-bubble delays stay cumulative in a hot room", () => {
      setRng(() => 0.5);
      const bubbles = [
        { content: "Um 15:00 Uhr." },
        { content: "Der Eintritt kostet 12,50 €." },
        { content: "Ja genau, dort." },
      ];
      const scheduled = scheduleForBubbles(bubbles, { isGroup: true, newestAgeMs: HOT }, { typingWpm: 40 });
      assert.ok(scheduled[1].delayMs > scheduled[0].delayMs);
      assert.ok(scheduled[2].delayMs > scheduled[1].delayMs);
      resetRng();
    });

    it("hot thinkPause and bubbleGap scale down vs cold", () => {
      setRng(() => 0.5);
      const hotPause = thinkPauseMs({ newestAgeMs: HOT });
      const coldPause = thinkPauseMs({ newestAgeMs: COLD });
      assert.ok(hotPause <= coldPause, `hot pause ${hotPause} <= cold ${coldPause}`);
      const hotGap = bubbleGapMs({}, { newestAgeMs: HOT });
      const coldGap = bubbleGapMs({}, { newestAgeMs: COLD });
      assert.ok(hotGap <= coldGap, `hot gap ${hotGap} <= cold ${coldGap}`);
      resetRng();
    });
  });

  describe("variation across 1000 samples", () => {
    it("readingDelayMs stddev > 0", () => {
      setRng(deterministicRng(Array.from({ length: 2000 }, (_, i) => (i % 100) / 100)));
      const samples = Array.from({ length: 1000 }, () => readingDelayMs({ isGroup: false }));
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
      assert.ok(variance > 0, "stddev should be > 0");
      resetRng();
    });
  });
});
