import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
  setRng, resetRng,
  readingDelayMs, thinkPauseMs, typingMs, bubbleGapMs, scheduleForBubbles,
} from "../lib/timing-engine.js";

function deterministicRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

function sequenceRng(seed) {
  let s = seed || 42;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function coefficientOfVariation(samples) {
  const n = samples.length;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  return mean > 0 ? stddev / mean : 0;
}

describe("timing-distribution", () => {
  afterEach(() => {
    resetRng();
  });

  describe("10k samples — ranges", () => {
    it("readingDelayMs stays within [2000, 30000]", () => {
      setRng(sequenceRng(1));
      const samples = Array.from({ length: 10000 }, () => readingDelayMs({ isGroup: false }));
      for (const d of samples) {
        assert.ok(d >= 2000 && d <= 30000, `out of range: ${d}`);
      }
    });

    it("thinkPauseMs stays within [1000, 5000]", () => {
      setRng(sequenceRng(2));
      const samples = Array.from({ length: 10000 }, () => thinkPauseMs());
      for (const d of samples) {
        assert.ok(d >= 1000 && d <= 5000, `out of range: ${d}`);
      }
    });

    it("bubbleGapMs stays within [800, 3000]", () => {
      setRng(sequenceRng(3));
      const samples = Array.from({ length: 10000 }, () => bubbleGapMs());
      for (const d of samples) {
        assert.ok(d >= 800 && d <= 3000, `out of range: ${d}`);
      }
    });

    it("typingMs clamp [1200, 60000]", () => {
      setRng(sequenceRng(4));
      const samples = Array.from({ length: 10000 }, () => typingMs("hello world how are you today?", 40));
      for (const d of samples) {
        assert.ok(d >= 1200 && d <= 60000, `out of range: ${d}`);
      }
    });
  });

  describe("variation — coefficient of variation > 0.15", () => {
    it("readingDelayMs CV > 0.15", () => {
      setRng(sequenceRng(10));
      const samples = Array.from({ length: 10000 }, () => readingDelayMs({ isGroup: false }));
      const cv = coefficientOfVariation(samples);
      assert.ok(cv > 0.15, `readingDelayMs CV ${cv} <= 0.15`);
    });

    it("thinkPauseMs CV > 0.15", () => {
      setRng(sequenceRng(11));
      const samples = Array.from({ length: 10000 }, () => thinkPauseMs());
      const cv = coefficientOfVariation(samples);
      assert.ok(cv > 0.15, `thinkPauseMs CV ${cv} <= 0.15`);
    });

    it("bubbleGapMs CV > 0.15", () => {
      setRng(sequenceRng(12));
      const samples = Array.from({ length: 10000 }, () => bubbleGapMs());
      const cv = coefficientOfVariation(samples);
      assert.ok(cv > 0.15, `bubbleGapMs CV ${cv} <= 0.15`);
    });

    it("typingMs CV > 0.15", () => {
      setRng(sequenceRng(13));
      const samples = Array.from({ length: 10000 }, () => typingMs("some reasonably long text to type here for testing purposes", 40));
      const cv = coefficientOfVariation(samples);
      assert.ok(cv > 0.15, `typingMs CV ${cv} <= 0.15`);
    });
  });

  describe("context modifiers", () => {
    it("addressed median < not-addressed median", () => {
      setRng(sequenceRng(20));
      const notAddressed = Array.from({ length: 5000 }, () => readingDelayMs({ isGroup: true, wasAddressed: false, hourOfDay: 14 }));
      const addressed = Array.from({ length: 5000 }, () => readingDelayMs({ isGroup: true, wasAddressed: true, hourOfDay: 14 }));
      const naMedian = notAddressed.sort((a, b) => a - b)[2500];
      const aMedian = addressed.sort((a, b) => a - b)[2500];
      assert.ok(aMedian < naMedian, `addressed median ${aMedian} >= not-addressed ${naMedian}`);
    });

    it("night (23:00) median > day (14:00) median when nightMode on", () => {
      setRng(sequenceRng(21));
      const day = Array.from({ length: 5000 }, () => readingDelayMs({ isGroup: false, wasAddressed: false, hourOfDay: 14 }));
      const night = Array.from({ length: 5000 }, () => readingDelayMs({ isGroup: false, wasAddressed: false, hourOfDay: 23 }));
      const dayMedian = day.sort((a, b) => a - b)[2500];
      const nightMedian = night.sort((a, b) => a - b)[2500];
      assert.ok(nightMedian > dayMedian, `night median ${nightMedian} <= day median ${dayMedian}`);
    });

    it("wpm math exact at fixed RNG", () => {
      setRng(() => 0.5);
      const d = typingMs("x".repeat(120), 40);
      assert.ok(d >= 1200 && d <= 60000, `wpm math out of range: ${d}`);
      const d2 = typingMs("short", 40);
      assert.ok(d2 === 1200, `short text should hit clamp 1200, got ${d2}`);
      resetRng();
    });
  });

  describe("scheduleForBubbles", () => {
    it("first bubble delayMs > 0 and strictly increasing", () => {
      setRng(() => 0.5);
      const bubbles = [
        { content: "First message" },
        { content: "Second message here" },
        { content: "Third message here too" },
        { content: "Fourth bubble yep" },
        { content: "Fifth and final one" },
      ];
      const scheduled = scheduleForBubbles(bubbles, { isGroup: false }, { typingWpm: 40 });
      assert.equal(scheduled.length, 5);
      assert.ok(scheduled[0].delayMs > 0, "first delay should be > 0");
      for (let i = 1; i < scheduled.length; i++) {
        assert.ok(scheduled[i].delayMs > scheduled[i - 1].delayMs,
          `bubble ${i} delay ${scheduled[i].delayMs} not > ${scheduled[i - 1].delayMs}`);
      }
      resetRng();
    });

    it("consecutive gaps >= 800 ms", () => {
      setRng(sequenceRng(30));
      const bubbles = [
        { content: "Hey" },
        { content: "How are you?" },
        { content: "That's cool" },
        { content: "I agree" },
        { content: "lol nice" },
      ];
      const scheduled = scheduleForBubbles(bubbles, { isGroup: false }, { typingWpm: 40 });
      for (let i = 1; i < scheduled.length; i++) {
        const gap = scheduled[i].delayMs - scheduled[i - 1].delayMs;
        assert.ok(gap >= 800, `gap ${gap}ms between bubbles ${i - 1} and ${i} < 800ms`);
      }
    });
  });
});
