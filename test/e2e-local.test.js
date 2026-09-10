import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLocalEngine, getState } from "../lib/local-engine.js";
import { createNaturalize, clearAllBubbleTimers } from "../lib/naturalize.js";
import { createGate } from "../lib/gate.js";
import { createSocialMemory } from "../lib/social-memory.js";
import { resolveConfig } from "../lib/config.js";
import * as state from "../lib/state.js";
import { setRng, resetRng } from "../lib/timing-engine.js";
import { createVoiceCard } from "../lib/voice-card.js";
import { createDmProactive } from "../lib/dm-proactive.js";
import { readLog } from "./helpers/dm-proactive-fixtures.js";

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
    state.chatTypeBySession.clear();
    state.observedBySession.clear();
    state.memoryBySession.clear();
    state.transcriptPeekBySession?.clear?.();
    state.peekMetaBySession?.clear?.();
  });

  afterEach(() => {
    clearAllBubbleTimers();
    resetRng();
  });

  describe("speak → split → timed delivery → markComplete", () => {
    it("full speak pipeline delivers bubbles in order with increasing delays", async () => {
      const sk = "agent:test:whatsapp:group:e2e@g.us";
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

      state.speakEpochBySession.set(sk, { epoch: 42, ts: Date.now() });
      state.chatTypeBySession.set(sk, "group");

      const dispatcher = {
        sendBlockReply: mock.fn(() => true),
        markComplete: mock.fn(),
      };

      naturalize.onReplyDispatch(
        { sendPolicy: "allow" },
        { agentId: "test", sessionKey: sk, channelId: "ch", chatId: "ch", senderId: "u", dispatcher, abortSignal: undefined },
      );

      const payloadResult = naturalize.onReplyPayloadSending(
        { sessionKey: sk, kind: "final", channel: "whatsapp", payload: { text: "This is the draft reply" } },
        { agentId: "test", sessionKey: sk },
      );
      assert.deepEqual(payloadResult, { cancel: true });

      await new Promise((r) => setTimeout(r, 1500));

      assert.equal(dispatcher.sendBlockReply.mock.callCount(), 3);
      assert.equal(dispatcher.sendBlockReply.mock.calls[0].arguments[0].text, "First bubble");
      assert.equal(dispatcher.sendBlockReply.mock.calls[1].arguments[0].text, "Second bubble");
      assert.equal(dispatcher.sendBlockReply.mock.calls[2].arguments[0].text, "Third bubble");
      assert.equal(dispatcher.markComplete.mock.callCount(), 1);
      assert.equal(state.speakEpochBySession.has(sk), false);
    });

    it("agent-run-failed suppression: host fallback payload is cancelled and never delivered as a block reply", async () => {
      const sk = "agent:test:whatsapp:group:e2e-fail@g.us";
      const engine = createLocalEngine({
        cfg: { humanize: { maxBubbles: 3 } },
        llm: {
          complete: async () => ({
            text: JSON.stringify({ messages: ["Real bubble"] }),
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

      state.speakEpochBySession.set(sk, { epoch: 42, ts: Date.now() });
      state.chatTypeBySession.set(sk, "group");

      const dispatcher = {
        sendBlockReply: mock.fn(() => true),
        markComplete: mock.fn(),
      };

      naturalize.onReplyDispatch(
        { sendPolicy: "allow" },
        { agentId: "test", sessionKey: sk, channelId: "ch", chatId: "ch", senderId: "u", dispatcher, abortSignal: undefined },
      );

      const payloadResult = naturalize.onReplyPayloadSending(
        { sessionKey: sk, kind: "final", channel: "whatsapp", payload: { text: "⚠️ Agent run failed (model: crof/deepseek-v4-flash-0731)." } },
        { agentId: "test", sessionKey: sk },
      );
      assert.deepEqual(payloadResult, { cancel: true });

      await new Promise((r) => setTimeout(r, 1500));

      assert.equal(dispatcher.sendBlockReply.mock.callCount(), 0, "agent-run-failed payload never delivered");
      const sent = dispatcher.sendBlockReply.mock.calls.map((c) => c.arguments[0].text);
      assert.ok(sent.every((t) => !t.includes("Agent run failed")), "no block reply carries the error text");
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

      const sk = "agent:test:whatsapp:group:e2e-sup@g.us";
      state.speakEpochBySession.set(sk, { epoch: 1, ts: Date.now() });
      state.chatTypeBySession.set(sk, "group");

      const dispatcher = {
        sendBlockReply: mock.fn(() => true),
        markComplete: mock.fn(),
      };

      naturalize.onReplyDispatch(
        { sendPolicy: "allow" },
        { agentId: "test", sessionKey: sk, channelId: "ch", chatId: "ch", senderId: "u", dispatcher, abortSignal: undefined },
      );

      naturalize.onReplyPayloadSending(
        { sessionKey: sk, kind: "final", payload: { text: "Draft" } },
        { agentId: "test", sessionKey: sk },
      );

      setTimeout(() => { getState().epochs.set(sk, 5); }, 1350);

      await new Promise((r) => setTimeout(r, 1700));

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

  describe("multi-agent isolation", () => {
    let tmpDir;
    let fileA;
    let fileB;
    let soulA;
    let soulB;
    let cfg;

    function makeEngine() {
      return createLocalEngine({
        cfg: {},
        llm: {
          complete: async () => ({ text: "STAY_SILENT" }),
        },
        timing: makeFakeTiming(),
        log: { info() {}, warn() {}, debug() {} },
      });
    }

    function makeSoulPersona() {
      return {
        buildPersonaPrompt(cfg, sk) {
          try { return fs.readFileSync(cfg.soulPath, "utf8").trim(); } catch { return null; }
        },
        buildPersonaPromptWithMemory() { return "test persona + memory"; },
        buildSoulPrompt(cfg) {
          try { return fs.readFileSync(cfg.soulPath, "utf8").trim(); } catch { return null; }
        },
      };
    }

    function makeSocialMemory() {
      return createSocialMemory({ cfg, stateDir: tmpDir, log: { info() {}, warn() {}, debug() {} } });
    }

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-multi-"));
      fileA = path.join(tmpDir, "contacts-a.md");
      fileB = path.join(tmpDir, "contacts-b.md");
      fs.writeFileSync(fileA, "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 999000001 | +4900000001 | Alice | |\n");
      fs.writeFileSync(fileB, "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 999000002 | +4900000002 | Bob | |\n");
      soulA = path.join(tmpDir, "soul-a.md");
      soulB = path.join(tmpDir, "soul-b.md");
      fs.writeFileSync(soulA, "I am ALICE'S SOUL.\n");
      fs.writeFileSync(soulB, "I am BOB'S SOUL.\n");
      cfg = resolveConfig({
        pluginConfig: {
          agents: ["agent-a", "agent-b"],
          agentName: "GlobalAgent",
          agentProfiles: {
            "agent-a": { agentName: "Alice", contactsPath: fileA, soulPath: soulA },
            "agent-b": { agentName: "Bob", contactsPath: fileB, soulPath: soulB },
          },
        },
      });
    });

    afterEach(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it("Case A: hard-trigger separation by agent name", async () => {
      const engine = makeEngine();
      const gate = createGate({
        cfg,
        state,
        engine,
        persona: makeSoulPersona(),
        socialMemory: makeSocialMemory(),
        log: { info() {}, warn() {}, debug() {} },
      });
      const skB = "agent:agent-b:whatsapp:group:1@g.us";
      state.chatTypeBySession.set(skB, "group");

      // "hey Alice" in agent-b's group must NOT speak (Alice is not Bob's name).
      const wrongName = await gate.onBeforeAgentReply(
        { cleanedBody: "hey Alice, what do you think" },
        { agentId: "agent-b", sessionKey: skB, senderId: "u", senderName: "Nico" },
      );
      assert.deepEqual(wrongName, { handled: true }, "wrong agent name must stay silent");

      // "hey Bob" in agent-b's group must speak via hard trigger.
      const correctName = await gate.onBeforeAgentReply(
        { cleanedBody: "hey Bob, what do you think" },
        { agentId: "agent-b", sessionKey: skB, senderId: "u", senderName: "Nico" },
      );
      assert.equal(correctName, undefined, "correct agent name should speak");
    });

    it("Case B: quote-reply recognition is per agent", async () => {
      const engine = makeEngine();
      const gate = createGate({
        cfg,
        state,
        engine,
        persona: makeSoulPersona(),
        socialMemory: makeSocialMemory(),
        log: { info() {}, warn() {}, debug() {} },
      });

      // agent-a's group: a quote of Alice's OWN message must be replyToAgent for agent-a.
      const skA = "agent:agent-a:whatsapp:group:2@g.us";
      state.chatTypeBySession.set(skA, "group");
      state.transcriptPeekBySession.set(skA, ["[Alice] klar und sonnig am Berg, perfekt fuer den Klettersteig"]);
      state.peekMetaBySession.set(skA, [Date.now()]);
      let capturedA;
      const gateA = createGate({
        cfg,
        state,
        engine: {
          async decide(opts) { capturedA = opts; return { decision: "speak", epoch: 1 }; },
        },
        persona: makeSoulPersona(),
        socialMemory: makeSocialMemory(),
        log: { info() {}, warn() {}, debug() {} },
      });
      gateA.onMessageReceived(
        { text: "danke" },
        { agentId: "agent-a", sessionKey: skA, senderId: "user-A", replyToBody: "klar und sonnig am Berg, perfekt fuer den Klettersteig" },
      );
      await gateA.onBeforeAgentReply(
        { cleanedBody: "danke!" },
        { agentId: "agent-a", sessionKey: skA, senderId: "user-A" },
      );
      assert.equal(capturedA.replyToAgent, true, "agent-a sees its own quote as reply-to-agent");

      // agent-b's group: the SAME quote body must NOT be replyToAgent (Alice is a person to Bob).
      const skB = "agent:agent-b:whatsapp:group:3@g.us";
      state.chatTypeBySession.set(skB, "group");
      state.transcriptPeekBySession.set(skB, ["[Alice] klar und sonnig am Berg, perfekt fuer den Klettersteig"]);
      state.peekMetaBySession.set(skB, [Date.now()]);
      let capturedB;
      const gateB = createGate({
        cfg,
        state,
        engine: {
          async decide(opts) { capturedB = opts; return { decision: "speak", epoch: 1 }; },
        },
        persona: makeSoulPersona(),
        socialMemory: makeSocialMemory(),
        log: { info() {}, warn() {}, debug() {} },
      });
      gateB.onMessageReceived(
        { text: "danke" },
        { agentId: "agent-b", sessionKey: skB, senderId: "user-B", replyToBody: "klar und sonnig am Berg, perfekt fuer den Klettersteig" },
      );
      // "hey Bob" hard-triggers so decide runs; the quoted Alice line must still
      // resolve replyToAgent=false for agent-b.
      await gateB.onBeforeAgentReply(
        { cleanedBody: "hey Bob, danke!" },
        { agentId: "agent-b", sessionKey: skB, senderId: "user-B" },
      );
      assert.equal(capturedB.replyToAgent, false, "agent-b must NOT treat Alice's quote as reply-to-agent");
    });

    it("Case C: persona/SOUL is per agent", async () => {
      const engine = makeEngine();
      const gate = createGate({
        cfg,
        state,
        engine,
        persona: makeSoulPersona(),
        socialMemory: makeSocialMemory(),
        log: { info() {}, warn() {}, debug() {} },
      });
      const skA = "agent:agent-a:whatsapp:group:4@g.us";
      state.chatTypeBySession.set(skA, "group");
      let captured;
      const gateA = createGate({
        cfg,
        state,
        engine: {
          async decide(opts) { captured = opts; return { decision: "stay_silent", epoch: 1 }; },
        },
        persona: makeSoulPersona(),
        socialMemory: makeSocialMemory(),
        log: { info() {}, warn() {}, debug() {} },
      });
      await gateA.onBeforeAgentReply(
        { cleanedBody: "hello" },
        { agentId: "agent-a", sessionKey: skA, senderId: "u", senderName: "Nico" },
      );
      assert.equal(captured.persona, "I am ALICE'S SOUL.", "agent-a should get Alice's soul");

      const skB = "agent:agent-b:whatsapp:group:5@g.us";
      state.chatTypeBySession.set(skB, "group");
      let capturedB;
      const gateB = createGate({
        cfg,
        state,
        engine: {
          async decide(opts) { capturedB = opts; return { decision: "stay_silent", epoch: 1 }; },
        },
        persona: makeSoulPersona(),
        socialMemory: makeSocialMemory(),
        log: { info() {}, warn() {}, debug() {} },
      });
      await gateB.onBeforeAgentReply(
        { cleanedBody: "hello" },
        { agentId: "agent-b", sessionKey: skB, senderId: "u", senderName: "Nico" },
      );
      assert.equal(capturedB.persona, "I am BOB'S SOUL.", "agent-b should get Bob's soul");
    });

    it("Case D: self-filter is per agent", () => {
      const socialMemory = makeSocialMemory();
      // agent-a's scope: "Alice" is self → filtered; "Bob" is a person.
      socialMemory.ingest("agent-a::agent:agent-a:whatsapp:group:6@g.us", { speaker: "Alice", text: "hi", ts: 100 });
      socialMemory.ingest("agent-a::agent:agent-a:whatsapp:group:6@g.us", { speaker: "Bob", text: "hi", ts: 101 });
      const profileA = socialMemory.getOrLoadProfile("agent-a::agent:agent-a:whatsapp:group:6@g.us");
      assert.ok(!profileA.people.Alice, "Alice is self for agent-a");
      assert.ok(profileA.people.Bob, "Bob is a person in agent-a's scope");

      // agent-b's scope: "Bob" is self → filtered; "Alice" is a person.
      socialMemory.ingest("agent-b::agent:agent-b:whatsapp:group:7@g.us", { speaker: "Bob", text: "hi", ts: 100 });
      socialMemory.ingest("agent-b::agent:agent-b:whatsapp:group:7@g.us", { speaker: "Alice", text: "hi", ts: 101 });
      const profileB = socialMemory.getOrLoadProfile("agent-b::agent:agent-b:whatsapp:group:7@g.us");
      assert.ok(!profileB.people.Bob, "Bob is self for agent-b");
      assert.ok(profileB.people.Alice, "Alice is a person in agent-b's scope");
    });
  });

  describe("social card isolation", () => {
    let tmpDir;
    let stateDir;
    let vc;

    function fakeEngineFor(agentId) {
      return {
        extractVoiceCard: async () => ({ prompt_block: `# Voice Card for ${agentId}` }),
      };
    }

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-vc-"));
      stateDir = path.join(tmpDir, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      vc = await import("../lib/voice-card.js");
      vc.stateByAgent.forEach((b) => Object.keys(b.cache).forEach((k) => delete b.cache[k]));
      vc.stateByAgent.forEach((b) => Object.keys(b.counter).forEach((k) => delete b.counter[k]));
      vc.refreshing.clear();
    });

    afterEach(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    function buildHandler(engine, socialCfg) {
      const { onBeforePromptBuild } = createVoiceCard({
        cfg: { enabled: true, socialLearning: { enabled: true, refreshEvery: 1, refreshMinutes: 0, ...socialCfg } },
        engine,
        stateDir,
        log: { info() {}, warn() {} },
      });
      return onBeforePromptBuild;
    }

    it("Case A: two agents get distinct, injected voice cards (social card isolation)", async () => {
      const onBefore = buildHandler({
        extractVoiceCard: async ({ transcript }) => {
          const who = transcript[0].text.includes("agent-a") ? "agent-a" : "agent-b";
          return { prompt_block: `# Voice Card for ${who}` };
        },
      });
      const evt = { messages: [{ role: "user", content: "[User] hi agent-a" }] };
      const evtB = { messages: [{ role: "user", content: "[User] hi agent-b" }] };
      const skA = "agent:agent-a:whatsapp:group:isoA@g.us";
      const skB = "agent:agent-b:whatsapp:group:isoB@g.us";
      onBefore(evt, { sessionKey: skA });
      onBefore(evtB, { sessionKey: skB });
      await new Promise((r) => setTimeout(r, 80));
      const rA = onBefore(evt, { sessionKey: skA });
      const rB = onBefore(evtB, { sessionKey: skB });
      assert.ok(rA.appendSystemContext.includes("# Voice Card for agent-a"), "agent-a gets its own card");
      assert.ok(rB.appendSystemContext.includes("# Voice Card for agent-b"), "agent-b gets its own card");
      assert.ok(!rA.appendSystemContext.includes("# Voice Card for agent-b"), "agent-a must not see agent-b's card");
    });

    it("Case B: eviction is isolated per agent (agent-b flood does not evict agent-a)", async () => {
      const onBefore = buildHandler({ extractVoiceCard: async () => ({ prompt_block: "# Card" }) });
      const skA = "agent:agent-a:whatsapp:group:isoKeep@g.us";
      onBefore({ messages: [{ role: "user", content: "[User] hi" }] }, { sessionKey: skA });
      await new Promise((r) => setTimeout(r, 60));
      const pre = onBefore({ messages: [{ role: "user", content: "[User] hi" }] }, { sessionKey: skA });
      assert.ok(pre.appendSystemContext.includes("# Card"), "agent-a card cached before flood");

      for (let i = 0; i < 260; i++) {
        onBefore(
          { messages: [{ role: "user", content: "[User] hi" }] },
          { sessionKey: `agent:agent-b:whatsapp:group:flood${i}@g.us` },
        );
      }
      await new Promise((r) => setTimeout(r, 120));
      const post = onBefore({ messages: [{ role: "user", content: "[User] hi" }] }, { sessionKey: skA });
      assert.ok(post.appendSystemContext.includes("# Card"), "agent-a's card survives agent-b's 260-refresh flood");
      assert.equal(
        vc.stateByAgent.get("agent-b").cache["agent:agent-b:whatsapp:group:flood0@g.us"],
        undefined,
        "agent-b's own oldest card evicted",
      );
    });

    it("Case C: restart persistence — cards reload from disk (v2)", async () => {
      const onBefore = buildHandler({ extractVoiceCard: async () => ({ prompt_block: "# Card A" }) });
      const skA = "agent:agent-a:whatsapp:group:isoRestart@g.us";
      const skB = "agent:agent-b:whatsapp:group:isoRestart@g.us";
      onBefore({ messages: [{ role: "user", content: "[User] hi" }] }, { sessionKey: skA });
      onBefore({ messages: [{ role: "user", content: "[User] hi" }] }, { sessionKey: skB });
      await new Promise((r) => setTimeout(r, 80));

      vc.stateByAgent.forEach((b) => Object.keys(b.cache).forEach((k) => delete b.cache[k]));
      vc.stateByAgent.forEach((b) => Object.keys(b.counter).forEach((k) => delete b.counter[k]));
      vc.refreshing.clear();

      const onBefore2 = buildHandler({ extractVoiceCard: async () => ({ prompt_block: "# NEW" }) });
      const rA = onBefore2({ messages: [{ role: "user", content: "[User] hi" }] }, { sessionKey: skA });
      const rB = onBefore2({ messages: [{ role: "user", content: "[User] hi" }] }, { sessionKey: skB });
      assert.ok(rA.appendSystemContext.includes("# Card A"), "agent-a card persisted across restart");
      assert.ok(rB.appendSystemContext.includes("# Card A"), "agent-b card persisted across restart (both buckets from same stateDir)");
    });

    it("Case D: v1 flat file migrates on load and both agents get cards", async () => {
      fs.writeFileSync(
        path.join(stateDir, "social-learning-cache.json"),
        JSON.stringify({
          cache: {
            "agent:agent-a:whatsapp:group:m@g.us": "# v1 Card A",
            "agent:agent-b:whatsapp:group:m@g.us": "# v1 Card B",
            "__global__": "# contaminated",
          },
          counter: {},
        }),
        { mode: 0o600 },
      );
      const onBefore = buildHandler({ extractVoiceCard: async () => null });
      const rA = onBefore({ messages: [{ role: "user", content: "[User] hi" }] }, { sessionKey: "agent:agent-a:whatsapp:group:m@g.us" });
      const rB = onBefore({ messages: [{ role: "user", content: "[User] hi" }] }, { sessionKey: "agent:agent-b:whatsapp:group:m@g.us" });
      assert.ok(rA.appendSystemContext.includes("# v1 Card A"), "agent-a card injected from migrated v1");
      assert.ok(rB.appendSystemContext.includes("# v1 Card B"), "agent-b card injected from migrated v1");
      const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, "social-learning-cache.json"), "utf8"));
      assert.equal(onDisk.version, 2, "file rewritten as v2");
      assert.equal(onDisk.agents["agent-a"].cache["agent:agent-a:whatsapp:group:m@g.us"], "# v1 Card A");
      assert.equal(onDisk.agents["agent-b"].cache["agent:agent-b:whatsapp:group:m@g.us"], "# v1 Card B");
    });

    it("Case E: naturalize flush persona uses the AGENT's soul (per-agent, not global)", async () => {
      const soulA = path.join(tmpDir, "soul-a.md");
      const soulB = path.join(tmpDir, "soul-b.md");
      fs.writeFileSync(soulA, "I am ALICE'S SOUL.\n");
      fs.writeFileSync(soulB, "I am BOB'S SOUL.\n");
      const cfg = resolveConfig({
        pluginConfig: {
          agents: ["agent-a", "agent-b"],
          agentName: "GlobalAgent",
          agentProfiles: {
            "agent-a": { agentName: "Alice", soulPath: soulA },
            "agent-b": { agentName: "Bob", soulPath: soulB },
          },
        },
      });

      let capturedRespond;
      const engine = {
        respond: async (opts) => { capturedRespond = opts; return { superseded: true }; },
        currentEpoch: () => 0,
      };
      const persona = {
        buildPersonaPromptWithMemory(cfg2, state2, sk) {
          try { return fs.readFileSync(cfg2.soulPath, "utf8").trim(); } catch { return null; }
        },
      };
      const naturalize = createNaturalize({
        cfg,
        state,
        engine,
        persona,
        log: { info() {}, warn() {}, debug() {} },
      });

      const skB = "agent:agent-b:whatsapp:group:soulB@g.us";
      state.speakEpochBySession.set(skB, { epoch: 1, ts: Date.now() });
      state.chatTypeBySession.set(skB, "group");

      const dispatcher = { sendBlockReply: mock.fn(() => true), markComplete: mock.fn() };
      naturalize.onReplyDispatch(
        { sendPolicy: "allow" },
        { agentId: "agent-b", sessionKey: skB, channelId: "ch", chatId: "ch", senderId: "u", dispatcher, abortSignal: undefined },
      );
      const payloadResult = naturalize.onReplyPayloadSending(
        { sessionKey: skB, kind: "final", channel: "whatsapp", payload: { text: "This is the draft reply" } },
        { agentId: "agent-b", sessionKey: skB },
      );
      assert.deepEqual(payloadResult, { cancel: true });

      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(capturedRespond, "flush should invoke engine.respond");
      assert.ok(capturedRespond.persona.includes("I am BOB'S SOUL."), "agent-b flush persona uses agent-b's soul");
      assert.ok(!capturedRespond.persona.includes("I am ALICE'S SOUL."), "agent-b flush persona must not use agent-a's soul");
    });

    it("Case F: humanize opts carry the session's agentId (regression: caller agentId hori-wa)", async () => {
      const sk = "agent:agent-b:whatsapp:group:e2e-agentid@g.us";
      let captured;
      const engine = createLocalEngine({
        cfg: { humanize: { maxBubbles: 2 } },
        llm: {
          complete: async (opts) => { captured = opts; return { text: JSON.stringify({ messages: ["Bubble one", "Bubble two"] }) }; },
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

      state.speakEpochBySession.set(sk, { epoch: 1, ts: Date.now() });
      state.chatTypeBySession.set(sk, "group");

      const dispatcher = {
        sendBlockReply: mock.fn(() => true),
        markComplete: mock.fn(),
      };

      naturalize.onReplyDispatch(
        { sendPolicy: "allow" },
        { agentId: "agent-b", sessionKey: sk, channelId: "ch", chatId: "ch", senderId: "u", dispatcher, abortSignal: undefined },
      );
      const payloadResult = naturalize.onReplyPayloadSending(
        { sessionKey: sk, kind: "final", channel: "whatsapp", payload: { text: "This is the draft reply" } },
        { agentId: "agent-b", sessionKey: sk },
      );
      assert.deepEqual(payloadResult, { cancel: true });

      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(captured, "humanize llm.complete should have been invoked on flush");
      assert.equal(captured.agentId, "agent-b", "humanize opts.agentId must be the session's agent, not hori-wa");
    });
  });

  describe("onboarding (Plan 006)", () => {
    let tmpDir;
    let stateDir;
    let contactsA;
    let contactsC;
    let soulA;
    let soulC;
    let cfg;

    function makeSoulPersona() {
      return {
        buildPersonaPrompt(cfg, sk) {
          try { return fs.readFileSync(cfg.soulPath, "utf8").trim(); } catch { return null; }
        },
        buildPersonaPromptWithMemory() { return "test persona + memory"; },
        buildSoulPrompt(cfg) {
          try { return fs.readFileSync(cfg.soulPath, "utf8").trim(); } catch { return null; }
        },
      };
    }

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-onboard-"));
      stateDir = path.join(tmpDir, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      contactsA = path.join(tmpDir, "contacts-a.md");
      contactsC = path.join(tmpDir, "contacts-c.md");
      soulA = path.join(tmpDir, "soul-a.md");
      soulC = path.join(tmpDir, "soul-c.md");
      fs.writeFileSync(contactsA, "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 999000101 | +4910101 | Alice | |\n");
      fs.writeFileSync(contactsC, "| @lid | Telefonnummer | Name | Notizen |\n|---|---|---|---|\n| 999000102 | +4910102 | Carol | |\n");
      fs.writeFileSync(soulA, "I am ALICE'S SOUL.\n");
      fs.writeFileSync(soulC, "I am CAROL'S SOUL.\n");
      cfg = resolveConfig({
        pluginConfig: {
          agents: ["agent-a", "agent-c"],
          agentName: "GlobalAgent",
          agentProfiles: {
            "agent-a": { agentName: "Alice", contactsPath: contactsA, soulPath: soulA },
            "agent-c": { agentName: "Carol", contactsPath: contactsC, soulPath: soulC },
          },
        },
      });
    });

    afterEach(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it("Case A: new agent in 3 files (allowlist + profile + contacts/SOUL) speaks hard and gets its soul; card refresher starts after 5 messages", async () => {
      let decideCalls = 0;
      let capturedDecide;
      let capturedResult;
      const engine = {
        decide: async (opts) => {
          decideCalls++;
          capturedDecide = opts;
          capturedResult = { decision: "speak", epoch: 1, path: "hard" };
          return capturedResult;
        },
        respond: async () => ({ superseded: true }),
        currentEpoch: () => 0,
      };
      const gate = createGate({
        cfg,
        state,
        engine,
        persona: makeSoulPersona(),
        socialMemory: createSocialMemory({ cfg, stateDir, log: { info() {}, warn() {}, debug() {} } }),
        log: { info() {}, warn() {}, debug() {} },
      });

      const skC = "agent:agent-c:whatsapp:group:onboard-c@g.us";
      state.chatTypeBySession.set(skC, "group");
      // Message from a contact id in agent-c's contacts.md (senderId 999000102 → Carol)
      gate.onMessageReceived(
        { text: "hey Carol, was denkst du?" },
        { agentId: "agent-c", sessionKey: skC, senderId: "999000102", senderName: "" },
      );
      const verdict = await gate.onBeforeAgentReply(
        { cleanedBody: "hey Carol, was denkst du?" },
        { agentId: "agent-c", sessionKey: skC, senderId: "999000102", senderName: "" },
      );
      assert.equal(verdict, undefined, "hard-trigger on agent-c's name must speak");
      assert.equal(decideCalls, 1);
      assert.equal(capturedResult.path, "hard");
      assert.equal(capturedDecide.persona, "I am CAROL'S SOUL.", "decide persona must be agent-c's soul");

      // Voice-card injection is empty for a fresh agent.
      let cardExtractCalls = 0;
      const cardCfg = resolveConfig({
        pluginConfig: {
          agents: ["agent-a", "agent-c"],
          socialLearning: { enabled: true, refreshEvery: 5, refreshMinutes: 0 },
          agentProfiles: {
            "agent-c": { agentName: "Carol", contactsPath: contactsC, soulPath: soulC, socialLearning: { refreshEvery: 5 } },
          },
        },
      });
      const { onBeforePromptBuild } = createVoiceCard({
        cfg: cardCfg,
        engine: { extractVoiceCard: async () => { cardExtractCalls++; return { prompt_block: "# CARD" }; } },
        stateDir,
        log: { info() {}, warn() {} },
      });
      const evt = { messages: [{ role: "user", content: "[User] hey Carol hi" }] };
      const first = onBeforePromptBuild(evt, { sessionKey: skC, agentId: "agent-c" });
      assert.ok(!first || !first.appendSystemContext, "fresh agent has no card injected before refresh");
      for (let i = 0; i < 4; i++) {
        onBeforePromptBuild(evt, { sessionKey: skC, agentId: "agent-c" });
      }
      await new Promise((r) => setTimeout(r, 60));
      assert.ok(cardExtractCalls >= 1, "after 5 messages the card refresher fires");
    });

    it("Case B: autoconfig catches a profile typo — inert profile warns AND the scoped hook stays a no-op", async () => {
      // Profile exists for agent-c, but the allowlist only has agent-a → inert.
      const warnLog = [];
      const { warnStartupConfig } = await import("../lib/autoconfig.js");
      warnStartupConfig(
        { agents: ["agent-a"], agentProfiles: { "agent-c": { contactsPath: contactsC, soulPath: soulC } } },
        {},
        { info() {}, warn(m) { warnLog.push(String(m)); }, debug() {} },
      );
      assert.ok(warnLog.some((w) => w.includes("profile exists but agent not in agents allowlist")));

      // Behavioral side: agent-c's hooks are a no-op because agent-c is not in the allowlist.
      const onlyA = resolveConfig({
        pluginConfig: {
          agents: ["agent-a"],
          agentProfiles: { "agent-c": { agentName: "Carol", contactsPath: contactsC, soulPath: soulC } },
        },
      });
      let decideCalled = false;
      const gate = createGate({
        cfg: onlyA,
        state,
        engine: {
          decide: async () => { decideCalled = true; return { decision: "speak", epoch: 1 }; },
          respond: async () => ({ superseded: true }),
          currentEpoch: () => 0,
        },
        persona: makeSoulPersona(),
        socialMemory: createSocialMemory({ cfg: onlyA, stateDir, log: { info() {}, warn() {}, debug() {} } }),
        log: { info() {}, warn() {}, debug() {} },
      });
      const skC = "agent:agent-c:whatsapp:group:onboard-typo@g.us";
      state.chatTypeBySession.set(skC, "group");
      const verdict = await gate.onBeforeAgentReply(
        { cleanedBody: "hey Carol, was denkst du?" },
        { agentId: "agent-c", sessionKey: skC, senderId: "999000102", senderName: "" },
      );
      assert.equal(verdict, undefined, "unscoped agent-c hook is a no-op");
      assert.equal(decideCalled, false, "decide must NOT run for an unscoped agent");
    });

    it("Case C: two groups, one agent — separate observed/memory scopes and no transcript bleed", async () => {
      const engine = {
        decide: async () => ({ decision: "stay_silent", epoch: 1 }),
        respond: async () => ({ superseded: true }),
        currentEpoch: () => 0,
      };
      const gate = createGate({
        cfg,
        state,
        engine,
        persona: makeSoulPersona(),
        socialMemory: createSocialMemory({ cfg, stateDir, log: { info() {}, warn() {}, debug() {} } }),
        log: { info() {}, warn() {}, debug() {} },
      });

      const sk1 = "agent:agent-a:whatsapp:group:g1@g.us";
      const sk2 = "agent:agent-a:whatsapp:group:g2@g.us";
      state.chatTypeBySession.set(sk1, "group");
      state.chatTypeBySession.set(sk2, "group");

      // Send different senders/messages into the two groups of the same agent.
      gate.onMessageReceived({ text: "hello group one" }, { agentId: "agent-a", sessionKey: sk1, senderId: "u1" });
      gate.onMessageReceived({ text: "hello group two" }, { agentId: "agent-a", sessionKey: sk2, senderId: "u2" });
      const peek1 = state.transcriptPeekBySession.get(sk1) || [];
      const peek2 = state.transcriptPeekBySession.get(sk2) || [];
      assert.ok(peek1.some((l) => l.includes("hello group one")), "group one transcript has its own message");
      assert.ok(!peek1.some((l) => l.includes("hello group two")), "group one must NOT see group two's message");
      assert.ok(peek2.some((l) => l.includes("hello group two")), "group two transcript has its own message");
      assert.ok(!peek2.some((l) => l.includes("hello group one")), "group two must NOT see group one's message");
    });
  });

  describe("proactive tenancy (Plan 005)", () => {
    const T0 = new Date(2026, 8, 9, 14, 0).getTime();
    let tmpDir;
    let stateDir;

    function envelopeText(id, kind = "soft_followup", draft = "Kommt ihr heute noch am Projekt voran?") {
      const env = {
        id,
        kind,
        sensitivity: "normal",
        confidence: 0.8,
        dueWindow: { earliestMs: T0, latestMs: T0 + 6 * 60 * 60 * 1000 },
        lastUserRefMs: T0 - 2 * 60 * 60 * 1000,
        source: "followup-cron",
      };
      return "[[fu:" + JSON.stringify(env) + "]]\n" + draft;
    }

    function makeDm(cfg, stateSeed) {
      if (stateSeed) fs.writeFileSync(path.join(stateDir, "dm-proactive-state.json"), JSON.stringify(stateSeed), "utf8");
      const calls = [];
      const runtime = {
        subagent: { run: mock.fn(async (o) => { calls.push(o); return { runId: "r" + calls.length }; }) },
        llm: { complete: mock.fn(async () => ({ text: "draft" })) },
      };
      const dm = createDmProactive({
        cfg,
        llm: runtime.llm,
        socialMemory: { getOrLoadProfile: () => null },
        runtime,
        stateDir,
        log: { info() {}, warn() {}, debug() {} },
        now: () => T0,
      });
      return { dm, runtime, calls };
    }

    function prodEvent(content, to, channel = "telegram") {
      return { to, content, metadata: { channel, accountId: "bot-1" } };
    }

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-tenancy-"));
      stateDir = path.join(tmpDir, "state");
      fs.mkdirSync(stateDir, { recursive: true });
    });

    afterEach(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it("Case A: dm-proactive tenancy sentIds isolation — same envelope id from agent-a succeeds; identical id from agent-b does NOT duplicate-cancel", async () => {
      const cfg = resolveConfig({
        pluginConfig: { enabled: true, agents: ["agent-a", "agent-b"], dmProactive: { enabled: true, shadow: false, minGapMinutes: 0, agents: ["agent-a", "agent-b"] } },
      });
      const scopeA = "agent-a::agent:agent-a:telegram:direct:999000001";
      const scopeB = "agent-b::agent:agent-b:telegram:direct:999000002";
      fs.writeFileSync(path.join(stateDir, "dm-proactive-state.json"), JSON.stringify({
        version: 3,
        scopes: { [scopeA]: { day: "2026-09-09", count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: 0, lastReplyAtMs: 0 }, [scopeB]: { day: "2026-09-09", count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: 0, lastReplyAtMs: 0 } },
        sentIds: { __legacy__: [] },
        byKind: {},
      }), "utf8");
      const { dm } = makeDm(cfg);
      const rA = await dm.onMessageSending(prodEvent(envelopeText("fu-20260909-iso-a"), "999000001"), { channelId: "telegram", accountId: "bot-1" });
      assert.deepEqual(rA, { cancel: true }, "live gate-pass suppresses the original outbound");
      const rA2 = await dm.onMessageSending(prodEvent(envelopeText("fu-20260909-iso-a"), "999000001"), { channelId: "telegram", accountId: "bot-1" });
      assert.deepEqual(rA2, { cancel: true }, "agent-a's own duplicate must cancel");
      let entries = readLog(stateDir);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].gatePassed, true, "agent-a first send passes");
      assert.equal(entries[1].gatePassed, false, "agent-a's own duplicate is rejected");
      assert.ok(entries[1].gate.reasons.includes("duplicate"), entries[1].gate.reasons.join(","));
      // agent-b's lane is a DIFFERENT scope; the same id is NOT a duplicate for it.
      const { dm: dm2 } = makeDm(cfg);
      const rB = await dm2.onMessageSending(prodEvent(envelopeText("fu-20260909-iso-a"), "999000002"), { channelId: "telegram", accountId: "bot-1" });
      assert.deepEqual(rB, { cancel: true });
      const entriesB = readLog(stateDir);
      const bEntry = entriesB[entriesB.length - 1];
      assert.equal(bEntry.gatePassed, true, "agent-b's identical id must NOT duplicate-cancel — its own gate passes");
      assert.ok(!bEntry.gate.reasons.includes("duplicate"), "agent-b must not be blocked by agent-a's sentId");
    });

    it("Case B: byKind isolation — agent-a ignoreStreak 4 does not pause agent-b's soft followup", async () => {
      const cfg = resolveConfig({
        pluginConfig: { enabled: true, agents: ["agent-a", "agent-b"], dmProactive: { enabled: true, shadow: false, minGapMinutes: 0, agents: ["agent-a", "agent-b"] } },
      });
      const scopeA = "agent-a::agent:agent-a:telegram:direct:999000003";
      const scopeB = "agent-b::agent:agent-b:telegram:direct:999000004";
      fs.writeFileSync(path.join(stateDir, "dm-proactive-state.json"), JSON.stringify({
        version: 3,
        scopes: { [scopeA]: { day: "2026-09-09", count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: 0, lastReplyAtMs: 0 }, [scopeB]: { day: "2026-09-09", count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: 0, lastReplyAtMs: 0 } },
        sentIds: { __legacy__: [] },
        byKind: { "agent-a": { soft_followup: { budgetMultiplier: 0, sends: [], replyRate14d: 0.0, ignoreStreak: 4, paused: true } } },
      }), "utf8");
      const { dm } = makeDm(cfg);
      const rA = await dm.onMessageSending(prodEvent(envelopeText("fu-20260909-bk-a", "soft_followup"), "999000003"), { channelId: "telegram", accountId: "bot-1" });
      assert.deepEqual(rA, { cancel: true }, "agent-a's paused kind must cancel its own soft followup");
      const rB = await dm.onMessageSending(prodEvent(envelopeText("fu-20260909-bk-b", "soft_followup"), "999000004"), { channelId: "telegram", accountId: "bot-1" });
      assert.deepEqual(rB, { cancel: true });
      const entries = readLog(stateDir);
      const aEntry = entries.find((e) => e.candidateId === "fu-20260909-bk-a");
      const bEntry = entries.find((e) => e.candidateId === "fu-20260909-bk-b");
      assert.equal(aEntry.gatePassed, false, "agent-a's paused kind must gate-fail its own soft followup");
      assert.ok(aEntry.gate.reasons.includes("cadence-paused"), aEntry.gate.reasons.join(","));
      assert.equal(bEntry.gatePassed, true, "agent-b's soft followup must run on full budget despite agent-a's ignoreStreak");
      assert.ok(!bEntry.gate.reasons.includes("cadence-paused"), "agent-b must not inherit agent-a's paused kind");
    });

    it("Case C: fallback (b) — dmProactive.agents [agent-b] + global list of two agents → derives agent-b", async () => {
      const cfg = resolveConfig({
        pluginConfig: { enabled: true, agents: ["agent-a", "agent-b"], agentName: "Global", dmProactive: { enabled: true, shadow: true, minGapMinutes: 0, agents: ["agent-b"] } },
      });
      const { dm } = makeDm(cfg); // fresh state — no scopes seeded
      const r = await dm.onMessageSending(prodEvent(envelopeText("fu-20260909-fb-c"), "999000005"), { channelId: "telegram", accountId: "bot-1" });
      assert.ok(r && r.content && !r.content.includes("[[fu:"), "single dmProactive.agent must derive agent-b even with two global agents");
      const entries = readLog(stateDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].scope, "agent-b::agent:agent-b:telegram:direct:999000005", "fallback (b) must resolve agent-b");
    });

    it("Case D: legacy dedup — v2 state with sentId X migrates; X blocks EVERY agent across the transition", async () => {
      const cfg = resolveConfig({
        pluginConfig: { enabled: true, agents: ["agent-a", "agent-b"], dmProactive: { enabled: true, shadow: false, minGapMinutes: 0, agents: ["agent-a", "agent-b"] } },
      });
      const scopeA = "agent-a::agent:agent-a:telegram:direct:999000006";
      const scopeB = "agent-b::agent:agent-b:telegram:direct:999000007";
      fs.writeFileSync(path.join(stateDir, "dm-proactive-state.json"), JSON.stringify({
        scopes: { [scopeA]: { day: "2026-09-09", count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: 0, lastReplyAtMs: 0 }, [scopeB]: { day: "2026-09-09", count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: 0, lastReplyAtMs: 0 } },
        sentIds: ["fu-20260909-legacy-x"],
        byKind: {},
      }), "utf8");
      const { dm } = makeDm(cfg); // load triggers v2→v3 migration
      const rA = await dm.onMessageSending(prodEvent(envelopeText("fu-20260909-legacy-x"), "999000006"), { channelId: "telegram", accountId: "bot-1" });
      assert.deepEqual(rA, { cancel: true }, "legacy sentId X must still block agent-a");
      const rB = await dm.onMessageSending(prodEvent(envelopeText("fu-20260909-legacy-x"), "999000007"), { channelId: "telegram", accountId: "bot-1" });
      assert.deepEqual(rB, { cancel: true }, "legacy sentId X must still block agent-b (single delivery over the transition)");
    });

    it("Case E: envelope safety — during all cases NO raw [[fu: prefix ever leaves the hook", async () => {
      const cfg = resolveConfig({
        pluginConfig: { enabled: true, agents: ["agent-a", "agent-b"], agentName: "Global", dmProactive: { enabled: true, shadow: false, minGapMinutes: 0, agents: ["agent-a", "agent-b"] } },
      });
      const { dm } = makeDm(cfg);
      const results = [];
      // Various shapes that the hook can produce — none may carry [[fu:.
      results.push(await dm.onMessageSending(prodEvent(envelopeText("fu-20260909-safe-1"), "soft_followup", "Draft one"), "999000008", "telegram"));
      results.push(await dm.onMessageSending(prodEvent(envelopeText("fu-20260909-safe-2"), "soft_followup", "Draft two"), "999000009", "telegram"));
      for (const r of results) {
        if (r && r.content !== undefined) {
          assert.ok(!r.content.includes("[[fu:"), "delivered content must never contain the RAW envelope");
        }
      }
      // Normal agent text untouched (still no envelope leak).
      const plain = await dm.onMessageSending({ to: "999000008", content: "Just a normal reply", metadata: { channel: "telegram" } }, { channelId: "telegram", accountId: "bot-1" });
      assert.equal(plain, undefined, "plain agent text untouched");
    });
  });

  describe("gate.onSilence → naturalize wiring (plan 018)", () => {
    it("stay_silent completes the unconsumed dispatcher but leaves the in-flight one alone", async () => {
      const sk = "agent:test:whatsapp:group:e2e-silence@g.us";
      state.chatTypeBySession.set(sk, "group");
      state.speakEpochBySession.set(sk, { epoch: 1, ts: Date.now() });

      const engine = {
        decide: async () => ({ decision: "stay_silent", epoch: 1 }),
        respond: async () => ({ superseded: true }),
        currentEpoch: () => 0,
      };
      const naturalize = createNaturalize({
        cfg: defaultCfg,
        state,
        engine,
        persona: makePersona(),
        log: { info() {}, warn() {}, debug() {} },
      });
      const gate = createGate({
        cfg: defaultCfg,
        state,
        engine,
        persona: makePersona(),
        log: { info() {}, warn() {}, debug() {} },
        onSilence: naturalize.onSilence,
      });

      const dispatcherA = { sendBlockReply: mock.fn(() => true), markComplete: mock.fn() };
      const dispatcherB = { sendBlockReply: mock.fn(() => true), markComplete: mock.fn() };

      naturalize.onReplyDispatch(
        { sendPolicy: "allow" },
        { agentId: "test", sessionKey: sk, channelId: "ch", chatId: "ch", senderId: "u", dispatcher: dispatcherA, abortSignal: undefined },
      );
      naturalize.onReplyDispatch(
        { sendPolicy: "allow" },
        { agentId: "test", sessionKey: sk, channelId: "ch", chatId: "ch", senderId: "u", dispatcher: dispatcherB, abortSignal: undefined },
      );

      const capture = naturalize.onReplyPayloadSending(
        { sessionKey: sk, kind: "final", channel: "whatsapp", payload: { text: "the good reply" } },
        { agentId: "test", sessionKey: sk },
      );
      assert.deepEqual(capture, { cancel: true });

      // Inbound message → engine decides stay_silent → gate fires onSilence(sk).
      await gate.onBeforeAgentReply(
        { cleanedBody: "kommst du gleich?" },
        { agentId: "test", sessionKey: sk, senderId: "u", senderName: "Nico" },
      );

      assert.equal(dispatcherA.markComplete.mock.callCount(), 0, "consumed in-flight A not completed by silence");
      assert.equal(dispatcherB.markComplete.mock.callCount(), 1, "unconsumed B completed by silence");

      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(dispatcherA.sendBlockReply.mock.callCount() >= 1, "A's in-flight reply still delivered");
      assert.equal(dispatcherA.markComplete.mock.callCount(), 1);
      assert.equal(dispatcherB.markComplete.mock.callCount(), 1, "B not double-completed");
    });
  });
});
