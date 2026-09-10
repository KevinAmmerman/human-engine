import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, statSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bubbleTimers } from "../lib/naturalize.js";

process.env.HUMAN_ENGINE_STATE_DIR = mkdtempSync(join(tmpdir(), "he-test-state-"));

await import("./helpers/ensure-plugin-sdk-shim.mjs");
const { default: pluginEntry } = await import("../index.js");

describe("register() from index.js", () => {
  function makeFakeApi(opts = {}) {
    const { withLLM = false, socialMemoryEnabled = false } = opts;
    const warnings = [];
    const hooks = {};
    const commands = [];

    const api = {
      pluginConfig: {
        enabled: true,
        agents: [],
        socialMemory: { enabled: socialMemoryEnabled },
      },
      config: {},
      runtime: {
        llm: withLLM ? { complete: async () => ({ text: "SPEAK" }) } : null,
      },
      logger: {
        info() {},
        warn(msg) {
          warnings.push(msg);
        },
        debug() {},
        error() {},
      },
      on(name, fn) {
        if (!hooks[name]) hooks[name] = [];
        hooks[name].push(fn);
      },
      registerCommand(def) {
        commands.push(def);
      },
    };

    return { api, hooks, warnings, commands };
  }

  it("does not throw; registers expected hooks and command; warns on degraded mode", () => {
    const { api, hooks, warnings, commands } = makeFakeApi({ withLLM: false });

    assert.doesNotThrow(() => {
      pluginEntry.register(api);
    });

    assert.equal(hooks.message_received?.length, 4);
    assert.equal(hooks.before_agent_run?.length, 1);
    assert.equal(hooks.message_sending?.length, 2);
    assert.equal(hooks.before_prompt_build?.length, 4);
    assert.equal(hooks.before_agent_reply?.length, 1);
    assert.equal(hooks.reply_dispatch?.length, 1);
    assert.equal(hooks.reply_payload_sending?.length, 1);
    assert.equal(hooks.gateway_start?.length, 1);
    assert.equal(hooks.gateway_stop?.length, 1);
    assert.equal(Object.keys(hooks).length, 9);

    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, "soul");

    assert.ok(warnings.some((w) => /degraded mode/i.test(w)));
  });

  it("with llm stub: no degraded warn, same hook/command structure", () => {
    const { api, hooks, warnings, commands } = makeFakeApi({ withLLM: true });

    assert.doesNotThrow(() => {
      pluginEntry.register(api);
    });

    assert.equal(warnings.filter((w) => /degraded mode/i.test(w)).length, 0);

    assert.equal(hooks.message_received?.length, 4);
    assert.equal(hooks.before_agent_run?.length, 1);
    assert.equal(hooks.message_sending?.length, 2);
    assert.equal(hooks.before_prompt_build?.length, 4);
    assert.equal(hooks.before_agent_reply?.length, 1);
    assert.equal(hooks.reply_dispatch?.length, 1);
    assert.equal(hooks.reply_payload_sending?.length, 1);
    assert.equal(hooks.gateway_start?.length, 1);

    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, "soul");
  });

  it("with socialMemory enabled + llm stub", () => {
    const { api, hooks, commands } = makeFakeApi({ withLLM: true, socialMemoryEnabled: true });

    assert.doesNotThrow(() => {
      pluginEntry.register(api);
    });

    assert.equal(hooks.before_prompt_build?.length, 4);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, "soul");
  });

  it("invoking every captured handler with minimal ctx does not throw", async () => {
    const { api, hooks } = makeFakeApi({ withLLM: false });

    pluginEntry.register(api);

    const ctx = { agentId: "x", sessionKey: "s", senderId: "user" };

    let result;

    result = await hooks.message_received[0]({ text: "hello" }, ctx);
    assert.equal(result, undefined);

    result = await hooks.before_agent_run[0]({ prompt: "hi" }, ctx);
    assert.ok(result === undefined || result === null || typeof result === "object");

    result = await hooks.message_sending[0]({ content: "Your message could not be sent" }, ctx);
    assert.equal(result, undefined);

    result = await hooks.before_prompt_build[0]({ prompt: "hi" }, ctx);
    assert.ok(result === undefined || result === null || typeof result === "object");

    result = await hooks.before_prompt_build[1]({ messages: [] }, ctx);
    assert.equal(result, undefined);

    result = await hooks.before_agent_reply[0]({ cleanedBody: "draft" }, ctx);
    assert.equal(result, undefined);

    result = await hooks.reply_dispatch[0]({ sendPolicy: "deny" }, ctx);
    assert.equal(result, undefined);

    result = await hooks.reply_payload_sending[0]({ sessionKey: "s", kind: "final", payload: { text: "hi" } }, ctx);
    assert.equal(result, undefined);

    result = await hooks.gateway_start[0]();
    assert.equal(result, undefined);
  });

  it("gateway_stop clears naturalize bubble timers", () => {
    const { api, hooks } = makeFakeApi({ withLLM: true });

    pluginEntry.register(api);

    bubbleTimers.set("agent:test-agent:whatsapp:group:123@g.us", [setTimeout(() => {}, 1000)]);
    try {
      hooks.gateway_stop[0]();
      assert.equal(bubbleTimers.size, 0);
    } finally {
      bubbleTimers.clear();
    }
  });

  it("register() enforces 0700 on stateDir and its subdirectories (idempotent)", () => {
    const dir = mkdtempSync(join(tmpdir(), "he-state-perms-"));
    mkdirSync(join(dir, "social-memory"), { recursive: true, mode: 0o777 });
    mkdirSync(join(dir, "observed"), { recursive: true, mode: 0o777 });
    const prev = process.env.HUMAN_ENGINE_STATE_DIR;
    process.env.HUMAN_ENGINE_STATE_DIR = dir;
    try {
      const { api } = makeFakeApi({ withLLM: false });
      assert.doesNotThrow(() => pluginEntry.register(api));
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(join(dir, "social-memory")).mode & 0o777, 0o700);
      assert.equal(statSync(join(dir, "observed")).mode & 0o777, 0o700);
    } finally {
      process.env.HUMAN_ENGINE_STATE_DIR = prev;
    }
  });

  describe("/soul voice command (self-voice governance)", () => {
    function registerWithVoice() {
      const { api, commands } = makeFakeApi({ withLLM: false });
      api.pluginConfig.selfVoice = { enabled: true, refreshMinutes: 60, minVolume: 3 };
      pluginEntry.register(api);
      return { api, commands };
    }
    function stateDir() {
      return process.env.HUMAN_ENGINE_STATE_DIR;
    }
    function writeSelfVoiceState(agentId, { active = null, pending = null } = {}) {
      const dir = join(stateDir(), "self-voice");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, agentId + ".json"),
        JSON.stringify({ version: 1, activeCard: active, pendingCard: pending, updatedAt: Date.now() }),
      );
    }
    function readSelfVoiceState(agentId) {
      return JSON.parse(readFileSync(join(stateDir(), "self-voice", agentId + ".json"), "utf8"));
    }

    it("voice without pending/active returns a friendly empty-state text", async () => {
      const { commands } = registerWithVoice();
      const cmd = commands[0];
      assert.equal(cmd.name, "soul");
      const result = await cmd.handler({ agentId: "sv-agent", args: "voice" });
      assert.ok(/no self-voice yet/i.test(result.text), "friendly empty state");
    });

    it("voice accept without pending returns a friendly noop text and does not write state", async () => {
      const { commands } = registerWithVoice();
      const result = await commands[0].handler({ agentId: "sv-nopend", args: "voice accept" });
      assert.ok(/nothing to accept/i.test(result.text), "noop accept text");
      const file = join(stateDir(), "self-voice", "sv-nopend.json");
      const exists = (() => { try { readFileSync(file, "utf8"); return true; } catch { return false; } })();
      assert.equal(exists, false, "noop accept must not create a state file");
    });

    it("voice accept with pending moves it to active and returns the N→M accept text", async () => {
      writeSelfVoiceState("sv-accept", { active: "old card (18 chars)", pending: "brand new pending card" });
      const { commands } = registerWithVoice();
      const result = await commands[0].handler({ agentId: "sv-accept", args: "voice accept" });
      assert.ok(/stimme \u00fcbernommen/i.test(result.text), "accept text present");
      const state = readSelfVoiceState("sv-accept");
      assert.equal(state.activeCard, "brand new pending card", "pending promoted to active");
      assert.equal(state.pendingCard, null, "pending cleared");
    });

    it("voice reset clears active and returns a confirmation", async () => {
      writeSelfVoiceState("sv-reset", { active: "some active card", pending: null });
      const { commands } = registerWithVoice();
      const result = await commands[0].handler({ agentId: "sv-reset", args: "voice reset" });
      assert.ok(/self-voice reset/i.test(result.text), "reset confirmation");
      const state = readSelfVoiceState("sv-reset");
      assert.equal(state.activeCard, null, "active cleared after reset");
      assert.equal(state.pendingCard, null, "pending cleared after reset");
    });

    it("voice reset without any voice returns a friendly noop", async () => {
      const { commands } = registerWithVoice();
      const result = await commands[0].handler({ agentId: "sv-novoice", args: "voice reset" });
      assert.ok(/nothing to reset/i.test(result.text), "noop reset text");
    });

    it("enhance path stays byte-identical (non-voice subcommand forwards to enhance usage)", async () => {
      const { commands } = registerWithVoice();
      const result = await commands[0].handler({ agentId: "sv-agent", args: "garbage" });
      assert.ok(/Usage: \/soul enhance/i.test(result.text), "unknown subcommand keeps enhance usage text");
    });
  });
});
