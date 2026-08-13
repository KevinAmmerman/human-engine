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
    state.chatTypeBySession.clear();
    state.senderBySession.clear();
    state.replyContextQueue.clear();
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

    it("hydrates decide transcript from session reader when peek is thin", async () => {
      let captured;
      const hydGate = makeGate({
        engine: {
          async decide(opts) { captured = opts; return { decision: "speak", epoch: 5 }; },
        },
        readTranscript: async () => [
          { speaker: "User", text: "Hey Hori, was sagst du zu nassen Felsen?" },
          { speaker: "Hori", text: "nasser Klettersteig ist ein No-Go" },
        ],
      });

      await hydGate.onBeforeAgentReply(
        makeReplyEvent({ cleanedBody: "und was ist mit morgen?" }),
        makeDefaultCtx({ sessionId: "sess-1" }),
      );
      const texts = (captured.transcript || []).map((t) => t.text);
      assert.ok(texts.some((t) => t.includes("No-Go")), "hydrated assistant line present");
      assert.ok(texts.some((t) => t.includes("und was ist mit morgen?")), "current prompt appended");
      const hori = (captured.transcript || []).find((t) => t.text.includes("No-Go"));
      assert.equal(hori.speaker, "Hori");
    });

    it("merges hydrated assistant line even when peek has 6+ entries", async () => {
      for (let i = 0; i < 8; i++) state.pushTranscriptPeek(CHAT_SK, `[Kevin] m${i}`);
      let captured;
      const pkGate = makeGate({
        engine: {
          async decide(opts) { captured = opts; return { decision: "speak", epoch: 5 }; },
        },
        readTranscript: async () => [
          { speaker: "User", text: "Hey Hori, wie ist das Wetter?" },
          { speaker: "Hori", text: "klar und sonnig" },
          { speaker: "Kevin", text: "m7" },
        ],
      });

      await pkGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      const texts = (captured.transcript || []).map((t) => t.text);
      assert.ok(texts.includes("klar und sonnig"), "hydrated assistant line present despite full peek");
      assert.ok(texts.includes("m7"), "peek line present");
      assert.equal(texts.filter((t) => t === "m7").length, 1, "identical text in both layers appears once");
    });

    it("returns undefined for empty body", async () => {
      const result = await gate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "" }), makeDefaultCtx());
      assert.equal(result, undefined);
    });

    it("merges observed-store layer with hydrated and peek, deduped, chronological, capped at 20", async () => {
      for (let i = 0; i < 6; i++) state.pushTranscriptPeek(CHAT_SK, `[Kevin] p${i}`);
      state.pushTranscriptPeek(CHAT_SK, "[Kevin] older silenced");
      let captured;
      const obsGate = makeGate({
        observedStore: {
          readObserved: () => [{ speaker: "Kevin", text: "older silenced", ts: 1000 }],
          appendObserved: () => {},
        },
        engine: {
          async decide(opts) { captured = opts; return { decision: "speak", epoch: 5 }; },
        },
        readTranscript: async () => [{ speaker: "Hori", text: "assistant note" }],
      });

      await obsGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "current prompt" }), makeDefaultCtx());
      const transcript = captured.transcript || [];
      const texts = transcript.map((t) => t.text);
      assert.ok(texts.includes("assistant note"), "hydrated assistant line present");
      assert.ok(texts.includes("older silenced"), "observed layer present");
      assert.equal(texts.filter((t) => t === "older silenced").length, 1, "observed + peek same message appears once");
      assert.ok(texts.includes("p5"), "peek lines present");
      assert.ok(texts.includes("current prompt"), "current prompt appended");
      assert.ok(transcript.length <= 20, "merged transcript capped at 20");
      assert.ok(texts.indexOf("assistant note") < texts.indexOf("older silenced"), "hydrated before observed");
      assert.ok(texts.indexOf("older silenced") < texts.indexOf("p0"), "observed before peek");
      assert.equal(texts[texts.length - 1], "current prompt", "current prompt is last");
    });

    it("stay_silent persists the silenced message to the observed store", async () => {
      const appends = [];
      const storeGate = makeGate({
        observedStore: {
          readObserved: () => [],
          appendObserved: (sk, row) => appends.push({ sk, ...row }),
        },
        engine: { async decide() { return { decision: "stay_silent", epoch: 1 }; } },
      });

      const result = await storeGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.deepEqual(result, { handled: true });
      assert.equal(appends.length, 1);
      assert.equal(appends[0].sk, CHAT_SK);
      assert.equal(appends[0].speaker, "Kevin");
      assert.equal(appends[0].text, "Hello bot");
      assert.ok(typeof appends[0].ts === "number");
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

    it("handles any decision without writing dead epoch maps", async () => {
      const epGate = makeGate({
        engine: { async decide() { return { decision: "stay_silent", epoch: 7 }; } },
      });

      const result = await epGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx({ chatId: "chat-x" }));
      assert.deepEqual(result, { handled: true });
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

    it("decide gets a lean persona (soul only, no anti-tell block)", async () => {
      let captured;
      const leanGate = makeGate({
        persona: {
          buildPersonaPrompt() { return "full persona with ANTI_TELL and Writing constraints"; },
          buildSoulPrompt() { return "lean soul prompt"; },
        },
        engine: {
          async decide(opts) { captured = opts; return { decision: "stay_silent", epoch: 2 }; },
        },
      });
      await leanGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(captured.persona, "lean soul prompt");
      assert.ok(!captured.persona.includes("ANTI_TELL"), "decide persona must not carry anti-tell block");
      assert.ok(!captured.persona.includes("Writing constraints"), "decide persona must not carry writing constraints");
    });

    it("decide receives agentContactIds derived from contacts for the agent name", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-contacts-agents-"));
      const cFile = path.join(tmpDir, "contacts.md");
      fs.writeFileSync(
        cFile,
        "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 81000000000001 | +4915000000002 | AgentBot | |\n| 81000000000004 | +4915000000001 | Ada Example | |\n",
      );

      let captured;
      const contactGate = makeGate({
        cfg: { ...cfg, agentName: "AgentBot", contactsPath: cFile },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
      });
      await contactGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.ok(captured.agentContactIds instanceof Set);
      assert.equal(captured.agentContactIds.has("81000000000001"), true);
      assert.equal(captured.agentContactIds.has("81000000000004"), false);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("passes replyToAgent=true when a quote-reply names the agent via contacts", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-reply-contacts-"));
      const cFile = path.join(tmpDir, "contacts.md");
      fs.writeFileSync(
        cFile,
        "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 81000000000001 | +4915000000002 | OpenClaw (Bot) | |\n",
      );

      let captured;
      const replyGate = makeGate({
        cfg: { ...cfg, contactsPath: cFile },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
      });
      replyGate.onMessageReceived({ text: "Ja, gut" }, makeDefaultCtx({ replyToSender: "81000000000001" }));
      await replyGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "danke!" }), makeDefaultCtx());
      assert.equal(captured.replyToAgent, true);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("race regression: plain message from sender B does not wipe sender A's stored quote-reply trigger", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-reply-race-"));
      const cFile = path.join(tmpDir, "contacts.md");
      fs.writeFileSync(cFile, "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 81000000000001 | +4915000000002 | OpenClaw (Bot) | |\n");

      const raceGate = makeGate({ cfg: { ...cfg, contactsPath: cFile } });
      raceGate.onMessageReceived(
        { text: "Ja, gut" },
        makeDefaultCtx({ senderId: "user-A", replyToSender: "81000000000001" }),
      );
      assert.ok(state.replyContextQueue.has(CHAT_SK + "|user-A"), "quote-reply queued under A's sender key");

      let captured;
      const spyGate = makeGate({
        cfg: { ...cfg, contactsPath: cFile },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
      });
      spyGate.onMessageReceived({ text: "ganz normaler text von B" }, makeDefaultCtx({ senderId: "user-B" }));
      await spyGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "danke!" }), makeDefaultCtx({ senderId: "user-A" }));
      assert.equal(captured.replyToAgent, true);
      assert.equal((state.replyContextQueue.get(CHAT_SK + "|user-A") || []).length, 0, "entry consumed once");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("passes replyToAgent=true via body-match when peek holds the quoted agent line", async () => {
      state.transcriptPeekBySession.set(CHAT_SK, ["[Hori] klar und sonnig am Berg, perfekt fuer den Klettersteig"]);
      let captured;
      const bodyGate = makeGate({
        cfg: { ...cfg, agentName: "Hori" },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
      });
      bodyGate.onMessageReceived(
        { text: "danke" },
        makeDefaultCtx({ replyToBody: "klar und sonnig am Berg, perfekt fuer den Klettersteig" }),
      );
      await bodyGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "danke!" }), makeDefaultCtx());
      assert.equal(captured.replyToAgent, true);
    });

    it("two queued quotes from the same sender: each decide consumes the text-matching entry", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-reply-twoq-"));
      const cFile = path.join(tmpDir, "contacts.md");
      fs.writeFileSync(cFile, "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 81000000000001 | +4915000000002 | OpenClaw (Bot) | |\n");

      let captured = [];
      const twoGate = makeGate({
        cfg: { ...cfg, contactsPath: cFile },
        engine: { async decide(opts) { captured.push(opts); return { decision: "speak", epoch: 1 }; } },
      });
      twoGate.onMessageReceived(
        { text: "was ist los in der gruppe" },
        makeDefaultCtx({ senderId: "user-1", replyToSender: "81000000000001" }),
      );
      twoGate.onMessageReceived(
        { text: "und der wochenendplan" },
        makeDefaultCtx({ senderId: "user-1", replyToSender: "81000000000001" }),
      );
      assert.equal((state.replyContextQueue.get(CHAT_SK + "|user-1") || []).length, 2);

      await twoGate.onBeforeAgentReply(
        makeReplyEvent({ cleanedBody: "was ist los in der gruppe danke" }),
        makeDefaultCtx({ senderId: "user-1" }),
      );
      assert.equal(captured[0].replyToAgent, true);
      const afterFirst = state.replyContextQueue.get(CHAT_SK + "|user-1") || [];
      assert.equal(afterFirst.length, 1);
      assert.equal(afterFirst[0].textNorm, "und der wochenendplan", "matching entry consumed, other kept");

      await twoGate.onBeforeAgentReply(
        makeReplyEvent({ cleanedBody: "und der wochenendplan bitte" }),
        makeDefaultCtx({ senderId: "user-1" }),
      );
      assert.equal(captured[1].replyToAgent, true);
      assert.equal((state.replyContextQueue.get(CHAT_SK + "|user-1") || []).length, 0, "second entry consumed too");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("cleanedBody drift from the raw quoted text still resolves (exact or newest-fresh fallback)", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-reply-drift-"));
      const cFile = path.join(tmpDir, "contacts.md");
      fs.writeFileSync(cFile, "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 81000000000001 | +4915000000002 | OpenClaw (Bot) | |\n");

      let captured = [];
      const driftGate = makeGate({
        cfg: { ...cfg, contactsPath: cFile },
        engine: { async decide(opts) { captured.push(opts); return { decision: "speak", epoch: 1 }; } },
      });

      driftGate.onMessageReceived(
        { text: "morgen am berg " },
        makeDefaultCtx({ senderId: "user-1", replyToSender: "81000000000001" }),
      );
      await driftGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "morgen am berg" }), makeDefaultCtx({ senderId: "user-1" }));
      assert.equal(captured[0].replyToAgent, true, "trailing whitespace collapsed, exact match");
      assert.equal((state.replyContextQueue.get(CHAT_SK + "|user-1") || []).length, 0);

      driftGate.onMessageReceived(
        { text: "abend am see" },
        makeDefaultCtx({ senderId: "user-1", replyToSender: "81000000000001" }),
      );
      await driftGate.onBeforeAgentReply(
        makeReplyEvent({ cleanedBody: "jetzt mal: abend am see" }),
        makeDefaultCtx({ senderId: "user-1" }),
      );
      assert.equal(captured[1].replyToAgent, true, "prefix drift falls back to newest fresh entry");
      assert.equal((state.replyContextQueue.get(CHAT_SK + "|user-1") || []).length, 0);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("does not apply a stale reply context older than 5 minutes and drops it", async () => {
      state.replyContextQueue.set(CHAT_SK + "|user-1", [
        {
          sender: "81000000000001",
          body: "klar und sonnig am Berg",
          textNorm: "klar und sonnig am berg",
          ts: Date.now() - 6 * 60 * 1000,
        },
      ]);
      state.transcriptPeekBySession.set(CHAT_SK, ["[OpenClaw] klar und sonnig am Berg"]);
      let captured;
      const staleGate = makeGate({
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
      });
      await staleGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "danke!" }), makeDefaultCtx());
      assert.equal(captured.replyToAgent, false);
      assert.equal(state.replyContextQueue.has(CHAT_SK + "|user-1"), false, "stale entry dropped");
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
      fs.writeFileSync(cFile, "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 111 | +4915000000001 | Ada Example | |\n");

      let captured;
      const contactGate = makeGate({
        cfg: { ...cfg, contactsPath: cFile },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
      });
      await contactGate.onBeforeAgentReply(
        makeReplyEvent({ cleanedBody: "servus" }),
        makeDefaultCtx({ senderName: undefined, senderId: "+4915000000001" }),
      );
      const peek = state.transcriptPeekBySession.get(CHAT_SK) || [];
      assert.ok(peek[peek.length - 1].startsWith("[Ada Example] "));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("resolves unresolvable phone numbers to member-XXXX (last 4 digits)", async () => {
      const anonGate = makeGate();
      const result = anonGate.onMessageReceived({ text: "hi" }, makeDefaultCtx({ senderName: undefined, senderId: "+4915000000003" }));
      assert.equal(state.senderBySession.get(CHAT_SK), "member-0003");
    });

    it("resolves unresolvable lids to member-XXXX (last 4 digits)", async () => {
      const anonGate = makeGate();
      anonGate.onMessageReceived({ text: "hi" }, makeDefaultCtx({ senderName: undefined, senderId: "@81000000000001" }));
      assert.equal(state.senderBySession.get(CHAT_SK), "member-0001");
    });

    it("keeps real names from contacts for resolvable numbers", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-anon-contacts-"));
      const cFile = path.join(tmpDir, "contacts.md");
      fs.writeFileSync(cFile, "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 111 | +4915000000001 | Ada Example | |\n");

      const namedGate = makeGate({ cfg: { ...cfg, contactsPath: cFile } });
      namedGate.onMessageReceived({ text: "hi" }, makeDefaultCtx({ senderName: undefined, senderId: "+4915000000001" }));
      assert.equal(state.senderBySession.get(CHAT_SK), "Ada Example");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("passes through non-identifier display names", async () => {
      const anonGate = makeGate();
      anonGate.onMessageReceived({ text: "hi" }, makeDefaultCtx({ senderName: undefined, senderId: "Gruppen-Bot" }));
      assert.equal(state.senderBySession.get(CHAT_SK), "Gruppen-Bot");
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

    it("errors fail open (returns undefined) for DM sessions", async () => {
      const badGate = makeGate({
        engine: { async decide() { throw new Error("boom"); } },
      });
      const result = await badGate.onBeforeAgentReply(
        makeReplyEvent(),
        makeDefaultCtx({ sessionKey: "agent:test-agent:telegram:direct:12345" }),
      );
      assert.equal(result, undefined);
    });

    it("group gate errors fail closed (handled:true)", async () => {
      const warns = [];
      const badGate = makeGate({
        engine: { async decide() { throw new Error("boom"); } },
        log: { info() {}, warn: (msg) => warns.push(msg), debug() {} },
      });
      const result = await badGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.deepEqual(result, { handled: true });
      assert.equal(state.observedBySession.get(CHAT_SK).length, 1);
      assert.ok(warns.some((w) => w.includes("boom")), "warn should carry the thrown error");
      assert.ok(warns.some((w) => w.includes("before_agent_reply error")), "warn should name the gate error path");
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

    it("cancels lowercase block text variant", () => {
      const result = gate.onMessageSending(
        { content: "your message could not be sent: blocked by human-engine (stay silent)" },
        makeDefaultCtx(),
      );
      assert.deepEqual(result, { cancel: true });
    });

    it("cancels 'human engine' spacing variant", () => {
      const result = gate.onMessageSending(
        { content: "Your message could not be sent and was blocked by human engine." },
        makeDefaultCtx(),
      );
      assert.deepEqual(result, { cancel: true });
    });

    it("does not match unrelated 'your message was sent' text", () => {
      const result = gate.onMessageSending(
        { content: "your message was sent to the group." },
        makeDefaultCtx(),
      );
      assert.equal(result, undefined);
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
