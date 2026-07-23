import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultConfig, resolveConfig, isEnabled, isScopedAgent } from "../lib/config.js";

describe("config", () => {
  it("defaultConfig returns expected defaults", () => {
    const cfg = defaultConfig();
    assert.equal(cfg.enabled, true);
    assert.deepEqual(cfg.agents, []);
    assert.equal(cfg.agentName, "OpenClaw");
    assert.equal(cfg.soulPath, "");
    assert.equal(cfg.soulAutoEnhance, true);
    assert.equal(cfg.socialLearning.enabled, true);
    assert.equal(cfg.antiTell, true);
    assert.equal(cfg.styleStats, true);
    assert.equal(cfg.socialLearning.refreshEvery, 5);
    assert.equal(cfg.socialLearning.refreshMinutes, 0);
    assert.deepEqual(cfg.socialMemory, { enabled: true, extractEvery: 25, extractMinutes: 0, maxPeople: 50, recallLimit: 800 });
    assert.equal(cfg.autoconfig, false);
    assert.deepEqual(cfg.decide, { model: "", temperature: 0.2 });
    assert.deepEqual(cfg.humanize, { model: "", maxBubbles: 5, temperature: 0.9 });
    assert.deepEqual(cfg.timing, { typingWpm: 40, maxTypingMs: 60000, nightMode: true });
  });

  it("resolveConfig merges with defaults", () => {
    const api = { pluginConfig: { agentName: "TestBot" } };
    const cfg = resolveConfig(api);
    assert.equal(cfg.agentName, "TestBot");
    assert.equal(cfg.enabled, true);
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
