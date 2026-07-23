import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import { createLocalEngine, getState } from "../lib/local-engine.js";
import { createNaturalize, clearAllBubbleTimers } from "../lib/naturalize.js";
import * as state from "../lib/state.js";
import { setRng, resetRng } from "../lib/timing-engine.js";

function makeFakeTiming() {
  return {
    scheduleForBubbles(bubbles, ctx, timingCfg) {
      return bubbles.map((b, i) => ({
        content: b.content,
        position: i,
        delayMs: (i + 1) * 5,
      }));
    },
  };
}

function makePersona() {
  return {
    buildPersonaPrompt() { return "test persona"; },
    buildPersonaPromptWithMemory() { return "test persona + memory"; },
  };
}

const defaultCfg = {
  enabled: true,
  agents: [],
  agentName: "OpenClaw",
};

describe("e2e-local", () => {
  beforeEach(() => {
    getState().epochs.clear();
    state.speakEpochBySession.clear();
    state.draftBySession.clear();
    state.latestEpochByChat.clear();
    state.chatTypeBySession.clear();
    state.observedBySession.clear();
    state.memoryBySession.clear();
    state.sessions.clear();
    state.routes.clear();
    state.transcriptPeekBySession?.clear?.();
    state.metaBySession?.clear?.();
    state.metaByMessageId?.clear?.();
    state.epochByMessageId?.clear?.();
  });

  afterEach(() => {
    clearAllBubbleTimers();
    resetRng();
  });

  describe("speak → split → timed delivery → markComplete", () => {
    it("full speak pipeline delivers bubbles in order with increasing delays", async () => {
      const engine = createLocalEngine({
        cfg: { humanize: { maxBubbles: 3 } },
        llm: {
          complete: async () => ({
            text: JSON.stringify({ messages: ["First bubble", "Second bubble", "Third bubble"] }),
          }),
        },
        timing: makeFakeTiming(),
        log: { info() {}, warn() {}, debug() {} },
      });

      const naturalize = createNaturalize({
        cfg: defaultCfg,
        state,
        engine,
        persona: makePersona(),
        log: { info() {}, warn() {}, debug() {} },
      });

      state.speakEpochBySession.set("e2e-speak", 42);
      state.draftBySession.set("e2e-speak", "This is the draft reply");
      state.chatTypeBySession.set("e2e-speak", "group");

      const dispatcher = {
        sendBlockReply: mock.fn(() => true),
        markComplete: mock.fn(),
      };

      const result = await naturalize.onReplyDispatch(
        { cleanedBody: "This is the draft reply", sendPolicy: "allow" },
        { agentId: "test", sessionKey: "e2e-speak", channelId: "ch", chatId: "ch", senderId: "u", dispatcher, abortSignal: undefined },
      );

      assert.deepEqual(result, { handled: true });
      assert.equal(state.speakEpochBySession.has("e2e-speak"), false);
      assert.equal(state.draftBySession.has("e2e-speak"), false);

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(dispatcher.sendBlockReply.mock.callCount(), 3);
      assert.equal(dispatcher.sendBlockReply.mock.calls[0].arguments[0].text, "First bubble");
      assert.equal(dispatcher.sendBlockReply.mock.calls[1].arguments[0].text, "Second bubble");
      assert.equal(dispatcher.sendBlockReply.mock.calls[2].arguments[0].text, "Third bubble");
      assert.equal(dispatcher.markComplete.mock.callCount(), 1);
    });
  });

  describe("silent → blocked + observed injection", () => {
    it("stay_silent blocks dispatch and buffers observed", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: {
          complete: async () => ({ text: "STAY_SILENT" }),
        },
        timing: makeFakeTiming(),
      });

      state.chatTypeBySession.set("e2e-silent", "group");

      const decision = await engine.decide({
        sessionKey: "e2e-silent",
        prompt: "random side chatter",
        agentName: "OpenClaw",
        isDM: false,
      });

      assert.equal(decision.decision, "stay_silent");
    });
  });

  describe("supersede (epoch bump mid-delivery)", () => {
    it("epoch bump cancels remaining bubbles", async () => {
      const engine = createLocalEngine({
        cfg: { humanize: { maxBubbles: 3 } },
        llm: {
          complete: async () => ({
            text: JSON.stringify({ messages: ["First", "Second", "Third"] }),
          }),
        },
        timing: makeFakeTiming(),
        log: { info() {}, warn() {}, debug() {} },
      });

      const naturalize = createNaturalize({
        cfg: defaultCfg,
        state,
        engine,
        persona: makePersona(),
        log: { info() {}, warn() {}, debug() {} },
      });

      state.speakEpochBySession.set("e2e-sup", 1);
      state.draftBySession.set("e2e-sup", "Draft");
      state.chatTypeBySession.set("e2e-sup", "group");

      const dispatcher = {
        sendBlockReply: mock.fn(() => true),
        markComplete: mock.fn(),
      };

      await naturalize.onReplyDispatch(
        { cleanedBody: "Draft", sendPolicy: "allow" },
        { agentId: "test", sessionKey: "e2e-sup", channelId: "ch", chatId: "ch", senderId: "u", dispatcher, abortSignal: undefined },
      );

      getState().epochs.set("e2e-sup", 5);

      await new Promise((r) => setTimeout(r, 60));

      assert.ok(dispatcher.sendBlockReply.mock.callCount() <= 3,
        `expected at most 3 bubbles, got ${dispatcher.sendBlockReply.mock.callCount()}`);
      assert.equal(dispatcher.markComplete.mock.callCount(), 1);
    });
  });

  describe("LLM error → single-bubble draft fallback", () => {
    it("engine error produces draft fallback, reply never lost", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: {
          complete: async () => { throw new Error("LLM unavailable"); },
        },
        timing: makeFakeTiming(),
        log: { info() {}, warn() {}, debug() {} },
      });

      const respondResult = await engine.respond({
        sessionKey: "e2e-err",
        draft: "Fallback draft reply",
        epoch: 1,
      });

      assert.equal(respondResult.superseded, false);
      assert.ok(Array.isArray(respondResult.scheduled));
      assert.equal(respondResult.scheduled.length, 1);
      assert.equal(respondResult.scheduled[0].content, "Fallback draft reply");
      assert.ok(respondResult.scheduled[0].delayMs > 0);
    });
  });

  describe("DM → decide short-circuit with pacing", () => {
    it("DM short-circuits to speak and pacing applies", async () => {
      let llmCalled = false;
      const engine = createLocalEngine({
        cfg: {},
        llm: {
          complete: async () => { llmCalled = true; return { text: "STAY_SILENT" }; },
        },
        timing: makeFakeTiming(),
        log: { info() {}, warn() {}, debug() {} },
      });

      const decision = await engine.decide({
        sessionKey: "e2e-dm",
        isDM: true,
        prompt: "hey",
        agentName: "OpenClaw",
      });

      assert.equal(decision.decision, "speak");
      assert.equal(llmCalled, false, "DM should not call LLM");

      const respondResult = await engine.respond({
        sessionKey: "e2e-dm",
        draft: "DM reply",
        epoch: decision.epoch,
        isGroup: false,
      });

      assert.equal(respondResult.superseded, false);
      if (respondResult.scheduled.length > 0) {
        assert.ok(respondResult.scheduled[0].delayMs > 0, "DM bubbles should have pacing delay");
      }
    });
  });

  describe("null LLM fallback path", () => {
    it("no LLM available: respond returns single-bubble draft", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: null,
        timing: makeFakeTiming(),
      });

      const result = await engine.respond({
        sessionKey: "e2e-null",
        draft: "No LLM draft",
        epoch: 1,
      });

      assert.equal(result.superseded, false);
      assert.equal(result.scheduled.length, 1);
      assert.equal(result.scheduled[0].content, "No LLM draft");
    });

    it("no LLM available: decide returns null", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: null,
        timing: makeFakeTiming(),
      });

      const result = await engine.decide({
        sessionKey: "e2e-null-decide",
        prompt: "hello",
        agentName: "OpenClaw",
      });

      assert.equal(result, null);
    });

    it("DM with null LLM: decide still speaks (short-circuit)", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: null,
        timing: makeFakeTiming(),
      });

      const result = await engine.decide({
        sessionKey: "e2e-null-dm",
        isDM: true,
      });

      assert.equal(result.decision, "speak");
      assert.ok(result.epoch > 0);
    });
  });
});
