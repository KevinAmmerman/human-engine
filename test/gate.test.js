import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { createGate } from "../lib/gate.js";
import * as state from "../lib/state.js";

const cfg = {
  enabled: true,
  agents: [],
  agentName: "OpenClaw",
  socialMemory: { enabled: true, extractEvery: 100 },
};

const CHAT_SK = "agent:test-agent:whatsapp:group:123@g.us";

function makeEngine() {
  return {
    async decide(opts) {
      if (opts.isDM || opts.hasMedia) {
        return { decision: "speak", epoch: 1 };
      }
      return { decision: "stay_silent", epoch: 1 };
    },
    openThread() {
      return { id: "th-1" };
    },
    currentEpoch() {
      return 0;
    },
  };
}

const persona = {
  buildPersonaPrompt(cfg, sk) {
    return "system prompt";
  },
  buildPersonaPromptWithMemory(cfg, state, sk) {
    return "system prompt with memory";
  },
};

function makeSocialMemoryStub() {
  const people = {};
  return {
    ingest: (scope, entry) => {
      if (!people[scope]) people[scope] = [];
      people[scope].push(entry);
    },
    recall: (scope, names) => {
      if (scope.includes("speak-turn") || scope.includes("dm-speak") || scope.includes("trigger-speak")) {
        return "Alice: likes climbing. Bob: is a beginner.";
      }
      return "";
    },
    _people: people,
  };
}

function makeDefaultCtx(overrides = {}) {
  return {
    agentId: "test-agent",
    sessionKey: CHAT_SK,
    senderId: "user-1",
    senderName: "Kevin",
    channelId: "ch-1",
    ...overrides,
  };
}

function makeReplyEvent(overrides = {}) {
  return {
    cleanedBody: "Hello bot",
    ...overrides,
  };
}

function makeGate(overrides = {}) {
  return createGate({
    cfg,
    state,
    engine: makeEngine(),
    persona,
    socialMemory: makeSocialMemoryStub(),
    log: { info() {}, warn() {}, debug() {} },
    ...overrides,
  });
}

describe("gate", () => {
  let gate;

  beforeEach(() => {
    state.observedBySession.clear();
    state.memoryBySession.clear();
    state.transcriptPeekBySession.clear();
    state.speakEpochBySession.clear();
    state.latestEpochByChat.clear();
    state.chatTypeBySession.clear();
    state.draftBySession.clear();
    state.metaBySession.clear();
    state.senderBySession.clear();
    state.sessions.clear();
    gate = makeGate();
  });

  describe("onMessageReceived", () => {
    it("records DM chat type", () => {
      gate.onMessageReceived({}, { sessionKey: "session-1", isGroup: false });
      assert.equal(state.chatTypeBySession.get("session-1"), "dm");
    });

    it("records group chat type", () => {
      gate.onMessageReceived({}, { sessionKey: "session-2", isGroup: true });
      assert.equal(state.chatTypeBySession.get("session-2"), "group");
    });

    it("ignores missing sessionKey", () => {
      gate.onMessageReceived({}, { isGroup: true });
      assert.ok(true);
    });

    it("caches sender name per session", () => {
      gate.onMessageReceived({ text: "hi" }, makeDefaultCtx());
      assert.equal(state.senderBySession.get(CHAT_SK), "Kevin");
    });
  });

  describe("onBeforeAgentReply (gate decide + silence)", () => {
    it("returns undefined for disabled config", async () => {
      const disabledGate = makeGate({ cfg: { ...cfg, enabled: false } });
      const result = await disabledGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(result, undefined);
    });

    it("returns undefined for unscoped agent", async () => {
      const scopedGate = makeGate({ cfg: { ...cfg, agents: ["other-agent"] } });
      const result = await scopedGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(result, undefined);
    });

    it("returns undefined for heartbeat trigger", async () => {
      let decideCalled = false;
      const g = makeGate({
        engine: { async decide() { decideCalled = true; return { decision: "speak", epoch: 1 }; } },
      });
      const result = await g.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx({ trigger: "heartbeat" }));
      assert.equal(result, undefined);
      assert.equal(decideCalled, false);
    });

    it("returns undefined for command bypass", async () => {
      const result = await gate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "/new" }), makeDefaultCtx());
      assert.equal(result, undefined);
    });

    it("returns undefined for empty body", async () => {
      const result = await gate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "" }), makeDefaultCtx());
      assert.equal(result, undefined);
    });

    it("handles speak decision (returns undefined, stashes epoch with timestamp)", async () => {
      const speakGate = makeGate({
        engine: { async decide() { return { decision: "speak", epoch: 42 }; } },
      });

      const result = await speakGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(result, undefined);
      assert.equal(state.speakEpochBySession.get(CHAT_SK)?.epoch, 42);
      assert.ok(typeof state.speakEpochBySession.get(CHAT_SK)?.ts === "number");
    });

    it("handles stay_silent decision (handled:true silences the turn, observed buffered)", async () => {
      const silentGate = makeGate({
        engine: { async decide() { return { decision: "stay_silent", epoch: 1 }; } },
      });

      const result = await silentGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.deepEqual(result, { handled: true });
      assert.equal(state.observedBySession.get(CHAT_SK).length, 1);
      assert.ok(state.observedBySession.get(CHAT_SK)[0].includes("Hello bot"));
    });

    it("DM fail-open when decide returns null", async () => {
      const nullGate = makeGate({
        engine: { async decide() { return null; } },
      });

      const result = await nullGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx({ sessionKey: "agent:test-agent:telegram:direct:123" }));
      assert.equal(result, undefined);
    });

    it("group fail-closed when decide returns null (handled:true)", async () => {
      const nullGate = makeGate({
        engine: { async decide() { return null; } },
      });

      const result = await nullGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.deepEqual(result, { handled: true });
      assert.equal(state.observedBySession.get(CHAT_SK).length, 1);
    });

    it("stashes latest epoch on any decision", async () => {
      const epGate = makeGate({
        engine: { async decide() { return { decision: "stay_silent", epoch: 7 }; } },
      });

      await epGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx({ chatId: "chat-x" }));
      assert.equal(state.latestEpochByChat.get("chat-x"), 7);
    });

    it("decide receives transcript peek context", async () => {
      state.transcriptPeekBySession.set(CHAT_SK, ["[Kevin] Hey Hori", "[Hori] Ja?"]);
      let captured;
      const captureGate = makeGate({
        engine: {
          async decide(opts) { captured = opts; return { decision: "speak", epoch: 5 }; },
        },
      });

      await captureGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "Was sagst du?" }), makeDefaultCtx());
      const transcript = captured.transcript || [];
      const hey = transcript.find((t) => t.text.includes("Hey Hori"));
      assert.ok(hey, "transcript should include peek line");
      assert.equal(hey.speaker, "Kevin");
      assert.ok(transcript.some((t) => t.text.includes("Was sagst du?")), "transcript should include current prompt");
    });

    it("does not duplicate transcript peek when message_received already pushed the line", async () => {
      const dupGate = makeGate({
        engine: { async decide() { return { decision: "speak", epoch: 1 }; } },
      });
      dupGate.onMessageReceived({ text: "Was sagst du?" }, makeDefaultCtx());
      await dupGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "Was sagst du?" }), makeDefaultCtx());
      const peek = state.transcriptPeekBySession.get(CHAT_SK) || [];
      assert.equal(peek.filter((l) => l.endsWith("] Was sagst du?")).length, 1);
    });

    it("resolves sender name via contactsPath", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-contacts-"));
      const cFile = path.join(tmpDir, "contacts.md");
      fs.writeFileSync(cFile, "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 111 | +4915000000010 | Kevin | |\n");

      let captured;
      const contactGate = makeGate({
        cfg: { ...cfg, contactsPath: cFile },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
      });
      await contactGate.onBeforeAgentReply(
        makeReplyEvent({ cleanedBody: "servus" }),
        makeDefaultCtx({ senderName: undefined, senderId: "+4915000000010" }),
      );
      const peek = state.transcriptPeekBySession.get(CHAT_SK) || [];
      assert.ok(peek[peek.length - 1].startsWith("[Kevin] "));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("speak turn populates memoryBySession from recall", async () => {
      const memGate = makeGate({
        engine: { async decide() { return { decision: "speak", epoch: 1 }; } },
      });

      await memGate.onBeforeAgentReply(
        makeReplyEvent(),
        makeDefaultCtx({ sessionKey: "agent:test-agent:whatsapp:group:speak-turn@g.us" }),
      );

      const mem = state.memoryBySession.get("agent:test-agent:whatsapp:group:speak-turn@g.us");
      assert.ok(mem);
      assert.ok(mem.includes("Alice"));
    });

    it("silent turn does not set memoryBySession", async () => {
      const memGate = makeGate({
        engine: { async decide() { return { decision: "stay_silent", epoch: 1 }; } },
      });

      await memGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(state.memoryBySession.has(CHAT_SK), false);
    });

    it("errors fail open (returns undefined)", async () => {
      const badGate = makeGate({
        engine: { async decide() { throw new Error("boom"); } },
      });
      const result = await badGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(result, undefined);
    });
  });

  describe("onBeforeAgentRun", () => {
    it("does not call engine.decide (decide lives in before_agent_reply)", async () => {
      let decideCalled = false;
      const g = makeGate({
        engine: { async decide() { decideCalled = true; return { decision: "speak", epoch: 1 }; } },
      });
      await g.onBeforeAgentRun({ prompt: "hi" }, makeDefaultCtx());
      assert.equal(decideCalled, false);
    });

    it("pushes transcript peek for run turns", async () => {
      const g = makeGate();
      await g.onBeforeAgentRun({ prompt: "run turn text" }, makeDefaultCtx());
      const peek = state.transcriptPeekBySession.get(CHAT_SK) || [];
      assert.ok(peek.some((l) => l.endsWith("] run turn text")));
    });

    it("returns undefined for disabled config", async () => {
      const g = makeGate({ cfg: { ...cfg, enabled: false } });
      const result = await g.onBeforeAgentRun({ prompt: "hi" }, makeDefaultCtx());
      assert.equal(result, undefined);
    });
  });

  describe("onBeforePromptBuild", () => {
    it("injects observed context once (drained)", async () => {
      const silentGate = makeGate({
        engine: { async decide() { return { decision: "stay_silent", epoch: 1 }; } },
      });
      await silentGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());

      const result = gate.onBeforePromptBuild({}, makeDefaultCtx());
      assert.ok(result.appendContext.includes("[Observed group context"));
      assert.ok(result.appendContext.includes("Hello bot"));

      const second = gate.onBeforePromptBuild({}, makeDefaultCtx());
      assert.equal(second, undefined);
    });

    it("injects memory into system context when present", () => {
      state.memoryBySession.set(CHAT_SK, "Alice: likes climbing");
      const result = gate.onBeforePromptBuild({}, makeDefaultCtx());
      assert.ok(result.appendSystemContext.includes("What you know about the people here"));
      assert.ok(result.appendSystemContext.includes("Alice"));
    });

    it("returns undefined when nothing to inject", () => {
      const result = gate.onBeforePromptBuild({}, makeDefaultCtx());
      assert.equal(result, undefined);
    });

    it("returns undefined for unscoped agent", () => {
      state.memoryBySession.set(CHAT_SK, "mem");
      const scopedGate = makeGate({ cfg: { ...cfg, agents: ["other"] } });
      const result = scopedGate.onBeforePromptBuild({}, makeDefaultCtx());
      assert.equal(result, undefined);
    });
  });

  describe("onMessageSending", () => {
    it("cancels block text", () => {
      const result = gate.onMessageSending(
        { content: "Your message could not be sent: blocked by human-engine (stay silent)" },
        makeDefaultCtx(),
      );
      assert.deepEqual(result, { cancel: true });
    });

    it("passes normal content", () => {
      const result = gate.onMessageSending({ content: "Hallo!" }, makeDefaultCtx());
      assert.equal(result, undefined);
    });
  });

  describe("socialMemory integration", () => {
    it("ingests on onMessageReceived for chat sessions", () => {
      const smStub = makeSocialMemoryStub();
      const memGate = makeGate({ socialMemory: smStub });

      memGate.onMessageReceived({ text: "hello" }, { sessionKey: "agent:agent1:whatsapp:group:123@g.us", agentId: "agent1", senderId: "Alice", isGroup: true });
      assert.ok(smStub._people["agent1::agent:agent1:whatsapp:group:123@g.us"]);
      assert.equal(smStub._people["agent1::agent:agent1:whatsapp:group:123@g.us"][0].speaker, "Alice");
      assert.equal(smStub._people["agent1::agent:agent1:whatsapp:group:123@g.us"][0].text, "hello");
    });

    it("skips social memory ingest for non-chat sessions (cron/commitments)", async () => {
      const sm = makeSocialMemoryStub();
      const cronGate = makeGate({
        engine: { async decide() { return { decision: "speak", epoch: 1 }; } },
        socialMemory: sm,
      });
      await cronGate.onBeforeAgentReply(
        makeReplyEvent(),
        makeDefaultCtx({ sessionKey: "agent:test-agent:cron:abc-123:run:def-456" }),
      );
      assert.deepEqual(sm._people, {});
    });

    it("ingests social memory for real chat sessions on before_agent_reply", async () => {
      const sm = makeSocialMemoryStub();
      const chatGate = makeGate({
        engine: { async decide() { return { decision: "speak", epoch: 1 }; } },
        socialMemory: sm,
      });
      await chatGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.ok(sm._people["test-agent::" + CHAT_SK]);
    });
  });
});
