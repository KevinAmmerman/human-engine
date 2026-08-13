import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { createLocalEngine, getState } from "../lib/local-engine.js";
import { buildDecidePrompt } from "../lib/local-prompts.js";
import scenarios from "./fixtures/decide-scenarios.json" with { type: "json" };

function makeTiming() {
  return {
    scheduleForBubbles(bubbles, ctx, timingCfg) {
      return bubbles.map((b, i) => ({ content: b.content, position: i, delayMs: (i + 1) * 10 }));
    },
  };
}

describe("decide-eval", () => {
  beforeEach(() => {
    getState().epochs.clear();
  });

  describe("deterministic layer", () => {
    for (let si = 0; si < scenarios.scenarios.length; si++) {
      const scenario = scenarios.scenarios[si];
      const suffix = scenario.deterministic ? " short-circuit" : " stubbed LLM";
      it(scenario.name + ": expect " + scenario.expect + suffix, async () => {
        let llmCalled = false;
        const engine = createLocalEngine({
          cfg: {},
          llm: {
            complete: async () => {
              llmCalled = true;
              if (scenario.expect === "speak") return { text: "SPEAK" };
              return { text: "STAY_SILENT" };
            },
          },
          timing: makeTiming(),
        });

        const result = await engine.decide({
          sessionKey: "decide-" + si,
          isDM: scenario.isDM,
          hasMedia: scenario.hasMedia,
          prompt: scenario.prompt,
          agentName: scenario.agentName || "OpenClaw",
          messages: scenario.messages || [],
          transcript: (scenario.transcript || []).map(function (t) { return { speaker: t[0], text: t[1] }; }),
          agentContactIds: scenario.agentContactIds ? new Set(scenario.agentContactIds) : undefined,
        });

        if (scenario.deterministic) {
          assert.equal(llmCalled, false, scenario.name + ": deterministic scenario should NOT call LLM");
        } else {
          assert.equal(llmCalled, true, scenario.name + ": non-deterministic scenario SHOULD call LLM");
        }

        if (result === null) {
          assert.equal(scenario.expect, "stay_silent", scenario.name + ": null result unexpected for speak scenario");
          return;
        }

        assert.equal(result.decision, scenario.expect, scenario.name + ": decision mismatch");
        if (result.decision === "speak") {
          assert.ok(result.epoch > 0, scenario.name + ": speak should advance the epoch");
        } else {
          assert.equal(result.epoch, 0, scenario.name + ": stay_silent must not advance the epoch");
        }
      });
    }
  });

  describe("prompt-contract layer", () => {
    for (const scenario of scenarios.scenarios) {
      it(scenario.name + ": decide prompt includes transcript and persona", () => {
        const transcript = (scenario.transcript || []).map(([speaker, text]) => ({ speaker, text }));
        const prompt = buildDecidePrompt({
          transcript,
          persona: "You are a helpful assistant.",
          voiceCard: null,
          agentName: scenario.agentName || "OpenClaw",
        });

        assert.ok(prompt.systemPrompt.includes(scenario.agentName || "OpenClaw"),
          "systemPrompt should mention agent name");
        assert.ok(prompt.systemPrompt.includes("You are a helpful assistant."),
          "systemPrompt should include persona");
        assert.ok(prompt.systemPrompt.includes("SPEAK") || prompt.systemPrompt.includes("STAY_SILENT"),
          "systemPrompt should contain decision tokens");

        if (transcript.length > 0) {
          for (const t of transcript) {
            assert.ok(prompt.userMessage.includes(t.speaker),
              `userMessage should include speaker ${t.speaker}`);
          }
        }
      });
    }

    it("follow-up to the agent's own line is SPEAK-leaning and includes the agent line", () => {
      const transcript = [
        { speaker: "Kevin", text: "was sagst du sollte ich mir eine Rastschlinge ausleihen?" },
        { speaker: "Hori", text: "ja auf jeden fall, bei C/D-Passagen hilft sie dir" },
        { speaker: "Kevin", text: "und wo bekomm ich die her?" },
      ];
      const prompt = buildDecidePrompt({ transcript, persona: null, voiceCard: null, agentName: "Hori" });
      assert.ok(prompt.systemPrompt.includes("follow-up"),
        "systemPrompt should carry the follow-up SPEAK-lean rule");
      assert.ok(prompt.userMessage.includes("Rastschlinge"),
        "userMessage should include the agent's own previous line");
      assert.ok(prompt.userMessage.includes("bekomm ich die her"),
        "userMessage should include the follow-up question");
    });
  });

  describe("scenario contract", () => {
    it("has at least 20 labeled scenarios", () => {
      assert.ok(scenarios.scenarios.length >= 20,
        `expected >= 20 scenarios, got ${scenarios.scenarios.length}`);
    });

    it("every scenario has required fields", () => {
      for (const s of scenarios.scenarios) {
        assert.ok(typeof s.name === "string" && s.name.length > 0, "scenario missing name");
        assert.ok(typeof s.isDM === "boolean", `${s.name}: isDM must be boolean`);
        assert.ok(typeof s.hasMedia === "boolean", `${s.name}: hasMedia must be boolean`);
        assert.ok(s.expect === "speak" || s.expect === "stay_silent", `${s.name}: expect must be speak/stay_silent`);
        assert.ok(typeof s.deterministic === "boolean", `${s.name}: deterministic must be boolean`);
        assert.ok(typeof s.rationale === "string" && s.rationale.length > 0, `${s.name}: missing rationale`);
      }
    });
  });
});
