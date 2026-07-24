import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

    assert.equal(hooks.message_received?.length, 1);
    assert.equal(hooks.before_agent_run?.length, 1);
    assert.equal(hooks.message_sending?.length, 1);
    assert.equal(hooks.before_prompt_build?.length, 2);
    assert.equal(hooks.before_agent_reply?.length, 1);
    assert.equal(hooks.reply_dispatch?.length, 1);
    assert.equal(hooks.reply_payload_sending?.length, 1);
    assert.equal(hooks.gateway_start?.length, 1);
    assert.equal(Object.keys(hooks).length, 8);

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

    assert.equal(hooks.message_received?.length, 1);
    assert.equal(hooks.before_agent_run?.length, 1);
    assert.equal(hooks.message_sending?.length, 1);
    assert.equal(hooks.before_prompt_build?.length, 2);
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

    assert.equal(hooks.before_prompt_build?.length, 2);
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
});
