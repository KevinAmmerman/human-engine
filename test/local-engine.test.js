import assert from "node:assert/strict";
import { describe, it, beforeEach, mock } from "node:test";
import { createLocalEngine, getState } from "../lib/local-engine.js";

function makeTiming() {
  return {
    scheduleForBubbles(bubbles, ctx, timingCfg) {
      return bubbles.map((b, i) => ({
        content: b.content,
        position: i,
        delayMs: (i + 1) * 10,
      }));
    },
  };
}

describe("local-engine", () => {
  beforeEach(() => {
    getState().epochs.clear();
  });

  describe("decide — short circuits", () => {
    it("DM always speaks with zero LLM calls", async () => {
      let llmCalled = false;
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { llmCalled = true; return { text: "STAY_SILENT" }; } },
        timing: makeTiming(),
      });
      const res = await engine.decide({ sessionKey: "s1", isDM: true });
      assert.deepEqual(res.decision, "speak");
      assert.ok(res.epoch > 0);
      assert.equal(llmCalled, false);
    });

    it("hasMedia always speaks with zero LLM calls", async () => {
      let llmCalled = false;
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { llmCalled = true; return { text: "STAY_SILENT" }; } },
        timing: makeTiming(),
      });
      const res = await engine.decide({ sessionKey: "s2", hasMedia: true });
      assert.deepEqual(res.decision, "speak");
      assert.equal(llmCalled, false);
    });

    it("hard trigger (agent name) speaks with zero LLM calls", async () => {
      let llmCalled = false;
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { llmCalled = true; return { text: "STAY_SILENT" }; } },
        timing: makeTiming(),
      });
      const res = await engine.decide({
        sessionKey: "s3",
        prompt: "OpenClaw, what do you think?",
        agentName: "OpenClaw",
      });
      assert.deepEqual(res.decision, "speak");
      assert.equal(llmCalled, false);
    });

    it("question to another member goes to LLM (no short-circuit)", async () => {
      let llmCalled = false;
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { llmCalled = true; return { text: "STAY_SILENT" }; } },
        timing: makeTiming(),
      });
      const res = await engine.decide({
        sessionKey: "s4",
        messages: [{ text: "Bob, what do you think?" }],
        agentName: "OpenClaw",
      });
      assert.equal(llmCalled, true);
      assert.deepEqual(res.decision, "stay_silent");
    });
  });

  describe("decide — LLM path", () => {
    it("SPEAK from LLM returns speak decision", async () => {
      const engine = createLocalEngine({
        cfg: { decide: { temperature: 0.2 } },
        llm: { complete: async () => ({ text: "SPEAK" }) },
        timing: makeTiming(),
      });
      const res = await engine.decide({ sessionKey: "s5", prompt: "Hello" });
      assert.deepEqual(res.decision, "speak");
    });

    it("STAY_SILENT from LLM returns stay_silent", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "STAY_SILENT" }) },
        timing: makeTiming(),
      });
      const res = await engine.decide({ sessionKey: "s6", prompt: "Hello" });
      assert.deepEqual(res.decision, "stay_silent");
    });

    it("garbage LLM output → stay_silent", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "I'm not sure what to say here" }) },
        timing: makeTiming(),
      });
      const res = await engine.decide({ sessionKey: "s7", prompt: "Hello" });
      assert.deepEqual(res.decision, "stay_silent");
    });

    it("LLM error returns null", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { throw new Error("LLM down"); } },
        timing: makeTiming(),
      });
      const res = await engine.decide({ sessionKey: "s8", prompt: "Hello" });
      assert.equal(res, null);
    });

    it("null LLM returns null", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: null,
        timing: makeTiming(),
      });
      const res = await engine.decide({ sessionKey: "s9", prompt: "Hello" });
      assert.equal(res, null);
    });
  });

  describe("epoch", () => {
    it("increments on each decide call", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "STAY_SILENT" }) },
        timing: makeTiming(),
      });
      const r1 = await engine.decide({ sessionKey: "s10", prompt: "a" });
      const r2 = await engine.decide({ sessionKey: "s10", prompt: "b" });
      assert.equal(r2.epoch, r1.epoch + 1);
    });

    it("currentEpoch returns 0 for unknown session", () => {
      const engine = createLocalEngine({ cfg: {}, llm: null, timing: makeTiming() });
      assert.equal(engine.currentEpoch("nonexistent"), 0);
    });

    it("currentEpoch returns latest epoch", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "STAY_SILENT" }) },
        timing: makeTiming(),
      });
      await engine.decide({ sessionKey: "s11", prompt: "x" });
      assert.equal(engine.currentEpoch("s11"), 1);
    });
  });

  describe("respond", () => {
    it("supersedes when epoch is stale", async () => {
      const engine = createLocalEngine({ cfg: {}, llm: null, timing: makeTiming() });
      const d1 = await engine.decide({ sessionKey: "s12", isDM: true });
      const res = await engine.respond({ sessionKey: "s12", draft: "Hi", epoch: d1.epoch });
      assert.equal(res.superseded, false);
      const d2 = await engine.decide({ sessionKey: "s12", isDM: true });
      const res2 = await engine.respond({ sessionKey: "s12", draft: "Hi", epoch: d1.epoch });
      assert.equal(res2.superseded, true);
    });

    it("returns scheduled with draft fallback when llm is null", async () => {
      const engine = createLocalEngine({ cfg: {}, llm: null, timing: makeTiming() });
      const res = await engine.respond({ sessionKey: "s13", draft: "Hello world", epoch: 0 });
      assert.equal(res.superseded, false);
      assert.ok(Array.isArray(res.scheduled));
      assert.equal(res.scheduled.length, 1);
      assert.equal(res.scheduled[0].content, "Hello world");
    });

    it("uses LLM split result when available", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: {
          complete: async () => ({ text: '{"messages": ["Bubble one", "Bubble two"]}' }),
        },
        timing: makeTiming(),
      });
      const res = await engine.respond({ sessionKey: "s14", draft: "Hello", epoch: 1 });
      assert.equal(res.superseded, false);
      assert.ok(Array.isArray(res.scheduled));
      assert.equal(res.scheduled.length, 2);
    });

    it("LLM error returns draft fallback", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { throw new Error("crash"); } },
        timing: makeTiming(),
      });
      const res = await engine.respond({ sessionKey: "s15", draft: "Fallback", epoch: 1 });
      assert.equal(res.superseded, false);
      assert.equal(res.scheduled[0].content, "Fallback");
    });

    it("invalid JSON from LLM returns draft fallback", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "not valid json at all" }) },
        timing: makeTiming(),
      });
      const res = await engine.respond({ sessionKey: "s16", draft: "Fallback json", epoch: 1 });
      assert.equal(res.superseded, false);
      assert.equal(res.scheduled[0].content, "Fallback json");
    });

    it("empty messages array from LLM returns draft fallback", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: '{"messages": []}' }) },
        timing: makeTiming(),
      });
      const res = await engine.respond({ sessionKey: "s17", draft: "Empty fallback", epoch: 1 });
      assert.equal(res.superseded, false);
      assert.equal(res.scheduled[0].content, "Empty fallback");
    });

    it("bubbles capped at maxBubbles", async () => {
      const engine = createLocalEngine({
        cfg: { humanize: { maxBubbles: 2 } },
        llm: {
          complete: async () => ({ text: '{"messages": ["a", "b", "c", "d"]}' }),
        },
        timing: makeTiming(),
      });
      const res = await engine.respond({ sessionKey: "s18", draft: "test", epoch: 1 });
      assert.equal(res.superseded, false);
      assert.ok(res.scheduled.length <= 2);
    });

    it("timing attached to scheduled result", async () => {
      const engine = createLocalEngine({
        cfg: { timing: { typingWpm: 40 } },
        llm: {
          complete: async () => ({ text: '{"messages": ["One", "Two"]}' }),
        },
        timing: makeTiming(),
      });
      const res = await engine.respond({ sessionKey: "s19", draft: "Hi", epoch: 1 });
      assert.ok(res.scheduled[0].delayMs > 0);
      assert.ok(res.scheduled[0].delayMs !== undefined);
    });
  });
});
