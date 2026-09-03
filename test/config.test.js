import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultConfig, resolveConfig, isEnabled, isScopedAgent } from "../lib/config.js";

describe("config", () => {
  it("defaultConfig returns expected defaults", () => {
    const cfg = defaultConfig();
    assert.equal(cfg.enabled, true);
    assert.deepEqual(cfg.agents, []);
    assert.equal(cfg.agentName, "OpenClaw");
    assert.deepEqual(cfg.agentAliases, []);
    assert.equal(cfg.soulPath, "");
    assert.equal(cfg.soulAutoEnhance, true);
    assert.equal(cfg.socialLearning.enabled, true);
    assert.equal(cfg.antiTell, true);
    assert.equal(cfg.styleStats, true);
    assert.equal(cfg.socialLearning.refreshEvery, 5);
    assert.equal(cfg.socialLearning.refreshMinutes, 0);
    assert.deepEqual(cfg.socialMemory, { enabled: true, extractEvery: 25, extractMinutes: 0, maxPeople: 50, recallLimit: 800 });
    assert.equal(cfg.autoconfig, false);
    assert.equal(cfg.socialLearning.perSessionCard, true);
    assert.deepEqual(cfg.decide, { temperature: 0.2 });
    assert.deepEqual(cfg.humanize, { maxBubbles: 5, temperature: 0.9 });
    assert.deepEqual(cfg.timing, { typingWpm: 40, maxTypingMs: 60000, maxBubbleGapMs: 3000, nightMode: true });
    assert.deepEqual(cfg.naturalize, { speakEpochTtlMs: 300000 });
    assert.deepEqual(cfg.dmProactive, { enabled: false, shadow: true, budgetPerDay: 2, minGapMinutes: 180, quietStart: "23:00", quietEnd: "07:00", careBudgetPerDay: 1 });
  });

  it("resolveConfig merges with defaults", () => {
    const api = { pluginConfig: { agentName: "TestBot" } };
    const cfg = resolveConfig(api);
    assert.equal(cfg.agentName, "TestBot");
    assert.equal(cfg.enabled, true);
    assert.deepEqual(cfg.agentAliases, [], "agentAliases default survives when only agentName is overridden");
  });

  it("resolveConfig falls back to api.config.plugins.entries", () => {
    const api = {
      config: {
        plugins: {
          entries: {
            "human-engine": { config: { agentName: "FallbackBot" } },
          },
        },
      },
    };
    const cfg = resolveConfig(api);
    assert.equal(cfg.agentName, "FallbackBot");
  });

  it("resolveConfig prefers pluginConfig over config.plugins.entries", () => {
    const api = {
      pluginConfig: { agentName: "DirectBot" },
      config: {
        plugins: {
          entries: {
            "human-engine": { config: { agentName: "IndirectBot" } },
          },
        },
      },
    };
    const cfg = resolveConfig(api);
    assert.equal(cfg.agentName, "DirectBot");
  });

  it("resolveConfig with empty api returns defaults", () => {
    const cfg = resolveConfig({});
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.agentName, "OpenClaw");
  });

  it("resolveConfig deep-merges nested objects one level", () => {
    const api = { pluginConfig: { decide: { temperature: 0.5 }, timing: { typingWpm: 60 } } };
    const cfg = resolveConfig(api);
    assert.equal(cfg.decide.temperature, 0.5);
    assert.equal(cfg.humanize.maxBubbles, 5, "sibling key in decide's default sub-object survives");
    assert.equal(cfg.timing.typingWpm, 60);
    assert.equal(cfg.timing.maxTypingMs, 60000, "sibling timing default survives");
    assert.equal(cfg.timing.maxBubbleGapMs, 3000);
    assert.equal(cfg.socialLearning.refreshEvery, 5);
    assert.equal(cfg.proactive.recognitionBudgetPerDay, 1);
    assert.equal(cfg.proactive.triggers.outcomeCelebration, true);
    assert.equal(cfg.proactive.triggers.checkInOnPromise, true);
  });

  it("resolveConfig deep-merges dmProactive one level and keeps sibling defaults", () => {
    const api = { pluginConfig: { dmProactive: { enabled: true } } };
    const cfg = resolveConfig(api);
    assert.equal(cfg.dmProactive.enabled, true);
    assert.equal(cfg.dmProactive.shadow, true, "sibling dmProactive default survives");
    assert.equal(cfg.dmProactive.quietStart, "23:00");
  });

  it("resolveConfig keeps whole sub-object override intact", () => {
    const api = { pluginConfig: { humanize: { temperature: 0.1 } } };
    const cfg = resolveConfig(api);
    assert.equal(cfg.humanize.temperature, 0.1);
    assert.equal(cfg.humanize.maxBubbles, 5);
  });

  it("isEnabled returns true when enabled is true", () => {
    assert.equal(isEnabled({ enabled: true }), true);
  });

  it("isEnabled returns false when enabled is false", () => {
    assert.equal(isEnabled({ enabled: false }), false);
  });

  it("isEnabled returns false for missing enabled", () => {
    assert.equal(isEnabled({}), false);
  });

  it("isScopedAgent returns true for empty agents", () => {
    assert.equal(isScopedAgent({ agents: [] }, "any-agent"), true);
  });

  it("isScopedAgent returns true for non-array agents", () => {
    assert.equal(isScopedAgent({ agents: null }, "any-agent"), true);
    assert.equal(isScopedAgent({}, "any-agent"), true);
  });

  it("isScopedAgent matches allowed agent", () => {
    assert.equal(isScopedAgent({ agents: ["alice", "bob"] }, "alice"), true);
    assert.equal(isScopedAgent({ agents: ["alice", "bob"] }, "bob"), true);
  });

  it("isScopedAgent rejects non-matching agent", () => {
    assert.equal(isScopedAgent({ agents: ["alice", "bob"] }, "charlie"), false);
  });

  it("isScopedAgent returns false for missing/non-string agentId when list is non-empty", () => {
    assert.equal(isScopedAgent({ agents: ["alice"] }, null), false);
    assert.equal(isScopedAgent({ agents: ["alice"] }, undefined), false);
    assert.equal(isScopedAgent({ agents: ["alice"] }, ""), false);
  });
});
