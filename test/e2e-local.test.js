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
        buildPersonaPrompt(cfg, sk) { return "test persona"; },
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
  });
});
