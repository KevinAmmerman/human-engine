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
    state.draftBySession.clear();
    state.latestEpochByChat.clear();
    state.metaBySession.clear();

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

  describe("reply_dispatch (PluginHookReplyDispatchContext has no agentId/sessionKey)", () => {
    it("does not arm a dispatcher with the real ctx (pins drift; plan 338 flips this)", () => {
      state.speakEpochBySession.set(GROUP_SK, { epoch: 1, ts: Date.now() });
      const dispatchResult = naturalize.onReplyDispatch(
        makeReplyDispatchEvent({ sessionKey: GROUP_SK, sendPolicy: "allow" }),
        makeReplyDispatchCtx({ dispatcher: makeDispatcher() }),
      );
      assert.equal(dispatchResult, undefined);
      const payloadResult = naturalize.onReplyPayloadSending(
        { sessionKey: GROUP_SK, kind: "final", payload: { text: "Agent reply" } },
        makeReplyPayloadCtx({ sessionKey: GROUP_SK }),
      );
      assert.equal(payloadResult, undefined);
    });
  });

  describe("reply_payload_sending (PluginHookMessageContext has no agentId)", () => {
    it("passes through with the real ctx even with a dispatcher stashed (scope check bails)", () => {
      state.speakEpochBySession.set(GROUP_SK, { epoch: 1, ts: Date.now() });
      naturalize.onReplyDispatch(
        makeReplyDispatchEvent({ sessionKey: GROUP_SK, sendPolicy: "allow" }),
        { ...makeReplyDispatchCtx({ dispatcher: makeDispatcher() }), agentId: "test-agent", sessionKey: GROUP_SK },
      );
      const result = naturalize.onReplyPayloadSending(
        { sessionKey: GROUP_SK, kind: "final", payload: { text: "Agent reply" } },
        makeReplyPayloadCtx({ sessionKey: GROUP_SK }),
      );
      assert.equal(result, undefined);
    });
  });

  describe("message_received (ctx has no isGroup)", () => {
    it("labels a group session as dm today (pins mislabel; plan 336 flips this)", () => {
      gate.onMessageReceived({ text: "hi" }, makeMessageReceivedCtx({ sessionKey: GROUP_SK, senderId: "u1" }));
      assert.equal(state.chatTypeBySession.get(GROUP_SK), "dm");
    });
  });
});
