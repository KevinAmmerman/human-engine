import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { warnStartupConfig } from "../lib/autoconfig.js";

function collect() {
  const warned = [];
  const log = {
    info() {},
    warn(msg) { warned.push(String(msg)); },
    debug() {},
  };
  return { warned, log };
}

describe("autoconfig", () => {
  describe("warnStartupConfig", () => {
    it("warns about no API key and Telegram reminder always", () => {
      const { warned, log } = collect();
      warnStartupConfig({}, {}, log);
      assert.ok(warned.some((w) => w.includes("no API key needed")));
      assert.ok(warned.some((w) => w.includes("BotFather")));
    });

    it("warns when hooks.allowConversationAccess is missing", () => {
      const { warned, log } = collect();
      warnStartupConfig({}, {}, log);
      assert.ok(warned.some((w) => w.includes("allowConversationAccess")));
    });

    it("does not warn when hooks.allowConversationAccess is set", () => {
      const { warned, log } = collect();
      warnStartupConfig({}, { hooks: { allowConversationAccess: true } }, log);
      assert.ok(!warned.some((w) => w.includes("allowConversationAccess")));
    });

    it("does not throw on missing host config", () => {
      const { log } = collect();
      assert.doesNotThrow(() => warnStartupConfig({}, undefined, log));
    });

    it("autoconfig opt-in is warnings-only advisory: no channel changes, no dead-model keys", () => {
      const { warned, log } = collect();
      warnStartupConfig({ decide: { model: "gpt-4o" }, humanize: { model: "gpt-4o" } }, { hooks: { allowConversationAccess: true } }, log);
      assert.ok(!warned.some((w) => w.includes("model") && w.includes("allowModelOverride")));
      assert.ok(!warned.some((w) => w.includes("typingMode")));
    });

    it("profile without contactsPath warns: sender names fall back to member-XXXX", () => {
      const { warned, log } = collect();
      warnStartupConfig({ agentProfiles: { "agent-c": { agentName: "C", soulPath: "/tmp/s.md" } } }, {}, log);
      assert.ok(warned.some((w) => w.includes('agentProfiles["agent-c"]') && w.includes("contactsPath") && w.includes("member-XXXX")));
    });

    it("profile WITH contactsPath does not warn about contactsPath", () => {
      const { warned, log } = collect();
      warnStartupConfig({ agentProfiles: { "agent-c": { contactsPath: "/tmp/c.md", soulPath: "/tmp/s.md" } } }, {}, log);
      assert.ok(!warned.some((w) => w.includes('agentProfiles["agent-c"]') && w.includes("contactsPath")));
    });

    it("profile without soulPath warns about global SOUL fallback", () => {
      const { warned, log } = collect();
      warnStartupConfig({ agentProfiles: { "agent-c": { contactsPath: "/tmp/c.md" } } }, {}, log);
      assert.ok(warned.some((w) => w.includes('agentProfiles["agent-c"]') && w.includes("soulPath") && w.includes("global SOUL")));
    });

    it("profile WITH soulPath does not warn about soulPath", () => {
      const { warned, log } = collect();
      warnStartupConfig({ agentProfiles: { "agent-c": { contactsPath: "/tmp/c.md", soulPath: "/tmp/s.md" } } }, {}, log);
      assert.ok(!warned.some((w) => w.includes('agentProfiles["agent-c"]') && w.includes("soulPath")));
    });

    it("profile for agent NOT in allowlist warns profile is inert", () => {
      const { warned, log } = collect();
      warnStartupConfig({ agents: ["agent-a"], agentProfiles: { "agent-c": { contactsPath: "/tmp/c.md", soulPath: "/tmp/s.md" } } }, {}, log);
      assert.ok(warned.some((w) => w.includes("profile exists but agent not in agents allowlist")));
    });

    it("profile for agent IN allowlist does not warn inert", () => {
      const { warned, log } = collect();
      warnStartupConfig({ agents: ["agent-c"], agentProfiles: { "agent-c": { contactsPath: "/tmp/c.md", soulPath: "/tmp/s.md" } } }, {}, log);
      assert.ok(!warned.some((w) => w.includes("profile exists but agent not in agents allowlist")));
    });

    it("agent in allowlist WITHOUT profile warns it runs on GLOBAL identity", () => {
      const { warned, log } = collect();
      warnStartupConfig({ agents: ["agent-a", "agent-c"], agentProfiles: { "agent-a": { contactsPath: "/tmp/a.md" } } }, {}, log);
      assert.ok(warned.some((w) => w.includes('agent "agent-c" runs on GLOBAL identity (no profile)')));
    });

    it("allowlist agent WITH profile does not warn about global identity", () => {
      const { warned, log } = collect();
      warnStartupConfig({ agents: ["agent-c"], agentProfiles: { "agent-c": { contactsPath: "/tmp/c.md" } } }, {}, log);
      assert.ok(!warned.some((w) => w.includes("runs on GLOBAL identity (no profile)")));
    });

    it("naturalize.disableDM + perSessionCard:false combination warns card collapses", () => {
      const { warned, log } = collect();
      warnStartupConfig({ naturalize: { disableDM: true }, socialLearning: { perSessionCard: false } }, {}, log);
      assert.ok(warned.some((w) => w.includes("naturalize.disableDM") && w.includes("perSessionCard")));
    });

    it("disableDM alone does not warn about the card combination", () => {
      const { warned, log } = collect();
      warnStartupConfig({ naturalize: { disableDM: true }, socialLearning: { perSessionCard: true } }, {}, log);
      assert.ok(!warned.some((w) => w.includes("naturalize.disableDM") && w.includes("perSessionCard")));
    });

    it("new validation rules never throw and never write files", () => {
      const { warned, log } = collect();
      const cfg = {
        agents: ["agent-a"],
        agentProfiles: {
          "agent-a": { contactsPath: "/tmp/a.md" },
          "agent-c": { contactsPath: "/tmp/c.md" },
        },
        naturalize: { disableDM: true },
        socialLearning: { perSessionCard: false },
      };
      assert.doesNotThrow(() => warnStartupConfig(cfg, {}, log));
      assert.ok(warned.length > 0);
    });
  });
});
