import assert from "node:assert/strict";
import { describe, it, before, beforeEach } from "node:test";
import { createGate } from "../lib/gate.js";
import { createNaturalize, clearAllBubbleTimers } from "../lib/naturalize.js";
import * as state from "../lib/state.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DISABLED_CFG = { enabled: false, agents: [], agentName: "Test" };

function makeEngine() {
  return {
    async decide(opts) { return { decision: "speak", epoch: 1 }; },
    openThread() { return { id: "th-1" }; },
    currentEpoch() { return 0; },
    async respond(opts) { return { scheduled: [{ content: "bubble", position: 0, delayMs: 10 }], superseded: false }; },
  };
}

const persona = {
  buildPersonaPrompt() { return "prompt"; },
  buildPersonaPromptWithMemory() { return "prompt+mem"; },
};

const log = { info() {}, warn() {}, debug() {}, error() {} };

describe("harness — kill-switch enabled:false", () => {
  let gate, naturalize;

  before(() => {
    gate = createGate({ cfg: DISABLED_CFG, state, engine: makeEngine(), persona: { buildPersonaPrompt() { return ""; } }, log });
    naturalize = createNaturalize({ cfg: DISABLED_CFG, state, engine: makeEngine(), persona, log });
  });

  beforeEach(() => {
    state.observedBySession.clear();
    state.memoryBySession.clear();
    state.speakEpochBySession.clear();
    state.chatTypeBySession.clear();
  });

  it("onMessageReceived returns undefined", () => {
    const result = gate.onMessageReceived({}, { sessionKey: "sk", isGroup: false });
    assert.equal(result, undefined);
  });

  it("onBeforeAgentRun returns undefined", async () => {
    const result = await gate.onBeforeAgentRun(
      { prompt: "hi", messages: [] },
      { agentId: "test", sessionKey: "sk", channelId: "ch", chatId: "ch", senderId: "u", senderName: "User" },
    );
    assert.equal(result, undefined);
  });

  it("onBeforePromptBuild returns undefined", () => {
    const result = gate.onBeforePromptBuild({ prompt: "hi" }, { agentId: "test", sessionKey: "sk" });
    assert.equal(result, undefined);
  });

  it("onBeforeAgentReply returns undefined", async () => {
    const result = await gate.onBeforeAgentReply({ cleanedBody: "reply" }, { agentId: "test", sessionKey: "sk" });
    assert.equal(result, undefined);
  });

  it("onReplyDispatch returns undefined", async () => {
    const result = await naturalize.onReplyDispatch(
      { cleanedBody: "reply", sendPolicy: "allow" },
      { agentId: "test", sessionKey: "sk" },
    );
    assert.equal(result, undefined);
  });

  it("onReplyPayloadSending returns undefined", () => {
    const result = naturalize.onReplyPayloadSending(
      { sessionKey: "sk", kind: "final", payload: { text: "reply" } },
      { agentId: "test", sessionKey: "sk" },
    );
    assert.equal(result, undefined);
  });
});

describe("harness — agent scoping", () => {
  let gate;

  before(() => {
    const scopedCfg = { enabled: true, agents: ["hori-wa"], agentName: "Test" };
    gate = createGate({
      cfg: scopedCfg, state,
      engine: {
        async decide(opts) {
          return { decision: "speak", epoch: 1 };
        },
      },
      persona: { buildPersonaPrompt() { return ""; } },
      log,
    });
  });

  beforeEach(() => {
    state.chatTypeBySession.clear();
    state.speakEpochBySession.clear();
    state.memoryBySession.clear();
  });

  it("unscoped agent (main) returns undefined", async () => {
    const result = await gate.onBeforeAgentRun(
      { prompt: "hi", messages: [] },
      { agentId: "main", sessionKey: "sk-main", channelId: "ch", chatId: "ch", senderId: "u", senderName: "User" },
    );
    assert.equal(result, undefined);
  });

  it("scoped agent (hori-wa) engages gate", async () => {
    const result = await gate.onBeforeAgentReply(
      { cleanedBody: "hello" },
      { agentId: "hori-wa", sessionKey: "sk-hori", channelId: "ch", chatId: "ch", senderId: "u", senderName: "User" },
    );
    assert.equal(result, undefined);
    assert.equal(state.speakEpochBySession.get("sk-hori")?.epoch, 1);
  });
});

describe("harness — fail-open error injection", () => {
  let gate, naturalize;

  before(() => {
    const throwingEngine = {
      decide: async () => { throw new Error("engine crash"); },
      respond: async () => { throw new Error("respond fail"); },
    };
    gate = createGate({
      cfg: { enabled: true, agents: [], agentName: "Test" },
      state,
      engine: throwingEngine,
      persona: { buildPersonaPrompt() { return ""; } },
      log,
    });

    const throwingPersona = {
      buildPersonaPrompt() { throw new Error("persona boom"); },
      buildPersonaPromptWithMemory() { throw new Error("persona+mem boom"); },
    };
    naturalize = createNaturalize({
      cfg: { enabled: true, agents: [], agentName: "Test" },
      state, engine: throwingEngine, persona: throwingPersona, log,
    });
  });

  beforeEach(() => {
    state.chatTypeBySession.clear();
    state.memoryBySession.clear();
    state.speakEpochBySession.clear();
  });

  it("onBeforeAgentRun returns undefined on thrown error (engine.decide throws)", async () => {
    const result = await gate.onBeforeAgentRun(
      { prompt: "hi", messages: [] },
      { agentId: "test", sessionKey: "sk", channelId: "ch", chatId: "ch", senderId: "u", senderName: "User" },
    );
    assert.equal(result, undefined);
  });

  it("onReplyDispatch returns undefined on thrown error", async () => {
    state.speakEpochBySession.set("sk", 1);
    const result = await naturalize.onReplyDispatch(
      { cleanedBody: "draft", sendPolicy: "allow" },
      { agentId: "test", sessionKey: "sk", channelId: "ch", chatId: "ch" },
    );
    assert.equal(result, undefined);
  });
});

describe("harness — no-residue static proof", () => {
  it("plugin registers exactly the expected hooks + commands + lifecycle", async () => {
    const root = path.resolve(fileURLToPath(import.meta.url), "..");
    const indexPath = path.resolve(root, "..", "index.js");
    const content = fs.readFileSync(indexPath, "utf8");

    const hookMatches = [...content.matchAll(/\.on\s*\(\s*["'`](.+?)["'`]\s*,/g)];
    const commandMatches = [...content.matchAll(/registerCommand\s*\(\s*\{[^}]*?name\s*:\s*["'`](.+?)["'`]/gs)];

    const hooks = hookMatches.filter((m) => m[1] !== "gateway_start" && m[1] !== "gateway_stop").map((m) => m[1]).sort();
    const commands = commandMatches.map((m) => m[1]).sort();

    assert.deepEqual(hooks, [
      "before_agent_reply",
      "before_agent_run",
      "before_prompt_build",
      "before_prompt_build",
      "message_received",
      "message_sending",
      "reply_dispatch",
      "reply_payload_sending",
    ], "hook snapshot mismatch");
    assert.deepEqual(commands, ["soul"], "command snapshot mismatch (connect removed)");
    assert.equal(hookMatches.filter((m) => m[1] === "gateway_start").length, 1, "gateway_start lifecycle hook registered");
    assert.equal(hookMatches.filter((m) => m[1] === "gateway_stop").length, 1, "gateway_stop lifecycle hook registered");
  });

  it("no references to openclaw/dist in lib/ or index.js", () => {
    const root = path.resolve(fileURLToPath(import.meta.url), "../..");
    const files = [
      "index.js",
      "lib/config.js",
      "lib/gate.js",
      "lib/naturalize.js",
      "lib/state.js",
      "lib/messages.js",
      "lib/persona.js",
      "lib/voice-card.js",
      "lib/soul.js",
      "lib/autoconfig.js",
      "lib/timing-engine.js",
      "lib/local-engine.js",
      "lib/local-prompts.js",
    ];
    for (const f of files) {
      const content = fs.readFileSync(path.resolve(root, f), "utf8");
      assert.ok(!content.includes("openclaw/dist"), `file ${f} references openclaw/dist`);
    }
  });

  it("no references to fetch or WebSocket in lib/ or index.js", () => {
    const root = path.resolve(fileURLToPath(import.meta.url), "../..");
    const files = [
      "index.js",
      "lib/config.js",
      "lib/gate.js",
      "lib/naturalize.js",
      "lib/state.js",
      "lib/messages.js",
      "lib/persona.js",
      "lib/voice-card.js",
      "lib/soul.js",
      "lib/autoconfig.js",
      "lib/timing-engine.js",
      "lib/local-engine.js",
      "lib/local-prompts.js",
      "lib/anti-tell.js",
      "lib/style-stats.js",
    ];
    for (const f of files) {
      const content = fs.readFileSync(path.resolve(root, f), "utf8");
      const nofetch = !content.includes("fetch(");
      const nows = !content.includes("WebSocket");
      assert.ok(nofetch && nows, `file ${f} contains fetch or WebSocket`);
    }
  });
});
