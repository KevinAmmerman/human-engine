import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import { createNaturalize, clearAllBubbleTimers } from "../lib/naturalize.js";
import { createGate } from "../lib/gate.js";
import * as state from "../lib/state.js";
import {
  makeReplyDispatchCtx,
  makeReplyDispatchEvent,
  makeReplyPayloadCtx,
  makeMessageReceivedCtx,
} from "./helpers/sdk-hook-ctx.js";

const cfg = {
  enabled: true,
  agents: ["test-agent"],
  agentName: "OpenClaw",
  socialMemory: { enabled: true },
};

const GROUP_SK = "agent:test-agent:whatsapp:group:123@g.us";

function makeEngine() {
  return {
    currentEpoch() {
      return 0;
    },
    async respond() {
      return { scheduled: [], superseded: false };
    },
  };
}

function makeDispatcher() {
  return {
    sendBlockReply: mock.fn(() => true),
    markComplete: mock.fn(),
  };
}

describe("hook-context contract (SDK-true ctx shapes)", () => {
  let naturalize;
  let gate;

  afterEach(() => {
    clearAllBubbleTimers();
  });

  beforeEach(() => {
    state.speakEpochBySession.clear();
    state.transcriptPeekBySession.clear();
    state.chatTypeBySession.clear();
    state.observedBySession.clear();
    state.senderBySession.clear();

    naturalize = createNaturalize({
      cfg,
      state,
      engine: makeEngine(),
      persona: {
        buildPersonaPrompt() { return ""; },
        buildPersonaPromptWithMemory() { return ""; },
      },
      socialMemory: null,
      log: { info() {}, warn() {}, debug() {} },
    });
    gate = createGate({
      cfg,
      state,
      engine: makeEngine(),
      persona: { buildPersonaPrompt() { return ""; } },
      socialMemory: null,
      log: { info() {}, warn() {}, debug() {} },
    });
  });

  describe("before_agent_reply → proactive.onInbound(ownReply)", () => {
    it("speak decision forwards one onInbound with ownReply:true, agentId from session key, empty text", async () => {
      const proactive = { onInbound: mock.fn() };
      const g = createGate({
        cfg, state, engine: { async decide() { return { decision: "speak", epoch: 1 }; } },
        persona: { buildPersonaPrompt() { return ""; } },
        socialMemory: null, log: { info() {}, warn() {}, debug() {} }, proactive,
      });
      state.chatTypeBySession.set(GROUP_SK, "group");
      const result = await g.onBeforeAgentReply(
        { cleanedBody: "Wann treffen wir uns?" },
        { sessionKey: GROUP_SK, agentId: "test-agent", senderId: "u1", senderName: "Nico" },
      );
      assert.equal(result, undefined);
      assert.equal(proactive.onInbound.mock.callCount(), 1);
      const [sk, opts] = proactive.onInbound.mock.calls[0].arguments;
      assert.equal(sk, GROUP_SK);
      assert.equal(opts.agentId, "test-agent");
      assert.equal(opts.ownReply, true);
      assert.equal(opts.text, "");
    });
  });

  describe("reply_dispatch (PluginHookReplyDispatchContext has no agentId/sessionKey)", () => {
    it("arms pre-speak (no epoch required) and binds the epoch at capture (plan 344)", () => {
      // 338 pinned arm-time epoch gating; 344 moves the gate to capture time because
      // reply_dispatch fires BEFORE before_agent_reply stashes the speak epoch.
      naturalize.onReplyDispatch(
        makeReplyDispatchEvent({ sessionKey: GROUP_SK, sendPolicy: "allow" }),
        makeReplyDispatchCtx({ dispatcher: makeDispatcher() }),
      );
      state.speakEpochBySession.set(GROUP_SK, { epoch: 1, ts: Date.now() });
      const result = naturalize.onReplyPayloadSending(
        { sessionKey: GROUP_SK, kind: "final", payload: { text: "Agent reply" } },
        makeReplyPayloadCtx({ sessionKey: GROUP_SK }),
      );
      assert.deepEqual(result, { cancel: true });
    });
  });

  describe("reply_payload_sending (PluginHookMessageContext has no agentId)", () => {
    it("captures and cancels with a real ctx when armed", () => {
      state.speakEpochBySession.set(GROUP_SK, { epoch: 1, ts: Date.now() });
      naturalize.onReplyDispatch(
        makeReplyDispatchEvent({ sessionKey: GROUP_SK, sendPolicy: "allow" }),
        makeReplyDispatchCtx({ dispatcher: makeDispatcher() }),
      );
      const result = naturalize.onReplyPayloadSending(
        { sessionKey: GROUP_SK, kind: "final", payload: { text: "Agent reply" } },
        makeReplyPayloadCtx({ sessionKey: GROUP_SK }),
      );
      assert.deepEqual(result, { cancel: true });
    });

    it("passes through for out-of-scope agent sessions", () => {
      const OTHER_SK = "agent:other:whatsapp:group:123@g.us";
      state.speakEpochBySession.set(OTHER_SK, { epoch: 1, ts: Date.now() });
      naturalize.onReplyDispatch(
        makeReplyDispatchEvent({ sessionKey: OTHER_SK, sendPolicy: "allow" }),
        makeReplyDispatchCtx({ dispatcher: makeDispatcher() }),
      );
      const result = naturalize.onReplyPayloadSending(
        { sessionKey: OTHER_SK, kind: "final", payload: { text: "Agent reply" } },
        makeReplyPayloadCtx({ sessionKey: OTHER_SK }),
      );
      assert.equal(result, undefined);
    });
  });

  describe("message_received (ctx has no isGroup, no agentId)", () => {
    it("labels a group session as group from the session key (plan 336 flip)", () => {
      gate.onMessageReceived({ text: "hi" }, makeMessageReceivedCtx({ sessionKey: GROUP_SK, senderId: "u1" }));
      assert.equal(state.chatTypeBySession.get(GROUP_SK), "group");
    });

    it("calls proactive.onInbound for a scoped group sk despite the SDK-true ctx having no agentId", () => {
      const proactive = { onInbound: mock.fn() };
      const g = createGate({
        cfg, state, engine: makeEngine(), persona: { buildPersonaPrompt() { return ""; } },
        socialMemory: null, log: { info() {}, warn() {}, debug() {} }, proactive,
      });
      g.onMessageReceived(
        { text: "Wann treffen wir uns?" },
        makeMessageReceivedCtx({ sessionKey: GROUP_SK, senderId: "u1" }),
      );
      assert.equal(proactive.onInbound.mock.callCount(), 1);
      assert.equal(proactive.onInbound.mock.calls[0].arguments[0], GROUP_SK);
      assert.equal(proactive.onInbound.mock.calls[0].arguments[1].agentId, "test-agent");
      assert.equal(proactive.onInbound.mock.calls[0].arguments[1].text, "Wann treffen wir uns?");
    });

    it("does not call proactive.onInbound for an out-of-scope agent session", () => {
      const proactive = { onInbound: mock.fn() };
      const g = createGate({
        cfg, state, engine: makeEngine(), persona: { buildPersonaPrompt() { return ""; } },
        socialMemory: null, log: { info() {}, warn() {}, debug() {} }, proactive,
      });
      g.onMessageReceived(
        { text: "hi" },
        makeMessageReceivedCtx({ sessionKey: "agent:other:whatsapp:group:123@g.us", senderId: "u1" }),
      );
      assert.equal(proactive.onInbound.mock.callCount(), 0);
    });
  });
});
