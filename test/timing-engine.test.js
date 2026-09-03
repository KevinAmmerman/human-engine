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

    it("clamp bounds hold for extreme inputs", () => {
      setRng(() => 0.5);
      const huge = readingDelayMs({ isGroup: true, contentReadMs: 100000, isQuestionReply: false });
      assert.ok(huge <= 30000, `expected clamp to 30000, got ${huge}`);
      const tiny = readingDelayMs({ isGroup: false, isQuestionReply: true });
      assert.ok(tiny >= 2000, `expected clamp to 2000, got ${tiny}`);
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
