import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDecidePrompt, buildSplitPrompt } from "../lib/local-prompts.js";

describe("local-prompts", () => {
  describe("buildDecidePrompt", () => {
    it("includes agent name in system prompt", () => {
      const p = buildDecidePrompt({ agentName: "TestBot" });
      assert.ok(p.systemPrompt.includes("TestBot"));
      assert.ok(p.systemPrompt.includes("SPEAK or STAY_SILENT"));
    });

    it("includes persona when provided", () => {
      const p = buildDecidePrompt({ agentName: "Bot", persona: "You are friendly." });
      assert.ok(p.systemPrompt.includes("You are friendly."));
    });

    it("includes voice card when provided", () => {
      const p = buildDecidePrompt({ agentName: "Bot", voiceCard: "# Voice Card" });
      assert.ok(p.systemPrompt.includes("# Voice Card"));
    });

    it("caps transcript to 20 lines", () => {
      const lines = Array.from({ length: 30 }, (_, i) => ({ speaker: `User${i}`, text: `msg ${i}` }));
      const p = buildDecidePrompt({ agentName: "Bot", transcript: lines });
      const lineCount = p.userMessage.split("\n").length;
      assert.ok(lineCount <= 20);
    });

    it("falls back to default when no agent name", () => {
      const p = buildDecidePrompt({});
      assert.ok(p.systemPrompt.includes("the agent"));
    });

    it("falls back to placeholder when no transcript", () => {
      const p = buildDecidePrompt({ agentName: "Bot" });
      assert.ok(p.userMessage.includes("(no recent messages)"));
    });
  });

  describe("buildSplitPrompt", () => {
    it("includes banned items list", () => {
      const p = buildSplitPrompt({ draft: "hi", maxBubbles: 3 });
      assert.ok(p.systemPrompt.includes("delve"));
      assert.ok(p.systemPrompt.includes("em-dash"));
      assert.ok(p.systemPrompt.includes("rule-of-three"));
      assert.ok(p.systemPrompt.includes("How can I help you"));
      assert.ok(p.systemPrompt.includes("ENCOURAGED"));
    });

    it("includes persona and voice card when provided", () => {
      const p = buildSplitPrompt({
        draft: "hi", persona: "You are a cat.", voiceCard: "# Cat Card",
      });
      assert.ok(p.systemPrompt.includes("You are a cat."));
      assert.ok(p.systemPrompt.includes("# Cat Card"));
    });

    it("includes style constraints when provided", () => {
      const p = buildSplitPrompt({
        draft: "hi", styleConstraints: "Be short.",
      });
      assert.ok(p.systemPrompt.includes("Be short."));
    });

    it("includes JSON contract", () => {
      const p = buildSplitPrompt({ draft: "hi" });
      assert.ok(p.systemPrompt.includes('"messages"'));
    });

    it("includes draft in user message", () => {
      const p = buildSplitPrompt({ draft: "Hello world" });
      assert.ok(p.userMessage.includes("Hello world"));
    });

    it("caps transcript to 10 lines in user message", () => {
      const lines = Array.from({ length: 20 }, (_, i) => ({ speaker: `U${i}`, text: `m ${i}` }));
      const p = buildSplitPrompt({ draft: "hi", transcript: lines });
      const ctxLine = p.userMessage.split("\n").find((l) => l.startsWith("["));
      const count = p.userMessage.split("\n").filter((l) => l.startsWith("[")).length;
      assert.ok(count <= 10);
    });

    it("includes maxBubbles in prompt", () => {
      const p = buildSplitPrompt({ draft: "hi", maxBubbles: 3 });
      assert.ok(p.systemPrompt.includes("3"));
    });
  });
});
