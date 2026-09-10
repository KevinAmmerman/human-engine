import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultConfig, resolveConfig, isEnabled, isScopedAgent, resolveAgentConfig, resolveAgentConfigForSession, dmProactiveAgents, isScopedDmAgent } from "../lib/config.js";

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
    assert.deepEqual(cfg.socialMemory, { enabled: true, extractEvery: 25, extractMinutes: 0, maxPeople: 50, recallLimit: 800, personStore: false, schemaV2: false });
    assert.equal(cfg.autoconfig, false);
    assert.equal(cfg.socialLearning.perSessionCard, true);
    assert.deepEqual(cfg.decide, { temperature: 0.2 });
    assert.deepEqual(cfg.humanize, { maxBubbles: 5, temperature: 0.9 });
    assert.deepEqual(cfg.timing, { typingWpm: 40, maxTypingMs: 60000, maxBubbleGapMs: 3000, nightMode: true });
    assert.deepEqual(cfg.naturalize, { disableDM: false, speakEpochTtlMs: 300000 });
    assert.deepEqual(cfg.dmProactive, { agents: [], enabled: false, shadow: true, budgetPerDay: 2, minGapMinutes: 180, quietStart: "23:00", quietEnd: "07:00", careBudgetPerDay: 1, dayFitReduceHours: 4, dayFitPauseHours: 12, dayFitActivityPath: "", inferredCapPerDay: 2 });
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

  it("resolveConfig deep-merges naturalize and keeps sibling defaults", () => {
    const cfg = resolveConfig({ pluginConfig: { naturalize: { disableDM: true } } });
    assert.equal(cfg.naturalize.disableDM, true);
    assert.equal(cfg.naturalize.speakEpochTtlMs, 300000, "sibling naturalize default survives");
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

  it("defaultConfig agentProfiles is an empty object", () => {
    assert.deepEqual(defaultConfig().agentProfiles, {});
  });

  it("resolveConfig merges agentProfiles into cfg and keeps other keys", () => {
    const cfg = resolveConfig({ pluginConfig: { agentProfiles: { "agent-b": { agentName: "BotB" } } } });
    assert.equal(cfg.agentProfiles["agent-b"].agentName, "BotB");
    assert.equal(cfg.agentName, "OpenClaw", "global agentName untouched");
    assert.deepEqual(cfg.agents, [], "global agents untouched");
    assert.equal(cfg.enabled, true, "global enabled untouched");
  });

  it("resolveAgentConfig profile overrides win, non-profile keys fall back to global", () => {
    const cfg = resolveConfig({
      pluginConfig: {
        agentName: "Yuki",
        agentAliases: ["Hori"],
        soulPath: "/global/soul.md",
        contactsPath: "/global/contacts.md",
        agentProfiles: { "agent-b": { agentName: "BotB", soulPath: "/tmp/b-soul.md" } },
      },
    });
    const a = resolveAgentConfig(cfg, "agent-b");
    assert.equal(a.agentName, "BotB", "profile agentName wins");
    assert.equal(a.soulPath, "/tmp/b-soul.md", "profile soulPath wins");
    assert.deepEqual(a.agentAliases, ["Hori"], "non-profile alias falls back to global");
    assert.equal(a.contactsPath, "/global/contacts.md", "non-profile contactsPath falls back to global");
  });

  it("resolveAgentConfig merges nested profile objects one level over global", () => {
    const cfg = resolveConfig({ pluginConfig: { agentProfiles: { "agent-b": { proactive: { shadow: false } } } } });
    const a = resolveAgentConfig(cfg, "agent-b");
    assert.equal(a.proactive.shadow, false, "profile nested override wins");
    assert.equal(a.proactive.budgetPerDay, 2, "sibling global nested default survives");
    assert.equal(a.proactive.enabled, false, "sibling global nested default survives");
  });

  it("resolveAgentConfig with unknown/missing agentId returns the same cfg object", () => {
    const cfg = resolveConfig({ pluginConfig: { agentProfiles: { "agent-b": { agentName: "BotB" } } } });
    assert.equal(resolveAgentConfig(cfg, "unknown"), cfg, "unknown agentId returns same object");
    assert.equal(resolveAgentConfig(cfg, undefined), cfg, "undefined agentId returns same object");
    assert.equal(resolveAgentConfig(cfg, null), cfg, "null agentId returns same object");
    assert.equal(resolveAgentConfig(cfg, ""), cfg, "empty agentId returns same object");
  });

  it("resolveAgentConfig with no profile entry returns the same cfg object", () => {
    const cfg = resolveConfig({ pluginConfig: { agentProfiles: {} } });
    assert.equal(resolveAgentConfig(cfg, "agent-b"), cfg, "agent without profile entry returns same object");
  });

  it("resolveAgentConfigForSession resolves profile from sessionKey agentId", () => {
    const cfg = resolveConfig({ pluginConfig: { agentProfiles: { "agent-b": { agentName: "BotB" } } } });
    const a = resolveAgentConfigForSession(cfg, "agent:agent-b:whatsapp:group:1@g.us", null);
    assert.equal(a.agentName, "BotB");
  });

  it("resolveAgentConfigForSession uses ctxAgentId when sessionKey has no agentId", () => {
    const cfg = resolveConfig({ pluginConfig: { agentProfiles: { "agent-b": { agentName: "BotB" } } } });
    const a = resolveAgentConfigForSession(cfg, "whatsapp:group:1@g.us", "agent-b");
    assert.equal(a.agentName, "BotB");
  });

  it("resolveAgentConfigForSession falls back to global when no agentId present", () => {
    const cfg = resolveConfig({ pluginConfig: { agentName: "Yuki", agentProfiles: { "agent-b": { agentName: "BotB" } } } });
    const a = resolveAgentConfigForSession(cfg, "whatsapp:group:1@g.us", null);
    assert.equal(a.agentName, "Yuki");
  });

  it("agentProfiles do not widen scoping allowlist", () => {
    const cfg = resolveConfig({ pluginConfig: { agents: ["a"], agentProfiles: { "agent-b": { agentName: "BotB" } } } });
    assert.equal(isScopedAgent(resolveAgentConfig(cfg, "b"), "b"), false);
  });

  it("dmProactiveAgents falls back to global agents when dmProactive.agents empty", () => {
    assert.deepEqual(dmProactiveAgents({ agents: ["a", "b"], dmProactive: { agents: [] } }), ["a", "b"]);
    assert.deepEqual(dmProactiveAgents({ agents: ["a"], dmProactive: { agents: ["dm"] } }), ["dm"]);
    assert.deepEqual(dmProactiveAgents({ agents: ["a"] }), ["a"]);
    assert.deepEqual(dmProactiveAgents({}), []);
  });

  it("isScopedDmAgent: dmProactive.agents overrides global agents (586-set)", () => {
    // dmProactive.agents names 'dm' → only 'dm' is scoped in the DM lane.
    assert.equal(isScopedDmAgent({ agents: ["g"], dmProactive: { agents: ["dm"] } }, "dm"), true);
    assert.equal(isScopedDmAgent({ agents: ["g"], dmProactive: { agents: ["dm"] } }, "g"), false);
    // Empty dmProactive.agents → falls back to global cfg.agents.
    assert.equal(isScopedDmAgent({ agents: ["g"], dmProactive: { agents: [] } }, "g"), true);
    assert.equal(isScopedDmAgent({ agents: ["g"], dmProactive: { agents: [] } }, "dm"), false);
    // No dmProactive.agents → global agents.
    assert.equal(isScopedDmAgent({ agents: ["g"] }, "g"), true);
  });

  it("dmProactive.dayFitActivityPath default is empty string in defaultConfig", () => {
    const cfg = defaultConfig();
    assert.equal(cfg.dmProactive.dayFitActivityPath, "");
  });

  it("resolveAgentConfig merges dmProactive.dayFitActivityPath from profile override", () => {
    const cfg = resolveConfig({ pluginConfig: { dmProactive: { dayFitActivityPath: "/global/path" }, agentProfiles: { "agent-a": { dmProactive: { dayFitActivityPath: "/agent/path" } } } } });
    const agentCfg = resolveAgentConfig(cfg, "agent-a");
    assert.equal(agentCfg.dmProactive.dayFitActivityPath, "/agent/path");
    assert.equal(resolveAgentConfig(cfg, "other").dmProactive.dayFitActivityPath, "/global/path");
  });
});
