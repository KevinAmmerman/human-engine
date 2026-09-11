import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { createGate } from "../lib/gate.js";
import { createObservedStore } from "../lib/observed-store.js";
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
    recallCompact: (scope, names, limit) => {
      if (scope.includes("speak-turn") || scope.includes("dm-speak") || scope.includes("trigger-speak")) {
        return "Alice: likes climbing";
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
    senderName: "Nico",
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
    state.mediaBySession.clear();
    state.replyTargetBySession.clear();
    state.speakPathBySession.clear();
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
      const result = gate.onMessageReceived({}, { isGroup: true });
      assert.equal(result, undefined, "missing sessionKey handler returns undefined");
      assert.equal(state.chatTypeBySession.has(undefined), false, "must not record a chat type for a missing sessionKey");
    });

    it("caches sender name per session", () => {
      gate.onMessageReceived({ text: "hi" }, makeDefaultCtx());
      assert.equal(state.senderBySession.get(CHAT_SK), "Nico");
    });

    it("plan 035/616: captures the inbound member-message id (ctx.messageId), not the quoted id, as the reply target", () => {
      gate.onMessageReceived(
        { text: "danke!" },
        makeDefaultCtx({ senderId: "user-1", replyToSender: "81000000000001", replyToId: "quoted-msg-999", messageId: "inbound-msg-123" }),
      );
      const entry = (state.replyContextQueue.get(CHAT_SK + "|user-1") || [])[0];
      assert.ok(entry, "reply context entry captured");
      // Outbound anchor (plan 616): the reply must quote the INBOUND member
      // message, not the message the member quoted (which may be the agent's own).
      assert.equal(entry.msgId, "inbound-msg-123", "inbound id wins over the quoted id");
    });

    it("plan 035: falls back to the inbound message id (ctx.messageId) when not a quote-reply", () => {
      gate.onMessageReceived(
        { text: "danke!" },
        makeDefaultCtx({ senderId: "user-1", replyToSender: "81000000000001", messageId: "inbound-msg-123" }),
      );
      const entry = (state.replyContextQueue.get(CHAT_SK + "|user-1") || [])[0];
      assert.equal(entry.msgId, "inbound-msg-123", "inbound id used when no quoted id present");
    });

    it("plan 035: leaves msgId empty when no id is derivable", () => {
      gate.onMessageReceived(
        { text: "danke!" },
        makeDefaultCtx({ senderId: "user-1", replyToSender: "81000000000001" }),
      );
      const entry = (state.replyContextQueue.get(CHAT_SK + "|user-1") || [])[0];
      assert.equal(entry.msgId, "", "no id → empty msgId");
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
      for (let i = 0; i < 8; i++) state.pushTranscriptPeek(CHAT_SK, `[Nico] m${i}`);
      let captured;
      const pkGate = makeGate({
        engine: {
          async decide(opts) { captured = opts; return { decision: "speak", epoch: 5 }; },
        },
        readTranscript: async () => [
          { speaker: "User", text: "Hey Hori, wie ist das Wetter?" },
          { speaker: "Hori", text: "klar und sonnig" },
          { speaker: "Nico", text: "m7" },
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

    it("decide receives hasMedia + mediaKind from a cached media message", async () => {
      let captured;
      const mediaGate = makeGate({
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
      });
      mediaGate.onMessageReceived(
        { media: [{ kind: "image", path: "/tmp/pic.jpg" }], content: "" },
        makeDefaultCtx(),
      );
      const result = await mediaGate.onBeforeAgentReply(
        makeReplyEvent({ cleanedBody: "" }),
        makeDefaultCtx(),
      );
      assert.equal(result, undefined, "media-only decide speaks (LLM gate is the group guard)");
      assert.equal(captured.hasMedia, true);
      assert.equal(captured.mediaKind, "image");
    });

    it("transcript marker uses placeholder for media-only message", async () => {
      let captured;
      const mediaGate = makeGate({
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
        observedStore: { readObserved: () => [], appendObserved: () => {} },
      });
      mediaGate.onMessageReceived(
        { media: [{ kind: "image" }], content: "" },
        makeDefaultCtx(),
      );
      await mediaGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "" }), makeDefaultCtx());
      const last = (captured.transcript || []).slice(-1)[0];
      assert.equal(last.speaker, "Nico");
      assert.equal(last.text, "[image]");
    });

    it("media with caption carries marker+caption as the transcript text", async () => {
      let captured;
      const mediaGate = makeGate({
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
        observedStore: { readObserved: () => [], appendObserved: () => {} },
      });
      mediaGate.onMessageReceived(
        { media: [{ kind: "image" }], content: "nice send!" },
        makeDefaultCtx(),
      );
      await mediaGate.onBeforeAgentReply(
        makeReplyEvent({ cleanedBody: "nice send!" }),
        makeDefaultCtx(),
      );
      const last = (captured.transcript || []).slice(-1)[0];
      assert.equal(last.text, "[image] nice send!", "caption text is preserved with the media marker");
      assert.equal(captured.hasMedia, true);
    });

    it("non-media flow: decide receives hasMedia:false", async () => {
      let captured;
      const plainGate = makeGate({
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
        observedStore: { readObserved: () => [], appendObserved: () => {} },
      });
      await plainGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "Hello bot" }), makeDefaultCtx());
      assert.equal(captured.hasMedia, false);
      assert.equal(captured.mediaKind, undefined);
    });

    it("merges observed-store layer with hydrated and peek, deduped, chronological, capped at 20", async () => {
      for (let i = 0; i < 6; i++) state.pushTranscriptPeek(CHAT_SK, `[Nico] p${i}`, undefined, 1100 + i * 100);
      state.pushTranscriptPeek(CHAT_SK, "[Nico] older silenced", undefined, 1000);
      let captured;
      const obsGate = makeGate({
        observedStore: {
          readObserved: () => [{ speaker: "Nico", text: "older silenced", ts: 1000 }],
          appendObserved: () => {},
        },
        engine: {
          async decide(opts) { captured = opts; return { decision: "speak", epoch: 5 }; },
        },
        readTranscript: async () => [{ speaker: "Hori", text: "assistant note", ts: 3000 }],
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
      assert.ok(texts.indexOf("older silenced") < texts.indexOf("assistant note"), "older observed sorts before fresh hydrated");
      assert.ok(texts.indexOf("older silenced") < texts.indexOf("p0"), "observed before peek");
      assert.ok(texts.indexOf("p5") < texts.indexOf("assistant note"), "fresh hydrated sorts after older peek lines");
      assert.equal(texts[texts.length - 1], "current prompt", "current prompt is last");
    });

    it("chronological merge: layers with interleaved ts merge oldest → newest, current message last", async () => {
      state.pushTranscriptPeek(CHAT_SK, "[Nico] peek-mid", undefined, 1500);
      let captured;
      const sortGate = makeGate({
        observedStore: {
          readObserved: () => [{ speaker: "Nico", text: "old silenced", ts: 1000 }],
          appendObserved: () => {},
        },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
        readTranscript: async () => [
          { speaker: "Hori", text: "fresh hydrated", ts: 3000 },
          { speaker: "User", text: "older hydrated", ts: 900 },
        ],
      });

      await sortGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "aktuelle frage" }), makeDefaultCtx());
      const texts = (captured.transcript || []).map((t) => t.text);
      assert.deepEqual(texts, [
        "older hydrated",
        "old silenced",
        "peek-mid",
        "fresh hydrated",
        "aktuelle frage",
      ], "merged transcript is chronological with the current message last");
    });

    it("named-first dedup: named peek copy wins over anonymous hydrated copy, exactly one line survives (Plan 543)", async () => {
      state.pushTranscriptPeek(CHAT_SK, "[Anna] shared remark", undefined, 1500);
      let captured;
      const namedGate = makeGate({
        observedStore: { readObserved: () => [], appendObserved: () => {} },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
        readTranscript: async () => [{ speaker: "User", text: "shared remark", ts: 1500 }],
      });

      await namedGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "current" }), makeDefaultCtx());
      const transcript = captured.transcript || [];
      const matches = transcript.filter((t) => t.text === "shared remark");
      assert.equal(matches.length, 1, "duplicate text deduped to exactly one line");
      assert.equal(matches[0].speaker, "Anna", "named peek copy survives dedup, not the anonymous hydrated copy");
    });

    it("hydrated-only turn stays as gap-filler with speaker User and its real ts (Plan 543)", async () => {
      let captured;
      const gapGate = makeGate({
        observedStore: { readObserved: () => [], appendObserved: () => {} },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
        readTranscript: async () => [{ speaker: "User", text: "hydrated only turn", ts: 900 }],
      });

      await gapGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "current" }), makeDefaultCtx());
      const transcript = captured.transcript || [];
      const entry = transcript.find((t) => t.text === "hydrated only turn");
      assert.ok(entry, "hydrated-only turn present");
      assert.equal(entry.speaker, "User", "hydrated-only turn keeps User fallback speaker");
      assert.equal(entry.ts, 900, "hydrated-only turn keeps its real ts");
    });

    it("decide-ctx lastSpeaker reflects the named copy over the anonymous hydrated copy (Plan 543)", async () => {
      const lines = [];
      const log = { info: (m) => lines.push(m), warn() {}, debug() {} };
      state.pushTranscriptPeek(CHAT_SK, "[Nico] topical follow-up", undefined, Date.now() - 500);
      let captured;
      const lastGate = makeGate({
        log,
        observedStore: { readObserved: () => [], appendObserved: () => {} },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
        readTranscript: async () => [{ speaker: "User", text: "topical follow-up", ts: Date.now() - 500 }],
      });

      await lastGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "topical follow-up" }), makeDefaultCtx());
      const transcript = captured.transcript || [];
      assert.equal(transcript.filter((t) => t.text === "topical follow-up").length, 1, "named/anonymous/current copies collapse to exactly one line");
      const line = lines.find((l) => l.includes("decide-ctx"));
      assert.ok(line, "decide-ctx log line present");
      assert.ok(line.includes("lastSpeaker=Nico"), "lastSpeaker reflects the named copy, not User");
    });

    it("speaker-aware dedup: distinct named speakers with identical text both survive (observed vs current)", async () => {
      let captured;
      const dupGate = makeGate({
        observedStore: {
          readObserved: () => [{ speaker: "Ada", text: "ok", ts: 1000 }],
          appendObserved: () => {},
        },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
        readTranscript: async () => [],
      });

      await dupGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "ok" }), makeDefaultCtx());
      const transcript = captured.transcript || [];
      const occ = transcript.filter((t) => t.text === "ok");
      assert.equal(occ.length, 2, "two distinct speakers with identical text are NOT collapsed");
      assert.ok(occ.some((t) => t.speaker === "Ada"), "first speaker present");
      assert.ok(occ.some((t) => t.speaker === "Nico"), "current speaker present");
    });

    it("speaker-aware dedup: distinct speakers with identical media marker [image] both survive", async () => {
      let captured;
      const mediaGate = makeGate({
        observedStore: {
          readObserved: () => [{ speaker: "Ada", text: "[image]", ts: 1000 }],
          appendObserved: () => {},
        },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
        readTranscript: async () => [],
      });
      mediaGate.onMessageReceived({ media: [{ kind: "image" }], content: "" }, makeDefaultCtx());

      await mediaGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "" }), makeDefaultCtx());
      const transcript = captured.transcript || [];
      const occ = transcript.filter((t) => t.text === "[image]");
      assert.equal(occ.length, 2, "media markers from distinct speakers are NOT collapsed");
      assert.ok(occ.some((t) => t.speaker === "Ada"), "first speaker marker present");
      assert.ok(occ.some((t) => t.speaker === "Nico"), "current speaker marker present");
    });

    it("speaker-aware dedup: same speaker + same text in peek and current collapses to one line", async () => {
      state.pushTranscriptPeek(CHAT_SK, "[Nico] danke", undefined, 1000);
      let captured;
      const sameGate = makeGate({
        observedStore: { readObserved: () => [], appendObserved: () => {} },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
        readTranscript: async () => [],
      });

      await sameGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "danke" }), makeDefaultCtx());
      const transcript = captured.transcript || [];
      assert.equal(transcript.filter((t) => t.text === "danke").length, 1, "same speaker same text still dedupes");
    });

    it("speaker-aware dedup: pushPeekDedup keeps distinct speakers with same media marker (full-line equality)", async () => {
      gate.onBeforeAgentRun({ prompt: "[image]" }, makeDefaultCtx({ senderName: undefined, senderId: "4915000000001" }));
      gate.onBeforeAgentRun({ prompt: "[image]" }, makeDefaultCtx({ senderName: undefined, senderId: "4915000000002" }));
      const peek = state.transcriptPeekBySession.get(CHAT_SK);
      const imageLines = peek.filter((l) => l.endsWith("] [image]"));
      assert.equal(imageLines.length, 2, "both distinct-speaker media markers survive in the peek layer");
    });

    it("ts-less entries sort after all ts entries, stable among themselves", async () => {
      state.pushTranscriptPeek(CHAT_SK, "[Nico] no-ts one");
      state.pushTranscriptPeek(CHAT_SK, "[Nico] no-ts two");
      let captured;
      const tslessGate = makeGate({
        observedStore: {
          readObserved: () => [{ speaker: "Nico", text: "with ts", ts: 1000 }],
          appendObserved: () => {},
        },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
        readTranscript: async () => [{ speaker: "Hori", text: "hydrated ts-less" }],
      });

      await tslessGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "neu hier" }), makeDefaultCtx());
      const texts = (captured.transcript || []).map((t) => t.text);
      assert.deepEqual(texts, ["with ts", "neu hier", "no-ts one", "no-ts two", "hydrated ts-less"]);
    });

    it("merge + slice(-20) cuts the oldest lines and keeps the current message last", async () => {
      const observed = [];
      for (let i = 0; i < 25; i++) observed.push({ speaker: "Nico", text: `m${i}`, ts: 1000 + i });
      let captured;
      const capGate = makeGate({
        observedStore: {
          readObserved: () => observed,
          appendObserved: () => {},
        },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
      });

      await capGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "brandaktuell" }), makeDefaultCtx());
      const transcript = captured.transcript || [];
      const texts = transcript.map((t) => t.text);
      assert.equal(transcript.length, 20, "capped at 20 lines");
      assert.equal(texts[0], "m6", "oldest lines are cut first");
      assert.equal(texts[texts.length - 1], "brandaktuell", "current message survives as the last line");
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
      assert.equal(appends[0].speaker, "Nico");
      assert.equal(appends[0].text, "Hello bot");
      assert.ok(typeof appends[0].ts === "number");
    });

    it("speak persists the inbound message to the observed store (two-sided)", async () => {
      const appends = [];
      const speakGate = makeGate({
        observedStore: {
          readObserved: () => [],
          appendObserved: (sk, row) => appends.push({ sk, ...row }),
        },
        engine: { async decide() { return { decision: "speak", epoch: 1 }; } },
      });

      const result = await speakGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(result, undefined, "speak returns undefined");
      assert.equal(appends.length, 1, "one observed-store row written on speak");
      assert.equal(appends[0].sk, CHAT_SK);
      assert.equal(appends[0].speaker, "Nico");
      assert.equal(appends[0].text, "Hello bot");
      assert.ok(typeof appends[0].ts === "number");
    });

    it("quoted-audio labeling: the decide transcript labels User text and marks the quoted transcript as context (plan 621)", async () => {
      const { buildDecidePrompt } = await import("../lib/local-prompts.js");
      const body = "[Audio]\nUser text:\nhow icy is the north ridge?\nTranscript:\nnordgrat ist vereist";
      let captured;
      const qGate = makeGate({
        observedStore: { readObserved: () => [], appendObserved: () => {} },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
      });
      await qGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: body }), makeDefaultCtx());
      const p = buildDecidePrompt({ agentName: "OpenClaw", transcript: captured.transcript });
      assert.ok(p.userMessage.includes("how icy is the north ridge?"), "user text present");
      assert.ok(
        p.userMessage.includes("[quoted earlier message (context, not the current ask):] nordgrat ist vereist"),
        "quoted transcript carries the context marker",
      );
      const start = p.userMessage.indexOf("<<<GROUP CHAT LOG (untrusted)>>>");
      const end = p.userMessage.indexOf("<<<END GROUP CHAT LOG>>>");
      const quoted = p.userMessage.indexOf("nordgrat ist vereist");
      const user = p.userMessage.indexOf("how icy is the north ridge?");
      assert.ok(start >= 0 && start < quoted && quoted < end, "quoted transcript is inside the untrusted block");
      assert.ok(start < user && user < end, "user text is inside the untrusted block");
    });

    it("quoted-audio labeling: the raw body is what is persisted to the observed store (plan 621)", async () => {
      const body = "[Audio]\nUser text:\nhow icy is the north ridge?\nTranscript:\nnordgrat ist vereist";
      const appends = [];
      const qGate = makeGate({
        observedStore: { readObserved: () => [], appendObserved: (sk, row) => appends.push({ sk, ...row }) },
        engine: { async decide() { return { decision: "speak", epoch: 1 }; } },
      });
      await qGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: body }), makeDefaultCtx());
      assert.equal(appends.length, 1, "one observed row written");
      assert.equal(appends[0].text, body, "observed store keeps the original body, unlabeled");
    });

    it("speak-persisted inbound does not duplicate in the next decide transcript", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-speak-dup-"));
      try {
        const store = createObservedStore({ stateDir: tmpDir, log: { info() {}, warn() {}, debug() {} } });
        let captured;
        const speakGate = makeGate({
          observedStore: store,
          engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
        });
        await speakGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "erste frage" }), makeDefaultCtx());
        await speakGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "zweite frage" }), makeDefaultCtx());
        const texts = (captured.transcript || []).map((t) => t.text);
        assert.equal(texts.filter((t) => t === "erste frage").length, 1, "persisted inbound appears exactly once");
        assert.equal(texts[texts.length - 1], "zweite frage", "current message stays last");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("capture gap: silent media-only message persists with the marker to the observed store", async () => {
      const appends = [];
      const mediaGate = makeGate({
        observedStore: {
          readObserved: () => [],
          appendObserved: (sk, row) => appends.push({ sk, ...row }),
        },
        engine: { async decide() { return { decision: "stay_silent", epoch: 1 }; } },
      });
      mediaGate.onMessageReceived({ media: [{ kind: "image" }], content: "" }, makeDefaultCtx());

      const result = await mediaGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "" }), makeDefaultCtx());
      assert.deepEqual(result, { handled: true });
      assert.equal(appends.length, 1, "media-only silence persists a row despite empty body");
      assert.equal(appends[0].speaker, "Nico");
      assert.equal(appends[0].text, "[image]", "observed row carries the media marker, not empty text");
    });

    it("own replies survive restart in decide context (fresh observed store reload)", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-own-restart-"));
      try {
        const pre = createObservedStore({ stateDir: tmpDir, log: { info() {}, warn() {}, debug() {} } });
        pre.appendObserved(CHAT_SK, { speaker: "Anna", text: "frage von vor dem restart", ts: 1000 });
        pre.appendObserved(CHAT_SK, { speaker: "OpenClaw", text: "meine antwort von vor dem restart", ts: 2000 });
        pre.appendObserved(CHAT_SK, { speaker: "Nico", text: "antwort auf die alte antwort", ts: 3000 });

        const fresh = createObservedStore({ stateDir: tmpDir, log: { info() {}, warn() {}, debug() {} } });
        let captured;
        const restartGate = makeGate({
          observedStore: fresh,
          engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
        });

        await restartGate.onBeforeAgentReply(
          makeReplyEvent({ cleanedBody: "neue nachricht nach dem restart" }),
          makeDefaultCtx(),
        );
        const transcript = captured.transcript || [];
        const texts = transcript.map((t) => t.text);
        const own = transcript.find((t) => t.text === "meine antwort von vor dem restart");
        assert.ok(own, "own pre-restart line present in decide transcript");
        assert.equal(own.speaker, "OpenClaw");
        assert.equal(own.ts, 2000, "own line keeps its chronological ts");
        assert.ok(texts.indexOf("frage von vor dem restart") < texts.indexOf("meine antwort von vor dem restart"), "own line lands chronologically, not appended at the end");
        assert.ok(texts.indexOf("meine antwort von vor dem restart") < texts.indexOf("antwort auf die alte antwort"), "own line stays before later member lines");
        assert.equal(texts[texts.length - 1], "neue nachricht nach dem restart", "current prompt is last");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("own line present in both peek and observed store renders exactly once in the merged transcript", async () => {
      state.pushTranscriptPeek(CHAT_SK, "[Anna] frage an die gruppe");
      state.pushTranscriptPeek(CHAT_SK, "[OpenClaw] ich war vorher da");
      let captured;
      const dupGate = makeGate({
        observedStore: {
          readObserved: () => [
            { speaker: "OpenClaw", text: "ich war vorher da", ts: 500 },
          ],
          appendObserved: () => {},
        },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
      });

      await dupGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "neue nachricht" }), makeDefaultCtx());
      const transcript = captured.transcript || [];
      const occurrences = transcript.filter((t) => t.text === "ich war vorher da");
      assert.equal(occurrences.length, 1, "own line in peek AND store appears exactly once");
    });

    it("decide-ctx log line carries counts + speaker label only, session key redacted (group path)", async () => {
      const lines = [];
      const log = { info: (m) => lines.push(m), warn() {}, debug() {} };
      const groupSk = "agent:test-agent:whatsapp:group:120363000000001@g.us";
      const now = Date.now();
      state.pushTranscriptPeek(groupSk, "[Nico] frage an alle", undefined, now - 5000);
      state.pushTranscriptPeek(groupSk, "[OpenClaw] meine antwort", undefined, now - 3000);
      let captured;
      const ctxGate = makeGate({
        log,
        observedStore: { readObserved: () => [], appendObserved: () => {} },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
      });

      await ctxGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx({ sessionKey: groupSk }));
      assert.ok(captured, "decide ran");
      const line = lines.find((l) => l.includes("human-engine: decide-ctx"));
      assert.ok(line, "decide-ctx log line present");
      assert.ok(line.includes("…0001"), "session key redacted to last 4 digits");
      assert.ok(!line.includes("120363000000001"), "full session key must not appear");
      assert.ok(line.includes("lines=3"), "counts the merged transcript lines");
      assert.ok(line.includes("own=1"), "counts own lines by agentName");
      assert.ok(line.includes("lastSpeaker=Nico"), "last speaker label present");
      assert.ok(/lastAgeMs=\d+/.test(line), "last age in ms present");
      assert.ok(!line.includes("Hello bot"), "no message text in the log");
      assert.ok(!line.includes("frage an alle"), "no message text in the log");
      assert.ok(!line.includes("meine antwort"), "no message text in the log");
    });

    it("no decide-ctx log line for DM sessions (group path only)", async () => {
      const lines = [];
      const log = { info: (m) => lines.push(m), warn() {}, debug() {} };
      const dmGate = makeGate({
        log,
        engine: { async decide() { return { decision: "speak", epoch: 1 }; } },
      });

      await dmGate.onBeforeAgentReply(
        makeReplyEvent(),
        makeDefaultCtx({ sessionKey: "agent:test-agent:telegram:direct:120363000000001" }),
      );
      assert.equal(lines.filter((l) => l.includes("decide-ctx")).length, 0, "DM decide stays log-silent for decide-ctx");
    });

    it("decide-ctx selfVoiceLen=0 when persona has no active self-voice card", async () => {
      const lines = [];
      const log = { info: (m) => lines.push(m), warn() {}, debug() {} };
      const ctxGate = makeGate({
        log,
        persona: { ...persona, snapshotFor: () => null },
        engine: { async decide() { return { decision: "speak", epoch: 1 }; } },
      });
      await ctxGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      const line = lines.find((l) => l.includes("decide-ctx"));
      assert.ok(line, "decide-ctx log line present");
      assert.ok(line.includes("selfVoiceLen=0"), "selfVoiceLen=0 when no active card");
    });

    it("decide-ctx selfVoiceLen>0 when persona exposes an active self-voice card", async () => {
      const lines = [];
      const log = { info: (m) => lines.push(m), warn() {}, debug() {} };
      const fakeCard = "Your own voice: keep it consistent, short, casual.";
      const ctxGate = makeGate({
        log,
        persona: { ...persona, snapshotFor: () => fakeCard },
        engine: { async decide() { return { decision: "speak", epoch: 1 }; } },
      });
      await ctxGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      const line = lines.find((l) => l.includes("decide-ctx"));
      assert.ok(line, "decide-ctx log line present");
      assert.ok(line.includes(`selfVoiceLen=${fakeCard.length}`), "selfVoiceLen reflects the active card length");
    });

    it("decide-ctx selfVoiceLen stays 0 when persona.snapshotFor throws (fail-open)", async () => {
      const lines = [];
      const log = { info: (m) => lines.push(m), warn() {}, debug() {} };
      const ctxGate = makeGate({
        log,
        persona: { ...persona, snapshotFor: () => { throw new Error("boom"); } },
        engine: { async decide() { return { decision: "speak", epoch: 1 }; } },
      });
      await ctxGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      const line = lines.find((l) => l.includes("decide-ctx"));
      assert.ok(line, "decide-ctx log line present");
      assert.ok(line.includes("selfVoiceLen=0"), "fail-open selfVoiceLen=0");
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

    it("stashes the speak path into speakPathBySession (hard)", async () => {
      const pathGate = makeGate({
        engine: { async decide() { return { decision: "speak", epoch: 1, path: "hard" }; } },
      });
      await pathGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(state.speakPathBySession.get(CHAT_SK), "hard");
    });

    it("stashes the speak path into speakPathBySession on the burst-reuse path (llm)", async () => {
      let decideCount = 0;
      const burstGate = makeGate({
        engine: {
          async decide() {
            decideCount++;
            await new Promise((r) => setTimeout(r, 20));
            return { decision: "speak", epoch: 1, path: "llm" };
          },
        },
      });
      const results = await Promise.all([
        burstGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "m1" }), makeDefaultCtx()),
        burstGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "m2" }), makeDefaultCtx()),
      ]);
      assert.equal(decideCount, 1, "decide called once for the burst");
      for (const r of results) assert.equal(r, undefined);
      assert.equal(state.speakPathBySession.get(CHAT_SK), "llm", "burst-reuse speak stashes the path");
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

    it("decide transcript entries carry ts after merge (peek + observed)", async () => {
      state.pushTranscriptPeek(CHAT_SK, "[Nico] fresh", undefined, 1000);
      let captured;
      const tsGate = makeGate({
        observedStore: {
          readObserved: () => [{ speaker: "Ada", text: "older silenced", ts: 500 }],
          appendObserved: () => {},
        },
        engine: {
          async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; },
        },
        readTranscript: async () => [{ speaker: "Hori", text: "assistant note", ts: 2000 }],
      });

      await tsGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "current" }), makeDefaultCtx());
      const transcript = captured.transcript || [];
      const older = transcript.find((t) => t.text === "older silenced");
      const peek = transcript.find((t) => t.text === "fresh");
      const hyd = transcript.find((t) => t.text === "assistant note");
      assert.equal(older.ts, 500, "observed layer ts preserved");
      assert.equal(peek.ts, 1000, "peek layer ts preserved");
      assert.equal(hyd.ts, 2000, "hydrated layer ts preserved");
    });

    it("stay_silent log line redacts the session-key numeric tail", async () => {
      const lines = [];
      const log = { info: (m) => lines.push(m), warn() {}, debug() {} };
      const redactGate = createGate({
        cfg,
        state,
        engine: makeEngine(),
        persona,
        socialMemory: makeSocialMemoryStub(),
        log,
      });
      const groupSk = "agent:test-agent:whatsapp:group:120363000000001@g.us";
      const result = await redactGate.onBeforeAgentReply(
        makeReplyEvent(),
        makeDefaultCtx({ sessionKey: groupSk })
      );
      assert.deepEqual(result, { handled: true });
      const line = lines.find((l) => l.includes("stay_silent handled"));
      assert.ok(line, "expected a stay_silent log line");
      assert.ok(line.includes("…0001"), "log should keep only the last 4 digits");
      assert.ok(!line.includes("120363000000001"), "log must not contain the full number");
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
      state.transcriptPeekBySession.set(CHAT_SK, ["[Nico] Hey Hori", "[Hori] Ja?"]);
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
      assert.equal(hey.speaker, "Nico");
      assert.ok(transcript.some((t) => t.text.includes("Was sagst du?")), "transcript should include current prompt");
    });

    it("decide gets a lean persona (soul only, no anti-tell block)", async () => {
      let captured;
      const leanGate = makeGate({
        persona: {
          buildPersonaPrompt() { return "lean soul prompt"; },
        },
        engine: {
          async decide(opts) { captured = opts; return { decision: "stay_silent", epoch: 2 }; },
        },
      });
      await leanGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(captured.persona, "lean soul prompt");
      assert.equal(captured.voiceCard, null, "voiceCard arg stays null (card travels in persona block)");
      assert.ok(!("systemPrompt" in captured), "dead systemPrompt arg must not be passed to engine.decide");
    });

    it("decide persona carries the voice card and style constraint; voiceCard arg stays null", async () => {
      const persona = await import("../lib/persona.js");
      persona.setVoiceCardGetter(() => "# Room Voice Card: kurz, emoji-lastig, casual");
      const peek = [];
      for (let i = 0; i < 12; i++) peek.push("[Nico] hi number " + i);
      state.transcriptPeekBySession.set(CHAT_SK, peek);

      let captured;
      const cardGate = makeGate({
        persona,
        cfg: { ...cfg, styleStats: true, agentName: "OpenClaw", agentAliases: [] },
        engine: {
          async decide(opts) { captured = opts; return { decision: "stay_silent", epoch: 3 }; },
        },
      });
      await cardGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.ok(captured.persona.includes("Room Voice Card"), "decide persona should include the voice card");
      assert.ok(captured.persona.length >= 10, "decide persona should include style constraint / persona content");
      assert.equal(captured.voiceCard, null, "voiceCard arg stays null to avoid duplication");
      assert.ok(!("systemPrompt" in captured), "dead systemPrompt arg must not be passed to engine.decide");
    });

    it("decide persona without card/peek-stats degrades to soul + anti-tell (no break)", async () => {
      const persona = await import("../lib/persona.js");
      persona.setVoiceCardGetter(null);
      state.transcriptPeekBySession.delete(CHAT_SK);

      let captured;
      const plainGate = makeGate({
        persona,
        cfg: { ...cfg, styleStats: true, agentName: "OpenClaw", agentAliases: [] },
        engine: {
          async decide(opts) { captured = opts; return { decision: "stay_silent", epoch: 4 }; },
        },
      });
      await plainGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(captured.voiceCard, null, "voiceCard arg stays null");
      assert.ok(!("systemPrompt" in captured), "dead systemPrompt arg must not be passed to engine.decide");
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

    it("passes replyToAgent=true via body-match against hydrated transcript lines when peek is empty", async () => {
      let captured;
      const bodyGate = makeGate({
        cfg: { ...cfg, agentName: "Hori" },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
        readTranscript: async () => [
          { speaker: "Nico", text: "wie wird das wetter am wochenende?" },
          { speaker: "Hori", text: "klar und sonnig am Berg, perfekt fuer den Klettersteig" },
        ],
      });
      bodyGate.onMessageReceived(
        { text: "danke" },
        makeDefaultCtx({ replyToBody: "klar und sonnig am Berg, perfekt fuer den Klettersteig" }),
      );
      await bodyGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "danke!" }), makeDefaultCtx());
      assert.equal(captured.replyToAgent, true);
    });

    it("persists a reply target on speak for a reply-to-agent message", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-replytarget-"));
      const cFile = path.join(tmpDir, "contacts.md");
      fs.writeFileSync(cFile, "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 81000000000001 | +4915000000002 | OpenClaw (Bot) | |\n");

      const targetGate = makeGate({
        cfg: { ...cfg, contactsPath: cFile },
        engine: { async decide() { return { decision: "speak", epoch: 1 }; } },
      });
      targetGate.onMessageReceived(
        { text: "danke!" },
        makeDefaultCtx({ senderId: "user-1", replyToSender: "81000000000001", replyToBody: "Ja, gut" }),
      );
      await targetGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "danke!" }), makeDefaultCtx({ senderId: "user-1" }));
      const entry = state.replyTargetBySession.get(CHAT_SK);
      assert.ok(entry, "reply target persisted on speak");
      assert.equal(entry.replyToAgent, true);
      assert.equal(entry.quotedName, "OpenClaw (Bot)");
      assert.equal(entry.textHead, "Ja, gut");
      assert.ok(typeof entry.ts === "number");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("persists a reply target on the burst-reuse speak path (quoting a human, non-trigger)", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-replytarget-burst-"));
      const cFile = path.join(tmpDir, "contacts.md");
      fs.writeFileSync(cFile, "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 81000000000002 | +4915000000003 | Basti | |\n");

      let decideCount = 0;
      const burstGate = makeGate({
        cfg: { ...cfg, contactsPath: cFile },
        engine: {
          async decide() {
            decideCount++;
            await new Promise((r) => setTimeout(r, 20));
            return { decision: "speak", epoch: 1 };
          },
        },
      });
      burstGate.onMessageReceived(
        { text: "was sagst du dazu" },
        makeDefaultCtx({ senderId: "user-b", replyToSender: "81000000000002", replyToBody: "was sagst du dazu" }),
      );
      const results = await Promise.all([
        burstGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "chatty filler" }), makeDefaultCtx({ senderId: "user-a" })),
        burstGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "was sagst du dazu" }), makeDefaultCtx({ senderId: "user-b" })),
      ]);
      assert.equal(decideCount, 1, "decide called once for the burst");
      for (const r of results) assert.equal(r, undefined);
      const entry = state.replyTargetBySession.get(CHAT_SK);
      assert.ok(entry, "reply target persisted on burst-reuse speak path");
      assert.equal(entry.replyToAgent, false);
      assert.equal(entry.quotedName, "Basti");
      assert.equal(entry.textHead, "was sagst du dazu");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("plan 035: reply target carries replyToId from the quoted-message id on speak", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-replytarget-id-"));
      const cFile = path.join(tmpDir, "contacts.md");
      fs.writeFileSync(cFile, "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 81000000000001 | +4915000000002 | OpenClaw (Bot) | |\n");

      const targetGate = makeGate({
        cfg: { ...cfg, contactsPath: cFile },
        engine: { async decide() { return { decision: "speak", epoch: 1 }; } },
      });
      targetGate.onMessageReceived(
        { text: "danke!" },
        makeDefaultCtx({ senderId: "user-1", replyToSender: "81000000000001", replyToBody: "Ja, gut", replyToId: "quoted-msg-777" }),
      );
      await targetGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "danke!" }), makeDefaultCtx({ senderId: "user-1" }));
      const entry = state.replyTargetBySession.get(CHAT_SK);
      assert.ok(entry, "reply target persisted on speak");
      assert.equal(entry.replyToAgent, true);
      assert.equal(entry.replyToId, "quoted-msg-777", "replyToId = quoted-message id");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("plan 616: when a member quotes the agent's own message, the reply anchors to the member's inbound message, not the quoted (own) id", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-replytarget-anchor-"));
      const cFile = path.join(tmpDir, "contacts.md");
      fs.writeFileSync(cFile, "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 81000000000001 | +4915000000002 | OpenClaw (Bot) | |\n");

      const anchorGate = makeGate({
        cfg: { ...cfg, contactsPath: cFile },
        engine: { async decide() { return { decision: "speak", epoch: 1 }; } },
      });
      // Member quotes the AGENT's own message (replyToSender = the agent's own
      // contact, so replyToAgent=true) and sends it as a NEW inbound message.
      anchorGate.onMessageReceived(
        { text: "danke!" },
        makeDefaultCtx({
          senderId: "user-1",
          replyToSender: "81000000000001",
          replyToBody: "Ja, gut",
          replyToId: "agent-own-msg-id",
          messageId: "member-msg-id",
        }),
      );
      await anchorGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "danke!" }), makeDefaultCtx({ senderId: "user-1" }));
      const entry = state.replyTargetBySession.get(CHAT_SK);
      assert.ok(entry, "reply target persisted on speak");
      assert.equal(entry.replyToAgent, true, "member quoted the agent's own message");
      // Outbound anchor must be the member's inbound message, NOT the agent's own.
      assert.equal(entry.replyToId, "member-msg-id", "replyToId anchors to the inbound member message, not the agent's own");
      assert.notEqual(entry.replyToId, "agent-own-msg-id", "must never quote the agent's own message");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("plan 035: reply target replyToId is null when no id was captured", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-replytarget-noid-"));
      const cFile = path.join(tmpDir, "contacts.md");
      fs.writeFileSync(cFile, "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 81000000000001 | +4915000000002 | OpenClaw (Bot) | |\n");

      const targetGate = makeGate({
        cfg: { ...cfg, contactsPath: cFile },
        engine: { async decide() { return { decision: "speak", epoch: 1 }; } },
      });
      targetGate.onMessageReceived(
        { text: "danke!" },
        makeDefaultCtx({ senderId: "user-1", replyToSender: "81000000000001", replyToBody: "Ja, gut" }),
      );
      await targetGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "danke!" }), makeDefaultCtx({ senderId: "user-1" }));
      const entry = state.replyTargetBySession.get(CHAT_SK);
      assert.equal(entry.replyToId, null, "no id → replyToId null");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("does not persist a reply target for plain chatter speak", async () => {
      const chatterGate = makeGate({
        engine: { async decide() { return { decision: "speak", epoch: 1 }; } },
      });
      await chatterGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "Hello bot" }), makeDefaultCtx());
      assert.equal(state.replyTargetBySession.has(CHAT_SK), false);
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

    it("resolves per-agent contactsPath for sender name resolution", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-agent-contacts-"));
      const cFile = path.join(tmpDir, "contacts.md");
      fs.writeFileSync(cFile, "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 222 | +4900000001 | Alice | |\n");

      const agentCfg = {
        ...cfg,
        agentProfiles: {
          "test-agent": { agentName: "Alice", contactsPath: cFile },
        },
      };
      let captured;
      const contactGate = makeGate({
        cfg: agentCfg,
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
      });
      await contactGate.onBeforeAgentReply(
        makeReplyEvent({ cleanedBody: "servus" }),
        makeDefaultCtx({ senderName: undefined, senderId: "+4900000001" }),
      );
      const peek = state.transcriptPeekBySession.get(CHAT_SK) || [];
      assert.ok(peek[peek.length - 1].startsWith("[Alice] "), "sender resolved from per-agent contacts");
      assert.equal(captured.agentName, "Alice", "decide receives the per-agent name");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("hard trigger with the wrong agent name stays silent", async () => {
      let captured;
      const agentCfg = {
        ...cfg,
        agents: ["test-agent"],
        agentProfiles: {
          "test-agent": { agentName: "Alice" },
        },
      };
      const wrongNameGate = makeGate({
        cfg: agentCfg,
        engine: { async decide(opts) { captured = opts; return { decision: "stay_silent", epoch: 1 }; } },
      });
      // "hey Bob" mentions Bob, not Alice — Alice must not hard-trigger.
      const result = await wrongNameGate.onBeforeAgentReply(
        makeReplyEvent({ cleanedBody: "hey Bob, what do you think" }),
        makeDefaultCtx(),
      );
      assert.deepEqual(result, { handled: true }, "wrong agent name must not speak");
      assert.equal(captured?.prompt, "hey Bob, what do you think");
    });

    it("hard trigger with the correct per-agent name speaks", async () => {
      const agentCfg = {
        ...cfg,
        agents: ["test-agent"],
        agentProfiles: {
          "test-agent": { agentName: "Alice" },
        },
      };
      const correctGate = makeGate({
        cfg: agentCfg,
        engine: { async decide(opts) { return { decision: "speak", epoch: 1 }; } },
      });
      const result = await correctGate.onBeforeAgentReply(
        makeReplyEvent({ cleanedBody: "hey Alice, what do you think" }),
        makeDefaultCtx(),
      );
      assert.equal(result, undefined, "correct agent name should speak");
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

    it("decide receives compact memoryContext for an ingested person (recallCompact involved)", async () => {
      let captured;
      const memGate = makeGate({
        engine: { async decide(opts) { captured = opts; return { decision: "stay_silent", epoch: 1 }; } },
      });
      await memGate.onBeforeAgentReply(
        makeReplyEvent(),
        makeDefaultCtx({ sessionKey: "agent:test-agent:whatsapp:group:speak-turn@g.us" }),
      );
      assert.ok(captured.memoryContext, "memoryContext present for known sender");
      assert.ok(captured.memoryContext.includes("Alice"), "recallCompact result reflected in memoryContext");
    });

    it("decide receives null memoryContext for unknown sender", async () => {
      let captured;
      const memGate = makeGate({
        engine: { async decide(opts) { captured = opts; return { decision: "stay_silent", epoch: 1 }; } },
      });
      await memGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(captured.memoryContext, null);
    });

    it("decide memoryContext includes an explicitly mentioned third person", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-mention-contacts-"));
      const cFile = path.join(tmpDir, "contacts.md");
      fs.writeFileSync(
        cFile,
        "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 81000000000001 | +4915000000001 | Tobi | |\n",
      );
      const recorded = [];
      const memGate = makeGate({
        cfg: { ...cfg, contactsPath: cFile },
        socialMemory: {
          ingest: () => {},
          recall: (scope, names) => "",
          recallCompact: (scope, names, limit) => {
            recorded.push([scope, names]);
            return "Bob: is a beginner";
          },
        },
        engine: { async decide(opts) { return { decision: "stay_silent", epoch: 1 }; } },
      });
      await memGate.onBeforeAgentReply(
        makeReplyEvent({ cleanedBody: "was macht Tobi?" }),
        makeDefaultCtx(),
      );
      const involved = recorded[0][1];
      assert.ok(involved.includes("Tobi"), "mentioned third person in involved set: " + JSON.stringify(involved));
      fs.rmSync(tmpDir, { recursive: true, force: true });
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

    it("group fail-closed holds when resolveSender helper throws", async () => {
      const warns = [];
      const throwingCfg = { ...cfg };
      Object.defineProperty(throwingCfg, "contactsPath", { get() { throw new Error("boom"); } });
      const badGate = createGate({
        cfg: throwingCfg,
        state,
        engine: { async decide() { throw new Error("boom"); } },
        persona,
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn: (msg) => warns.push(msg), debug() {} },
      });
      const result = await badGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.deepEqual(result, { handled: true }, "group session must stay fail-closed");
      assert.ok(warns.some((w) => w.includes("fail-closed resolveSender error")), "should log the resolveSender failure");
    });

    it("DM sessions stay fail-open with the same throwing helper", async () => {
      const throwingCfg = { ...cfg };
      Object.defineProperty(throwingCfg, "contactsPath", { get() { throw new Error("boom"); } });
      const badGate = createGate({
        cfg: throwingCfg,
        state,
        engine: { async decide() { throw new Error("boom"); } },
        persona,
        socialMemory: makeSocialMemoryStub(),
        log: { info() {}, warn() {}, debug() {} },
      });
      const result = await badGate.onBeforeAgentReply(
        makeReplyEvent(),
        makeDefaultCtx({ sessionKey: "agent:test-agent:telegram:direct:12345" }),
      );
      assert.equal(result, undefined, "DM sessions stay fail-open by design");
    });

    it("silent burst: concurrent messages share one decide, each persists to observed", async () => {
      const appends = [];
      let decideCount = 0;
      const burstGate = makeGate({
        observedStore: {
          readObserved: () => [],
          appendObserved: (sk, row) => appends.push({ sk, ...row }),
        },
        engine: {
          async decide() {
            decideCount++;
            await new Promise((r) => setTimeout(r, 20));
            return { decision: "stay_silent", epoch: 1 };
          },
        },
      });

      const results = await Promise.all([
        burstGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "m1" }), makeDefaultCtx()),
        burstGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "m2" }), makeDefaultCtx()),
        burstGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "m3" }), makeDefaultCtx()),
      ]);

      assert.equal(decideCount, 1, "decide called exactly once for the burst");
      for (const r of results) assert.deepEqual(r, { handled: true });
      assert.equal(appends.length, 3, "one observed row persisted per message");
    });

    it("speak burst: concurrent messages share one decide, all return undefined", async () => {
      let decideCount = 0;
      const speakBurstGate = makeGate({
        engine: {
          async decide() {
            decideCount++;
            await new Promise((r) => setTimeout(r, 20));
            return { decision: "speak", epoch: 1 };
          },
        },
      });

      const results = await Promise.all([
        speakBurstGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "m1" }), makeDefaultCtx()),
        speakBurstGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "m2" }), makeDefaultCtx()),
        speakBurstGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "m3" }), makeDefaultCtx()),
      ]);

      assert.equal(decideCount, 1, "decide called exactly once for the burst");
      for (const r of results) assert.equal(r, undefined, "agent runs for each speak message");
    });

    it("sequential non-overlapping messages each get their own decide (no cache)", async () => {
      let decideCount = 0;
      const seqGate = makeGate({
        engine: {
          async decide() {
            decideCount++;
            return { decision: "stay_silent", epoch: 1 };
          },
        },
      });

      const first = await seqGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "m1" }), makeDefaultCtx());
      const second = await seqGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "m2" }), makeDefaultCtx());

      assert.deepEqual(first, { handled: true });
      assert.deepEqual(second, { handled: true });
      assert.equal(decideCount, 2, "second call after resolve triggers a fresh decide");
    });

    it("hard trigger during a burst short-circuits per-message without joining dedup", async () => {
      let decideCount = 0;
      const triggerBurstGate = makeGate({
        engine: {
          async decide(opts) {
            decideCount++;
            await new Promise((r) => setTimeout(r, 20));
            if (opts.prompt && opts.prompt.includes(cfg.agentName)) {
              return { decision: "speak", epoch: 1 };
            }
            return { decision: "stay_silent", epoch: 1 };
          },
        },
      });

      const [chatter, named] = await Promise.all([
        triggerBurstGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "chatty filler" }), makeDefaultCtx()),
        triggerBurstGate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: `hey ${cfg.agentName} what do you think` }), makeDefaultCtx()),
      ]);

      assert.deepEqual(chatter, { handled: true });
      assert.equal(named, undefined, "name-mention message speaks independently of the burst");
      assert.equal(decideCount, 2, "hard trigger runs its own decide without reusing the chatter verdict");
    });

    it("claims reason/addressed_to from the v2 decide result into the log", async () => {
      const lines = [];
      const v2Gate = makeGate({
        engine: { async decide() { return { decision: "stay_silent", epoch: 1, path: "llm", reason: "side chatter", addressedTo: "Alice" }; } },
        log: { info: (msg) => lines.push(msg), warn() {}, debug() {} },
      });
      await v2Gate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "yeah me too" }), makeDefaultCtx());
      const claim = lines.find((l) => l.includes("human-engine: claim"));
      assert.ok(claim, "claim log line emitted");
      assert.ok(claim.includes("reason=side chatter"), "claim log carries the v2 reason");
      assert.ok(claim.includes("addressed=Alice"), "claim log carries the addressed_to");
    });

    it("claim log omits reason/addressed when the v2 fields are absent", async () => {
      const lines = [];
      const v1Gate = makeGate({
        engine: { async decide() { return { decision: "stay_silent", epoch: 1, path: "llm" }; } },
        log: { info: (msg) => lines.push(msg), warn() {}, debug() {} },
      });
      await v1Gate.onBeforeAgentReply(makeReplyEvent({ cleanedBody: "yeah me too" }), makeDefaultCtx());
      const claim = lines.find((l) => l.includes("human-engine: claim"));
      assert.ok(claim, "claim log line emitted");
      assert.ok(!claim.includes("reason="), "no reason field when absent");
      assert.ok(!claim.includes("addressed="), "no addressed field when absent");
    });

    it("plan 030: group decide receives moodEnergy from mood.snapshotFor when groupsEnabled", async () => {
      let captured;
      const moodGate = makeGate({
        mood: { snapshotFor() { return { valence: 2, energy: 2 }; } },
        cfg: { ...cfg, mood: { enabled: true, groupsEnabled: true } },
        engine: { async decide(opts) { captured = opts; return { decision: "stay_silent", epoch: 1 }; } },
      });
      await moodGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(captured.moodEnergy, 2, "group decide receives the group energy snapshot");
    });

    it("plan 030: group decide receives moodEnergy null when no mood dep", async () => {
      let captured;
      const moodGate = makeGate({
        engine: { async decide(opts) { captured = opts; return { decision: "stay_silent", epoch: 1 }; } },
      });
      await moodGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(captured.moodEnergy, null, "no mood dep → moodEnergy null");
    });

    it("plan 030: DM decide never receives moodEnergy (groups-only)", async () => {
      let captured;
      const moodGate = makeGate({
        mood: { snapshotFor() { return { valence: 2, energy: 2 }; } },
        engine: { async decide(opts) { captured = opts; return { decision: "speak", epoch: 1 }; } },
      });
      await moodGate.onBeforeAgentReply(
        makeReplyEvent(),
        makeDefaultCtx({ sessionKey: "agent:test-agent:telegram:direct:123" }),
      );
      assert.equal(captured.moodEnergy, null, "DM stays byte-identical (no moodEnergy)");
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
      assert.ok(result.appendContext.includes("<<<GROUP CHAT LOG (untrusted)>>>"));
      assert.ok(result.appendContext.includes("<<<END GROUP CHAT LOG>>>"));

      const second = gate.onBeforePromptBuild({}, makeDefaultCtx());
      assert.equal(second, undefined);
    });

    it("injects memory into system context when present", () => {
      state.memoryBySession.set(CHAT_SK, "Alice: likes climbing");
      const result = gate.onBeforePromptBuild({}, makeDefaultCtx());
      assert.ok(result.appendSystemContext.includes("What you know about the people here"));
      assert.ok(result.appendSystemContext.includes("Alice"));
      assert.ok(result.appendSystemContext.includes("<<<GROUP CHAT LOG (untrusted)>>>"));
      assert.ok(result.appendSystemContext.includes("<<<END GROUP CHAT LOG>>>"));
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

    it("plan 035: reactions hint is absent by default (hintEnabled:false)", () => {
      const result = gate.onBeforePromptBuild({}, makeDefaultCtx());
      assert.equal(result, undefined, "no injection at all when hint disabled and nothing else to inject");
      state.memoryBySession.set(CHAT_SK, "Alice: likes climbing");
      const withMem = gate.onBeforePromptBuild({}, makeDefaultCtx());
      assert.ok(withMem.appendSystemContext.includes("What you know about the people here"));
      assert.ok(!withMem.appendSystemContext.includes("react action"), "no reaction hint when disabled");
    });

    it("plan 035: reactions hint injected into appendSystemContext for a group when hintEnabled:true", () => {
      const hintGate = makeGate({ cfg: { ...cfg, reactions: { hintEnabled: true } } });
      state.memoryBySession.set(CHAT_SK, "Alice: likes climbing");
      const result = hintGate.onBeforePromptBuild({}, makeDefaultCtx());
      assert.ok(result.appendSystemContext.includes("react action"), "hint present for group session");
      assert.ok(result.appendSystemContext.includes("sparingly"), "hint bounded instruction present");
    });

    it("plan 035: reactions hint is never injected for DM sessions", () => {
      const hintGate = makeGate({ cfg: { ...cfg, reactions: { hintEnabled: true } } });
      const dmSk = "agent:test-agent:telegram:direct:120363000000001";
      state.memoryBySession.set(dmSk, "mem");
      const result = hintGate.onBeforePromptBuild({}, makeDefaultCtx({ sessionKey: dmSk }));
      assert.ok(result.appendSystemContext.includes("What you know about the people here"));
      assert.ok(!result.appendSystemContext.includes("react action"), "no hint in DM");
    });

    it("plan 035: reactions hint does not flip a decide-eval scenario (config stays off in base cfg)", () => {
      // Base `cfg` in this suite has no reactions key → default false → never injected.
      const result = gate.onBeforePromptBuild({}, makeDefaultCtx());
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

  describe("threads injection", () => {
    it("decide receives threadContext from threads.contextFor when a line is active", async () => {
      let captured;
      const threads = {
        contextFor() {
          return "You last spoke here 2 days ago.\nA returning member briefly acknowledges the gap or picks up a thread — pick ONE, naturally.";
        },
        onActivity() {},
        onSpeak() {},
      };
      const tGate = createGate({
        cfg,
        state,
        engine: { async decide(opts) { captured = opts; return { decision: "stay_silent", epoch: 1 }; } },
        persona,
        socialMemory: makeSocialMemoryStub(),
        threads,
        log: { info() {}, warn() {}, debug() {} },
      });
      await tGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.ok(captured.threadContext, "threadContext passed to decide when active");
      assert.ok(captured.threadContext.includes("pick ONE"), "thread context line content carried");
    });

    it("decide receives threadContext:null when threads.contextFor returns nothing", async () => {
      let captured;
      const threads = { contextFor() { return null; }, onActivity() {}, onSpeak() {} };
      const tGate = createGate({
        cfg,
        state,
        engine: { async decide(opts) { captured = opts; return { decision: "stay_silent", epoch: 1 }; } },
        persona,
        socialMemory: makeSocialMemoryStub(),
        threads,
        log: { info() {}, warn() {}, debug() {} },
      });
      await tGate.onBeforeAgentReply(makeReplyEvent(), makeDefaultCtx());
      assert.equal(captured.threadContext, null, "no threadContext when no condition");
    });

    it("threadContext is rendered by buildDecidePrompt between the untrusted delimiters", async () => {
      const { buildDecidePrompt } = await import("../lib/local-prompts.js");
      const out = buildDecidePrompt({
        transcript: [],
        agentName: "Yuki",
        threadContext: "You last spoke here 2 days ago.\nOpen threads: foo.",
        v2Contract: false,
        language: "de",
      });
      assert.ok(out.systemPrompt.includes("<<<GROUP CHAT LOG (untrusted)>>>"), "thread context wrapped in untrusted log markers");
      assert.ok(out.systemPrompt.includes("<<<END GROUP CHAT LOG>>>"), "thread context wrapped in closing marker");
      assert.ok(out.systemPrompt.includes("You last spoke here 2 days ago."), "thread context content in system prompt");
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
