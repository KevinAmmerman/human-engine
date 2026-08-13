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

const CHAT_SK = "agent:test-agent:whatsapp:group:123@g.us";

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
    sessionKey: CHAT_SK,
    channelId: "ch-1",
    chatId: "chat-1",
    ...overrides,
  };
}

function makeDispatcher() {
  return {
    sendBlockReply: mock.fn(() => true),
    markComplete: mock.fn(),
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

function makePersona() {
  return {
    buildPersonaPrompt() { return "prompt"; },
    buildPersonaPromptWithMemory() { return "prompt+mem"; },
  };
}

function armSpeakTurn(naturalize, dispatcher, epoch = 42) {
  state.speakEpochBySession.set(CHAT_SK, { epoch, ts: Date.now() });
  return naturalize.onReplyDispatch(
    { sendPolicy: "allow" },
    makeDefaultCtx({ dispatcher, abortSignal: undefined }),
  );
}

describe("naturalize", () => {
  let naturalize;

  afterEach(() => {
    clearAllBubbleTimers();
  });

  beforeEach(() => {
    state.speakEpochBySession.clear();
    state.transcriptPeekBySession.clear();
    state.chatTypeBySession.clear();

    naturalize = createNaturalize({
      cfg,
      state,
      engine: makeEngine(),
      persona: makePersona(),
      socialMemory: makeSocialMemoryStub(),
      log: { info() {}, warn() {}, debug() {} },
    });
  });

  describe("onReplyDispatch", () => {
    it("arms dispatcher when speak epoch exists", () => {
      const dispatcher = makeDispatcher();
      const result = armSpeakTurn(naturalize, dispatcher);
      assert.equal(result, undefined);
    });

    it("returns undefined when no speak epoch", () => {
      const result = naturalize.onReplyDispatch({ sendPolicy: "allow" }, makeDefaultCtx({ dispatcher: makeDispatcher() }));
      assert.equal(result, undefined);
    });

    it("returns undefined when sendPolicy is not allow", () => {
      state.speakEpochBySession.set(CHAT_SK, { epoch: 1, ts: Date.now() });
      const result = naturalize.onReplyDispatch({ sendPolicy: "deny" }, makeDefaultCtx());
      assert.equal(result, undefined);
    });

    it("returns undefined for non-chat sessions", () => {
      state.speakEpochBySession.set("agent:test-agent:cron:x", { epoch: 1, ts: Date.now() });
      const result = naturalize.onReplyDispatch(
        { sendPolicy: "allow" },
        makeDefaultCtx({ sessionKey: "agent:test-agent:cron:x" }),
      );
      assert.equal(result, undefined);
    });

    it("expires stale speak epoch", () => {
      state.speakEpochBySession.set(CHAT_SK, { epoch: 1, ts: Date.now() - 400000 });
      const result = naturalize.onReplyDispatch({ sendPolicy: "allow" }, makeDefaultCtx({ dispatcher: makeDispatcher() }));
      assert.equal(result, undefined);
      assert.equal(state.speakEpochBySession.has(CHAT_SK), false);
    });

    it("honors the speakEpochTtlMs config override", () => {
      const overrideCfg = { ...cfg, naturalize: { speakEpochTtlMs: 50000 } };
      const nat = createNaturalize({
        cfg: overrideCfg, state, engine: makeEngine(), persona: makePersona(),
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn() {}, debug() {} },
      });
      state.speakEpochBySession.set(CHAT_SK, { epoch: 1, ts: Date.now() - 60000 });
      const result = nat.onReplyDispatch({ sendPolicy: "allow" }, makeDefaultCtx({ dispatcher: makeDispatcher() }));
      assert.equal(result, undefined);
      assert.equal(state.speakEpochBySession.has(CHAT_SK), false);
    });
  });

  describe("onReplyPayloadSending", () => {
    it("captures real reply text and cancels original payload", async () => {
      const dispatcher = makeDispatcher();
      armSpeakTurn(naturalize, dispatcher);

      const result = naturalize.onReplyPayloadSending(
        { sessionKey: CHAT_SK, kind: "final", channel: "whatsapp", payload: { text: "Real agent reply" } },
        makeDefaultCtx(),
      );
      assert.deepEqual(result, { cancel: true });

      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(dispatcher.sendBlockReply.mock.callCount(), 2);
      assert.equal(dispatcher.sendBlockReply.mock.calls[0].arguments[0].text, "Bubble one");
      assert.equal(dispatcher.markComplete.mock.callCount(), 1);
    });

    it("returns undefined when no speak epoch", () => {
      const result = naturalize.onReplyPayloadSending(
        { sessionKey: CHAT_SK, kind: "final", payload: { text: "reply" } },
        makeDefaultCtx(),
      );
      assert.equal(result, undefined);
    });

    it("pushes own reply text into transcript peek for two-sided decide context", () => {
      state.speakEpochBySession.set(CHAT_SK, { epoch: 1, ts: Date.now() });
      naturalize.onReplyPayloadSending(
        { sessionKey: CHAT_SK, kind: "final", payload: { text: "Klare Antwort: nasser Fels ist ein No-Go" } },
        makeDefaultCtx(),
      );
      const peek = state.transcriptPeekBySession.get(CHAT_SK) || [];
      assert.ok(peek.some((l) => l === "[OpenClaw] Klare Antwort: nasser Fels ist ein No-Go"));
    });

    it("does not push NO_REPLY payloads into transcript peek", () => {
      state.speakEpochBySession.set(CHAT_SK, { epoch: 1, ts: Date.now() });
      naturalize.onReplyPayloadSending(
        { sessionKey: CHAT_SK, kind: "final", payload: { text: "NO_REPLY" } },
        makeDefaultCtx(),
      );
      const peek = state.transcriptPeekBySession.get(CHAT_SK) || [];
      assert.equal(peek.filter((l) => l.includes("NO_REPLY")).length, 0);
    });

    it("passes through NO_REPLY payloads", () => {
      state.speakEpochBySession.set(CHAT_SK, { epoch: 1, ts: Date.now() });
      const result = naturalize.onReplyPayloadSending(
        { sessionKey: CHAT_SK, kind: "final", payload: { text: "NO_REPLY" } },
        makeDefaultCtx(),
      );
      assert.equal(result, undefined);
    });

    it("passes through non-final kinds (block replies, tool summaries)", () => {
      state.speakEpochBySession.set(CHAT_SK, { epoch: 1, ts: Date.now() });
      const result = naturalize.onReplyPayloadSending(
        { sessionKey: CHAT_SK, kind: "block", payload: { text: "partial" } },
        makeDefaultCtx(),
      );
      assert.equal(result, undefined);
    });

    it("passes through when no dispatcher stashed", () => {
      state.speakEpochBySession.set(CHAT_SK, { epoch: 1, ts: Date.now() });
      const result = naturalize.onReplyPayloadSending(
        { sessionKey: CHAT_SK, kind: "final", payload: { text: "reply" } },
        makeDefaultCtx(),
      );
      assert.equal(result, undefined);
    });

    it("passes through for non-chat sessions", () => {
      state.speakEpochBySession.set("agent:test-agent:cron:x", { epoch: 1, ts: Date.now() });
      const result = naturalize.onReplyPayloadSending(
        { sessionKey: "agent:test-agent:cron:x", kind: "final", payload: { text: "reply" } },
        makeDefaultCtx({ sessionKey: "agent:test-agent:cron:x" }),
      );
      assert.equal(result, undefined);
    });

    it("accumulates multiple payloads into one draft", async () => {
      let capturedDraft;
      const capEngine = {
        currentEpoch() { return 0; },
        async respond(opts) {
          capturedDraft = opts.draft;
          return { scheduled: [{ content: "merged", position: 0, delayMs: 5 }], superseded: false };
        },
      };
      const capNat = createNaturalize({
        cfg, state, engine: capEngine, persona: makePersona(),
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn() {}, debug() {} },
      });
      const dispatcher = makeDispatcher();
      armSpeakTurn(capNat, dispatcher);

      capNat.onReplyPayloadSending({ sessionKey: CHAT_SK, kind: "final", payload: { text: "part one" } }, makeDefaultCtx());
      capNat.onReplyPayloadSending({ sessionKey: CHAT_SK, kind: "final", payload: { text: "part two" } }, makeDefaultCtx());

      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(capturedDraft, "part one\npart two");
    });

    it("respond receives transcript peek context", async () => {
      state.transcriptPeekBySession.set(CHAT_SK, ["[Kevin] Hey Hori"]);
      let captured;
      const capEngine = {
        currentEpoch() { return 0; },
        async respond(opts) {
          captured = opts;
          return { scheduled: [{ content: "x", position: 0, delayMs: 5 }], superseded: false };
        },
      };
      const capNat = createNaturalize({
        cfg, state, engine: capEngine, persona: makePersona(),
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn() {}, debug() {} },
      });
      armSpeakTurn(capNat, makeDispatcher());
      capNat.onReplyPayloadSending({ sessionKey: CHAT_SK, kind: "final", payload: { text: "reply" } }, makeDefaultCtx());

      await new Promise((r) => setTimeout(r, 1500));
      const transcript = captured.transcript || [];
      assert.ok(transcript.some((t) => t.speaker === "Kevin" && t.text.includes("Hey Hori")));
    });

    it("epoch bump mid-delivery cancels remaining bubbles", async () => {
      let epochCounter = 0;
      const bumpEngine = {
        currentEpoch() { return epochCounter; },
        async respond() {
          return {
            scheduled: [
              { content: "First", position: 0, delayMs: 10 },
              { content: "Second", position: 1, delayMs: 150 },
            ],
            superseded: false,
          };
        },
      };
      const bumpNat = createNaturalize({
        cfg, state, engine: bumpEngine, persona: makePersona(),
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn() {}, debug() {} },
      });
      const dispatcher = makeDispatcher();
      armSpeakTurn(bumpNat, dispatcher);
      bumpNat.onReplyPayloadSending({ sessionKey: CHAT_SK, kind: "final", payload: { text: "reply" } }, makeDefaultCtx());

      setTimeout(() => { epochCounter = 43; }, 1400);

      await new Promise((r) => setTimeout(r, 1700));
      assert.ok(dispatcher.sendBlockReply.mock.callCount() <= 2, "should have at most 2 calls");
      assert.equal(dispatcher.markComplete.mock.callCount(), 1);
    });

    it("stay_silent decide mid-delivery does not cancel bubbles", async () => {
      const stayEngine = {
        currentEpoch() { return 42; },
        async respond() {
          return {
            scheduled: [
              { content: "First", position: 0, delayMs: 10 },
              { content: "Second", position: 1, delayMs: 150 },
            ],
            superseded: false,
          };
        },
      };
      const stayNat = createNaturalize({
        cfg, state, engine: stayEngine, persona: makePersona(),
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn() {}, debug() {} },
      });
      const dispatcher = makeDispatcher();
      armSpeakTurn(stayNat, dispatcher);
      stayNat.onReplyPayloadSending({ sessionKey: CHAT_SK, kind: "final", payload: { text: "reply" } }, makeDefaultCtx());

      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(dispatcher.sendBlockReply.mock.callCount(), 2);
      assert.equal(dispatcher.markComplete.mock.callCount(), 1);
    });

    it("new speak epoch mid-delivery cancels remaining bubbles and marks complete", async () => {
      let epochCounter = 42;
      const speakBumpEngine = {
        currentEpoch() { return epochCounter; },
        async respond() {
          return {
            scheduled: [
              { content: "First", position: 0, delayMs: 10 },
              { content: "Second", position: 1, delayMs: 400 },
            ],
            superseded: false,
          };
        },
      };
      const sbNat = createNaturalize({
        cfg, state, engine: speakBumpEngine, persona: makePersona(),
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn() {}, debug() {} },
      });
      const dispatcher = makeDispatcher();
      armSpeakTurn(sbNat, dispatcher);
      sbNat.onReplyPayloadSending({ sessionKey: CHAT_SK, kind: "final", payload: { text: "reply" } }, makeDefaultCtx());

      setTimeout(() => { epochCounter = 43; }, 1400);

      await new Promise((r) => setTimeout(r, 2000));
      assert.equal(dispatcher.sendBlockReply.mock.callCount(), 1);
      assert.equal(dispatcher.markComplete.mock.callCount(), 1);
    });

    it("retries once when sendBlockReply fails then succeeds", async () => {
      const logs = [];
      const retryNat = createNaturalize({
        cfg, state, engine: makeEngine(), persona: makePersona(),
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn(m) { logs.push(m); }, debug() {} },
      });
      const dispatcher = {
        sendBlockReply: mock.fn((opts) => {
          if (dispatcher.sendBlockReply.mock.callCount() === 1) return false;
          return true;
        }),
        markComplete: mock.fn(),
      };
      armSpeakTurn(retryNat, dispatcher);
      retryNat.onReplyPayloadSending({ sessionKey: CHAT_SK, kind: "final", payload: { text: "reply" } }, makeDefaultCtx());

      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(dispatcher.sendBlockReply.mock.callCount(), 3);
      assert.equal(dispatcher.markComplete.mock.callCount(), 1);
      assert.equal(logs.some((l) => l.includes("BUBBLE LOST")), false);
    });

    it("logs BUBBLE LOST exactly once per bubble when host aborts", async () => {
      const logs = [];
      const lostNat = createNaturalize({
        cfg, state, engine: makeEngine(), persona: makePersona(),
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn(m) { logs.push(m); }, debug() {} },
      });
      const dispatcher = {
        sendBlockReply: mock.fn(() => false),
        markComplete: mock.fn(),
      };
      armSpeakTurn(lostNat, dispatcher);
      lostNat.onReplyPayloadSending({ sessionKey: CHAT_SK, kind: "final", payload: { text: "reply" } }, makeDefaultCtx());

      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(dispatcher.sendBlockReply.mock.callCount(), 4);
      assert.equal(logs.filter((l) => l.includes("BUBBLE LOST")).length, 2);
      assert.equal(dispatcher.markComplete.mock.callCount(), 1);
    });

    it("flush skips when no dispatcher is stashed at flush time", async () => {
      const logs = [];
      const flushNat = createNaturalize({
        cfg, state, engine: makeEngine(), persona: makePersona(),
        socialMemory: makeSocialMemoryStub(),
        log: { info(m) { logs.push(m); }, warn(m) { logs.push(m); }, debug() {} },
      });
      const dispatcher = makeDispatcher();
      armSpeakTurn(flushNat, dispatcher);
      flushNat.onReplyPayloadSending({ sessionKey: CHAT_SK, kind: "final", payload: { text: "reply" } }, makeDefaultCtx());
      flushNat.onReplyDispatch(
        { sendPolicy: "allow" },
        makeDefaultCtx({ dispatcher: null, abortSignal: undefined }),
      );

      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(logs.some((l) => l.includes("flush skipped")));
      assert.equal(dispatcher.sendBlockReply.mock.callCount(), 0);
    });

    it("delivers raw draft when engine returns superseded", async () => {
      const supEngine = {
        currentEpoch() { return 0; },
        async respond() { return { superseded: true }; },
      };
      const supNat = createNaturalize({
        cfg, state, engine: supEngine, persona: makePersona(),
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn() {}, debug() {} },
      });
      const dispatcher = makeDispatcher();
      armSpeakTurn(supNat, dispatcher);
      supNat.onReplyPayloadSending({ sessionKey: CHAT_SK, kind: "final", payload: { text: "the draft" } }, makeDefaultCtx());

      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(dispatcher.sendBlockReply.mock.callCount(), 1);
      assert.equal(dispatcher.sendBlockReply.mock.calls[0].arguments[0].text, "the draft");
      assert.equal(dispatcher.markComplete.mock.callCount(), 1);
    });

    it("errors do not throw (fail-open)", () => {
      const badNat = createNaturalize({
        cfg: { ...cfg, enabled: true },
        state: {
          ...state,
          speakEpochBySession: { get() { throw new Error("boom"); } },
        },
        engine: makeEngine(),
        persona: makePersona(),
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn() {}, debug() {} },
      });

      const result = badNat.onReplyPayloadSending(
        { sessionKey: CHAT_SK, kind: "final", payload: { text: "reply" } },
        makeDefaultCtx(),
      );
      assert.equal(result, undefined);
    });
  });

  describe("socialMemory integration", () => {
    it("ingests own reply on flush", async () => {
      const smStub = makeSocialMemoryStub();
      const memNat = createNaturalize({
        cfg, state, engine: makeEngine(), persona: makePersona(),
        socialMemory: smStub,
        log: { info() {}, warn() {}, debug() {} },
      });
      armSpeakTurn(memNat, makeDispatcher());
      memNat.onReplyPayloadSending(
        { sessionKey: CHAT_SK, kind: "final", payload: { text: "Agent's reply text" } },
        makeDefaultCtx(),
      );

      await new Promise((r) => setTimeout(r, 1500));
      const ingested = smStub._people["test-agent::" + CHAT_SK];
      assert.ok(ingested);
      assert.equal(ingested[0].speaker, "OpenClaw");
      assert.ok(ingested[0].text.includes("Agent's reply text"));
    });
  });
});
