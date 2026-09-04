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
      assert.equal(state.senderBySession.get(CHAT_SK), "Nico");
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

    it("media with caption keeps the caption as the transcript text", async () => {
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
      assert.equal(last.text, "nice send!", "caption text is preserved, not replaced by marker");
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
      assert.deepEqual(texts, ["with ts", "neu hier", "hydrated ts-less", "no-ts one", "no-ts two"]);
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
