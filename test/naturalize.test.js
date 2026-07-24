import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import { createNaturalize, clearAllBubbleTimers } from "../lib/naturalize.js";
import * as state from "../lib/state.js";

const cfg = {
  enabled: true,
  agents: [],
  agentName: "OpenClaw",
  socialMemory: { enabled: true },
};

function makeEngine() {
  return {
    currentEpoch() {
      return 0;
    },
    async respond(opts) {
      return {
        scheduled: [
          { content: "Bubble one", position: 0, delayMs: 10 },
          { content: "Bubble two", position: 1, delayMs: 20 },
        ],
        superseded: false,
      };
    },
  };
}

function makeDefaultCtx(overrides = {}) {
  return {
    agentId: "test-agent",
    sessionKey: "session-nat",
    channelId: "ch-1",
    chatId: "chat-1",
    ...overrides,
  };
}

function makeReplyEvent(overrides = {}) {
  return {
    cleanedBody: "This is the draft reply",
    sendPolicy: "allow",
    ...overrides,
  };
}

function makeSocialMemoryStub() {
  const people = {};
  return {
    ingest: (scope, entry) => {
      if (!people[scope]) people[scope] = [];
      people[scope].push(entry);
    },
    recall: () => "",
    _people: people,
  };
}

describe("naturalize", () => {
  let naturalize;

  afterEach(() => {
    clearAllBubbleTimers();
  });

  beforeEach(() => {
    state.speakEpochBySession.clear();
    state.silentEpochBySession.clear();
    state.transcriptPeekBySession.clear();
    state.draftBySession.clear();
    state.latestEpochByChat.clear();
    state.metaBySession.clear();
    state.routes.clear();
    state.sessions.clear();
    state.draftBySession.clear();

    naturalize = createNaturalize({
      cfg,
      state,
      engine: makeEngine(),
      persona: {
        buildPersonaPrompt() { return "prompt"; },
        buildPersonaPromptWithMemory() { return "prompt+mem"; },
      },
      socialMemory: makeSocialMemoryStub(),
      log: { info() {}, warn() {}, debug() {} },
    });
  });

  describe("onBeforeAgentReply", () => {
    it("stashes draft when epoch exists", () => {
      state.speakEpochBySession.set("session-nat", 42);
      const result = naturalize.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(result, undefined);
      assert.equal(state.draftBySession.get("session-nat"), "This is the draft reply");
    });

    it("does not stash when no epoch", () => {
      const result = naturalize.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(state.draftBySession.has("session-nat"), false);
    });

    it("does not stash when draft empty", () => {
      state.speakEpochBySession.set("session-nat", 42);
      const result = naturalize.onBeforeAgentReply({ cleanedBody: "" }, makeDefaultCtx());
      assert.equal(state.draftBySession.has("session-nat"), false);
    });

    it("returns undefined on unscoped agent", () => {
      const scopedNat = createNaturalize({
        cfg: { ...cfg, agents: ["other"] },
        state, engine: makeEngine(),
        persona: {
          buildPersonaPrompt() { return "prompt"; },
          buildPersonaPromptWithMemory() { return "prompt+mem"; },
        },
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn() {}, debug() {} },
      });
      const result = scopedNat.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(result, undefined);
    });
  });

  describe("silentEpoch TTL", () => {
    it("fresh silent flag silences the reply", () => {
      state.silentEpochBySession.set("session-nat", { epoch: 1, ts: Date.now() });
      const result = naturalize.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.deepEqual(result, { handled: true });
      assert.equal(state.silentEpochBySession.has("session-nat"), false);
    });

    it("stale silent flag expires and does not silence the next speak turn", () => {
      state.silentEpochBySession.set("session-nat", { epoch: 1, ts: Date.now() - 120000 });
      state.speakEpochBySession.set("session-nat", 42);
      const result = naturalize.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(result, undefined);
      assert.equal(state.silentEpochBySession.has("session-nat"), false);
      assert.equal(state.draftBySession.get("session-nat"), "This is the draft reply");
    });

    it("TTL is configurable via cfg.gate.silentTtlMs", () => {
      const shortNat = createNaturalize({
        cfg: { ...cfg, gate: { silentTtlMs: 1000 } },
        state,
        engine: makeEngine(),
        persona: {
          buildPersonaPrompt() { return "prompt"; },
          buildPersonaPromptWithMemory() { return "prompt+mem"; },
        },
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn() {}, debug() {} },
      });
      state.silentEpochBySession.set("session-nat", { epoch: 1, ts: Date.now() - 5000 });
      const result = shortNat.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(result, undefined);
      assert.equal(state.silentEpochBySession.has("session-nat"), false);
    });

    it("legacy numeric silent flag (no timestamp) is treated as stale", () => {
      state.silentEpochBySession.set("session-nat", 1);
      const result = naturalize.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(result, undefined);
      assert.equal(state.silentEpochBySession.has("session-nat"), false);
    });
  });

  describe("onReplyDispatch", () => {
    it("returns {handled:true} on scheduled respond with bubbles", async () => {
      state.speakEpochBySession.set("session-nat", 42);
      state.draftBySession.set("session-nat", "Draft text");

      const dispatcher = {
        sendBlockReply: mock.fn(() => true),
        markComplete: mock.fn(),
      };

      const event = makeReplyEvent();
      const ctx = makeDefaultCtx({ dispatcher, abortSignal: undefined });

      const result = await naturalize.onReplyDispatch(event, ctx);
      assert.deepEqual(result, { handled: true });
      assert.equal(state.speakEpochBySession.has("session-nat"), false);
      assert.equal(state.draftBySession.has("session-nat"), false);
    });

    it("awaits bubbles and dispatches them", async () => {
      state.speakEpochBySession.set("session-nat", 42);
      state.draftBySession.set("session-nat", "Draft");

      const dispatcher = {
        sendBlockReply: mock.fn(() => true),
        markComplete: mock.fn(),
      };

      await naturalize.onReplyDispatch(
        makeReplyEvent(),
        makeDefaultCtx({ dispatcher, abortSignal: undefined }),
      );

      await new Promise((r) => setTimeout(r, 60));

      assert.equal(dispatcher.sendBlockReply.mock.callCount(), 2);
      assert.equal(dispatcher.sendBlockReply.mock.calls[0].arguments[0].text, "Bubble one");
      assert.equal(dispatcher.sendBlockReply.mock.calls[1].arguments[0].text, "Bubble two");
      assert.equal(dispatcher.markComplete.mock.callCount(), 1);
    });

    it("returns undefined when no speak epoch", async () => {
      const result = await naturalize.onReplyDispatch(makeReplyEvent(), makeDefaultCtx());
      assert.equal(result, undefined);
    });

    it("returns undefined when engine returns superseded", async () => {
      state.speakEpochBySession.set("session-nat", 42);
      state.draftBySession.set("session-nat", "Draft");

      const supEngine = {
        currentEpoch() { return 0; },
        async respond() {
          return { superseded: true };
        },
      };
      const supNat = createNaturalize({
        cfg, state, engine: supEngine,
        persona: {
          buildPersonaPrompt() { return "prompt"; },
          buildPersonaPromptWithMemory() { return "prompt+mem"; },
        },
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn() {}, debug() {} },
      });

      state.speakEpochBySession.set("session-nat", 42);
      state.draftBySession.set("session-nat", "Draft");
      const result = await supNat.onReplyDispatch(makeReplyEvent(), makeDefaultCtx());
      assert.equal(result, undefined);
    });

    it("does not respond when sendPolicy is not allow", async () => {
      state.speakEpochBySession.set("session-nat", 42);
      state.draftBySession.set("session-nat", "Draft");

      const result = await naturalize.onReplyDispatch(
        { ...makeReplyEvent(), sendPolicy: "deny" },
        makeDefaultCtx(),
      );
      assert.equal(result, undefined);
    });

    it("returns undefined when no dispatcher", async () => {
      state.speakEpochBySession.set("session-nat", 42);
      state.draftBySession.set("session-nat", "Draft");

      const result = await naturalize.onReplyDispatch(
        makeReplyEvent(),
        makeDefaultCtx({ dispatcher: undefined }),
      );
      assert.equal(result, undefined);
    });

    it("epoch bump mid-delivery cancels remaining bubbles", async () => {
      state.speakEpochBySession.set("session-nat", 42);
      state.draftBySession.set("session-nat", "Draft");

      let epochCounter = 0;
      const bumpEngine = {
        currentEpoch() { return epochCounter; },
        async respond() {
          return {
            scheduled: [
              { content: "First", position: 0, delayMs: 10 },
              { content: "Second", position: 1, delayMs: 50 },
            ],
            superseded: false,
          };
        },
      };

      const bumpNat = createNaturalize({
        cfg, state, engine: bumpEngine,
        persona: {
          buildPersonaPrompt() { return "prompt"; },
          buildPersonaPromptWithMemory() { return "prompt+mem"; },
        },
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn() {}, debug() {} },
      });

      const dispatcher = {
        sendBlockReply: mock.fn(() => true),
        markComplete: mock.fn(),
      };

      await bumpNat.onReplyDispatch(
        makeReplyEvent(),
        makeDefaultCtx({ dispatcher, abortSignal: undefined }),
      );

      // Bump epoch after first bubble should have fired
      setTimeout(() => { epochCounter = 43; }, 20);

      await new Promise((r) => setTimeout(r, 80));

      assert.ok(dispatcher.sendBlockReply.mock.callCount() <= 2, "should have at most 2 calls");
      assert.equal(dispatcher.markComplete.mock.callCount(), 1);
    });

    it("errors do not throw (fail-open)", async () => {
      const badNat = createNaturalize({
        cfg: { ...cfg, enabled: true },
        state: {
          ...state,
          speakEpochBySession: { get() { throw new Error("boom"); } },
        },
        engine: makeEngine(),
        persona: {
          buildPersonaPrompt() { return "prompt"; },
          buildPersonaPromptWithMemory() { return "prompt+mem"; },
        },
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn() {}, debug() {} },
      });

      const result = await badNat.onReplyDispatch(makeReplyEvent(), makeDefaultCtx());
      assert.equal(result, undefined);
    });
  });

  describe("transcript context", () => {
    it("respond receives transcript peek context", async () => {
      state.transcriptPeekBySession.clear();
      state.transcriptPeekBySession.set("session-nat", ["[Kevin] Hey Hori"]);
      let captured;
      const capEngine = {
        currentEpoch() { return 0; },
        async respond(opts) {
          captured = opts;
          return { scheduled: [{ content: "x", position: 0, delayMs: 5 }], superseded: false };
        },
      };
      const capNat = createNaturalize({
        cfg, state, engine: capEngine,
        persona: {
          buildPersonaPrompt() { return "prompt"; },
          buildPersonaPromptWithMemory() { return "prompt+mem"; },
        },
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn() {}, debug() {} },
      });

      state.speakEpochBySession.set("session-nat", 42);
      state.draftBySession.set("session-nat", "Draft");

      const dispatcher = { sendBlockReply: mock.fn(() => true), markComplete: mock.fn() };
      await capNat.onReplyDispatch(makeReplyEvent(), makeDefaultCtx({ dispatcher, abortSignal: undefined }));

      const transcript = captured.transcript || [];
      assert.ok(transcript.some((t) => t.speaker === "Kevin" && t.text.includes("Hey Hori")));
    });
  });

  describe("socialMemory integration", () => {
    it("ingests own bubbles on reply dispatch", async () => {
      const smStub = makeSocialMemoryStub();
      const memNat = createNaturalize({
        cfg, state, engine: makeEngine(),
        persona: {
          buildPersonaPrompt() { return "prompt"; },
          buildPersonaPromptWithMemory() { return "prompt+mem"; },
        },
        socialMemory: smStub,
        log: { info() {}, warn() {}, debug() {} },
      });

      state.speakEpochBySession.set("session-nat", 42);
      state.draftBySession.set("session-nat", "Agent's draft reply");

      const dispatcher = {
        sendBlockReply: mock.fn(() => true),
        markComplete: mock.fn(),
      };

      await memNat.onReplyDispatch(
        makeReplyEvent(),
        makeDefaultCtx({ dispatcher, abortSignal: undefined }),
      );

      await new Promise((r) => setTimeout(r, 60));

      const ingested = smStub._people["test-agent::session-nat"];
      assert.ok(ingested);
      assert.equal(ingested[0].speaker, "OpenClaw");
      assert.ok(ingested[0].text.includes("Agent's draft reply"));
    });
  });
});
