import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProactive, setRng, resetRng } from "../lib/proactive.js";
import * as state from "../lib/state.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proactive-test-"));
const SK = "agent:hori:whatsapp:group:123@g.us";
const SCOPE = "hori::" + SK;
const T0 = new Date(2026, 7, 13, 14, 0).getTime();

const BASE_PROACTIVE = {
  enabled: true,
  shadow: false,
  budgetPerDay: 2,
  minGapMinutes: 180,
  quietStart: "23:00",
  quietEnd: "07:00",
  probability: 0.5,
  cooldownBaseMinutes: 180,
  triggers: {
    unansweredQuestion: true,
    stalledExchange: true,
    contextMatch: true,
    followUpCommitment: true,
  },
};

function makeCfg(proactiveOverrides = {}) {
  return {
    enabled: true,
    agents: [],
    agentName: "Hori",
    proactive: {
      ...BASE_PROACTIVE,
      ...proactiveOverrides,
      triggers: {
        ...BASE_PROACTIVE.triggers,
        ...(proactiveOverrides.triggers || {}),
      },
    },
  };
}

function makeLog() {
  const infos = [];
  return {
    info(msg) { infos.push(msg); },
    warn() {},
    debug() {},
    _infos: infos,
  };
}

function makeRuntime({ llmText = "SPEAK" } = {}) {
  return {
    subagent: { run: mock.fn(async () => ({ runId: "run-1" })) },
    llm: { complete: mock.fn(async () => ({ text: llmText })) },
  };
}

function makeSocialMemory(recallResult = "") {
  return { recall: mock.fn(() => recallResult) };
}

function makeCandidate(type = "unanswered_question", overrides = {}) {
  return {
    type,
    scopeKey: SCOPE,
    sessionKey: SK,
    agentId: "hori",
    anchor: "Wann geht ihr klettern?",
    senderName: "Nico",
    detectAt: T0,
    matureAt: T0,
    context: "",
    ...overrides,
  };
}

function makeProactive(overrides = {}) {
  const clock = { t: overrides.now0 ?? T0 };
  const cfg = overrides.cfg ?? makeCfg();
  const runtime = overrides.runtime ?? makeRuntime();
  const socialMemory = overrides.socialMemory ?? makeSocialMemory();
  const log = overrides.log ?? makeLog();
  const stateDir = overrides.stateDir ?? tmpDir;
  const proactive = createProactive({
    cfg,
    state,
    engine: {},
    socialMemory,
    observedStore: null,
    runtime,
    stateDir,
    log,
    now: () => clock.t,
  });
  return { proactive, cfg, clock, runtime, socialMemory, log, stateDir };
}

const instances = [];

function track(inst) {
  instances.push(inst);
  return inst;
}

describe("proactive", { concurrency: false }, () => {
  beforeEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(tmpDir, { recursive: true });
    state.chatTypeBySession.clear();
    state.transcriptPeekBySession.clear();
    state.observedBySession.clear();
    state.senderBySession.clear();
    state.speakEpochBySession.clear();
    instances.length = 0;
  });

  afterEach(() => {
    for (const inst of instances) inst.proactive.stop();
    resetRng();
  });

  describe("trigger detection", () => {
    it("unanswered_question fires after the jittered window", async () => {
      setRng(() => 0);
      const { proactive, clock, runtime } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "Wann treffen wir uns am Donnerstag?", isGroup: true });
      clock.t += 10 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 1);
      const call = runtime.subagent.run.mock.calls[0].arguments[0];
      assert.equal(call.deliver, true);
      assert.equal(call.sessionKey, SK);
      assert.ok(call.idempotencyKey.startsWith("human-engine-proactive-unanswered_question-"));
    });

    it("unanswered_question is cancelled by a subsequent non-question inbound", async () => {
      setRng(() => 0);
      const { proactive, clock, runtime } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "Wann treffen wir uns am Donnerstag?", isGroup: true });
      await proactive.onInbound(SK, { senderName: "Anna", text: "Am Freitag passt es bei mir", isGroup: true });
      clock.t += 10 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
    });

    it("unanswered_question skipped when addressed at someone", async () => {
      setRng(() => 0);
      const { proactive, clock, runtime } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "Hey @4912345678 kannst du kommen?", isGroup: true });
      clock.t += 10 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
    });

    it("stalled_exchange fires when the agent spoke within the last 5 lines", async () => {
      setRng(() => 0);
      state.pushTranscriptPeek(SK, "[Hori] ja genau");
      state.pushTranscriptPeek(SK, "[Nico] ok danke");
      const { proactive, clock, runtime } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, unansweredQuestion: false, followUpCommitment: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "ok danke", isGroup: true });
      clock.t += 25 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 1);
      assert.equal(runtime.subagent.run.mock.calls[0].arguments[0].idempotencyKey.startsWith("human-engine-proactive-stalled_exchange-"), true);
    });

    it("context_match fires immediately on ≥2 content-word overlap with recall", async () => {
      setRng(() => 0);
      const { proactive, runtime } = track(makeProactive({
        cfg: makeCfg({ triggers: { unansweredQuestion: false, stalledExchange: false, followUpCommitment: false } }),
        socialMemory: makeSocialMemory("Nico klettert oft an nassen Felsen, das ist gefaehrlich"),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "der fels ist nass", isGroup: true });
      assert.equal(runtime.subagent.run.mock.callCount(), 1);
      assert.equal(runtime.subagent.run.mock.calls[0].arguments[0].idempotencyKey.startsWith("human-engine-proactive-context_match-"), true);
    });

    it("context_match does not fire below the overlap threshold", async () => {
      const { proactive, runtime } = track(makeProactive({
        cfg: makeCfg({ triggers: { unansweredQuestion: false, stalledExchange: false, followUpCommitment: false } }),
        socialMemory: makeSocialMemory("Nico mag schokolade"),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "der fels ist nass", isGroup: true });
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
    });

    it("follow_up_commitment fires after the delivery delay", async () => {
      setRng(() => 0);
      state.pushTranscriptPeek(SK, "[Hori] ok ich schau nach");
      state.pushTranscriptPeek(SK, "[Nico] danke");
      const { proactive, clock, runtime } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, unansweredQuestion: false, stalledExchange: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "danke", isGroup: true });
      clock.t += 121 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 1);
      assert.equal(runtime.subagent.run.mock.calls[0].arguments[0].idempotencyKey.startsWith("human-engine-proactive-follow_up_commitment-"), true);
      assert.ok(runtime.subagent.run.mock.calls[0].arguments[0].message.includes("ich schau nach"));
    });

    it("ownReply inbound records the turn without firing anything", async () => {
      setRng(() => 0);
      const { proactive, clock, runtime } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Hori", text: "", isGroup: true, ownReply: true });
      clock.t += 10 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
    });

    it("outcome_celebration fires on a member's success with a signal", async () => {
      setRng(() => 0);
      const { proactive, clock, runtime } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false, checkInOnPromise: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "Ich hab den routesgrad endlich geschafft! 🎉", isGroup: true });
      clock.t += 3 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 1);
      assert.ok(runtime.subagent.run.mock.calls[0].arguments[0].idempotencyKey.startsWith("human-engine-proactive-outcome_celebration-"));
    });

    it("outcome_celebration matures at ~2-6 min jitter", async () => {
      setRng(() => 0);
      const { proactive, clock, runtime } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false, checkInOnPromise: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "Ich hab den routesgrad endlich geschafft! 🎉", isGroup: true });
      clock.t += 1 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 0, "not matured before 2 min");
      clock.t += 1 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 1, "matured within 2-6 min");
    });

    it("outcome_celebration false positive: plain question does not fire", async () => {
      const { proactive, clock, runtime } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false, checkInOnPromise: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "Wie geschafft?", isGroup: true });
      clock.t += 5 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
    });

    it("outcome_celebration ignores the corrupted gekRampe token but fires on geschafft", async () => {
      setRng(() => 0);
      const { proactive, clock, runtime } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false, checkInOnPromise: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "Ich hab die route gekRampe!", isGroup: true });
      clock.t += 5 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 0, "gekRampe must not fire");
      await proactive.onInbound(SK, { senderName: "Nico", text: "Ich hab die route geschafft!", isGroup: true });
      clock.t += 3 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 1, "geschafft! must fire");
    });

    it("outcome_celebration does not fire on the agent's own success (ownReply guard)", async () => {
      setRng(() => 0);
      const { proactive, clock, runtime } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false, checkInOnPromise: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Hori", text: "Ich hab den routesgrad endlich geschafft! 🎉", isGroup: true, ownReply: true });
      clock.t += 5 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
    });

    it("check_in_on_promise fires 24h later when the agent participated", async () => {
      setRng(() => 0);
      state.pushTranscriptPeek(SK, "[Nico] ok ich schau nach dem ticket");
      state.pushTranscriptPeek(SK, "[Hori] danke, super");
      state.pushTranscriptPeek(SK, "[Anna] klingt gut");
      const { proactive, clock, runtime } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false, outcomeCelebration: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Anna", text: "klingt gut", isGroup: true });
      clock.t += 21 * 60 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 0, "not matured before ~18h");
      clock.t += 6 * 60 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 1, "matured within 24±6h");
      assert.ok(runtime.subagent.run.mock.calls[0].arguments[0].idempotencyKey.startsWith("human-engine-proactive-check_in_on_promise-"));
    });

    it("check_in_on_promise does not fire without an agent line in the window", async () => {
      setRng(() => 0);
      state.pushTranscriptPeek(SK, "[Nico] ok ich schau nach dem ticket");
      state.pushTranscriptPeek(SK, "[Anna] klingt gut");
      const { proactive, clock, runtime } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false, outcomeCelebration: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Anna", text: "klingt gut", isGroup: true });
      clock.t += 27 * 60 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
    });

    it("recognition budget blocks a 2nd recognition same day but allows informational", async () => {
      setRng(() => 0);
      const { proactive } = track(makeProactive({
        cfg: makeCfg({ minGapMinutes: 0, triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      await proactive.fire(makeCandidate("outcome_celebration"));
      const second = proactive.evaluate(makeCandidate("outcome_celebration"));
      assert.equal(second.pass, false);
      assert.ok(second.reasons.includes("recognition-budget"), second.reasons.join(","));
      const info = proactive.evaluate(makeCandidate("unanswered_question"));
      assert.equal(info.pass, true, info.reasons.join(","));
    });

    it("shadow logs outcome_celebration candidates and never sends", async () => {
      setRng(() => 0);
      const { proactive, clock, runtime, log } = track(makeProactive({
        cfg: makeCfg({ shadow: true, triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false, checkInOnPromise: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "Ich hab den routesgrad endlich geschafft! 🎉", isGroup: true });
      clock.t += 3 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
      assert.ok(log._infos.some((m) => m.includes("type=outcome_celebration") && m.includes("proactive SHADOW")), log._infos.join("\n"));
    });
  });

  describe("stage-2 anti-annoyance gate", () => {
    it("disabled gate blocks everything with reason disabled", async () => {
      setRng(() => 0);
      const { proactive, clock, log } = track(makeProactive({
        cfg: makeCfg({ enabled: false, shadow: true, triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "Wann treffen wir uns am Donnerstag?", isGroup: true });
      clock.t += 10 * 60 * 1000;
      await proactive.tick();
      assert.ok(log._infos.some((m) => m.includes("reason=failed:disabled")), log._infos.join("\n"));
    });

    it("budget enforcement suppresses the 3rd candidate the same day", async () => {
      const { proactive } = track(makeProactive({
        cfg: makeCfg({ minGapMinutes: 0, triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      await proactive.fire(makeCandidate("unanswered_question"));
      await proactive.fire(makeCandidate("unanswered_question"));
      const res = proactive.evaluate(makeCandidate("unanswered_question"));
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("budget"), res.reasons.join(","));
    });

    it("min-gap suppresses a candidate sent too soon after the last one", async () => {
      const { proactive } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      await proactive.fire(makeCandidate("unanswered_question"));
      const res = proactive.evaluate(makeCandidate("unanswered_question"));
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("min-gap"), res.reasons.join(","));
    });

    it("ignored engagement doubles the cooldown", async () => {
      const { proactive, clock } = track(makeProactive({
        cfg: makeCfg({ minGapMinutes: 0, triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      await proactive.fire(makeCandidate("unanswered_question"));
      clock.t += 16 * 60 * 1000;
      await proactive.tick();
      const res = proactive.evaluate(makeCandidate("unanswered_question"));
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("cooldown"), res.reasons.join(","));
    });

    it("engaged inbound resets the cooldown", async () => {
      setRng(() => 0.1);
      const { proactive, clock } = track(makeProactive({
        cfg: makeCfg({ minGapMinutes: 0, triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      await proactive.fire(makeCandidate("unanswered_question"));
      clock.t += 5 * 60 * 1000;
      await proactive.onInbound(SK, { senderName: "Nico", text: "danke, super", isGroup: true });
      const res = proactive.evaluate(makeCandidate("unanswered_question"));
      assert.equal(res.pass, true, res.reasons.join(","));
    });

    it("no-double-text suppresses a candidate when the agent owns the newest line", async () => {
      setRng(() => 0);
      state.pushTranscriptPeek(SK, "[Hori] ja genau");
      const { proactive, clock } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, followUpCommitment: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "Wann geht ihr klettern?", isGroup: true });
      clock.t += 10 * 60 * 1000;
      await proactive.tick();
      const res = proactive.evaluate(makeCandidate("unanswered_question"));
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("double-text"), res.reasons.join(","));
    });

    it("quiet hours suppress during the configured window", async () => {
      const { proactive } = track(makeProactive({
        now0: new Date(2026, 7, 13, 0, 30).getTime(),
        cfg: makeCfg({ triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      const res = proactive.evaluate(makeCandidate("unanswered_question"));
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("quiet-hours"), res.reasons.join(","));
    });

    it("side-conversation velocity skips at ≥4 msgs/min between others", async () => {
      const { proactive } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      for (let i = 0; i < 4; i++) {
        await proactive.onInbound(SK, { senderName: "Nico", text: "hallo " + i, isGroup: true });
      }
      const res = proactive.evaluate(makeCandidate("unanswered_question"));
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("velocity"), res.reasons.join(","));
    });

    it("probability gate with seeded rng", () => {
      const { proactive } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      setRng(() => 0.9);
      const blocked = proactive.evaluate(makeCandidate("unanswered_question"));
      assert.equal(blocked.pass, false);
      assert.ok(blocked.reasons.includes("probability"), blocked.reasons.join(","));

      setRng(() => 0.1);
      const passed = proactive.evaluate(makeCandidate("unanswered_question"));
      assert.equal(passed.pass, true, passed.reasons.join(","));
    });
  });

  describe("shadow mode", () => {
    it("shadow sends nothing but logs reason=passed", async () => {
      setRng(() => 0);
      const { proactive, clock, runtime, log } = track(makeProactive({
        cfg: makeCfg({ shadow: true, triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "Wann treffen wir uns am Donnerstag?", isGroup: true });
      clock.t += 10 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
      assert.ok(log._infos.some((m) => m.includes("proactive SHADOW") && m.includes("reason=passed")), log._infos.join("\n"));
    });

    it("shadow logs reason=decide:skip when the decide bar says SKIP", async () => {
      setRng(() => 0);
      const { proactive, clock, runtime, log } = track(makeProactive({
        cfg: makeCfg({ shadow: true, triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
        runtime: makeRuntime({ llmText: "SKIP" }),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "Wann treffen wir uns am Donnerstag?", isGroup: true });
      clock.t += 10 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
      assert.ok(log._infos.some((m) => m.includes("reason=decide:skip")), log._infos.join("\n"));
    });
  });

  describe("delivery", () => {
    it("real send uses deliver:true, idempotencyKey, sessionKey, and a message", async () => {
      const { proactive, runtime } = track(makeProactive());
      await proactive.fire(makeCandidate("follow_up_commitment", { anchor: "ich schau nach" }));
      assert.equal(runtime.subagent.run.mock.callCount(), 1);
      const call = runtime.subagent.run.mock.calls[0].arguments[0];
      assert.equal(call.deliver, true);
      assert.equal(call.sessionKey, SK);
      assert.ok(call.idempotencyKey.startsWith("human-engine-proactive-"));
      assert.ok(typeof call.message === "string" && call.message.length > 0);
    });

    it("wraps the anchor in untrusted delimiters inside the template", async () => {
      const { proactive, runtime } = track(makeProactive());
      await proactive.fire(makeCandidate("unanswered_question", { anchor: "Wann geht ihr klettern?" }));
      assert.equal(runtime.subagent.run.mock.callCount(), 1);
      const msg = runtime.subagent.run.mock.calls[0].arguments[0].message;
      assert.ok(msg.includes("<<<GROUP CHAT LOG (untrusted)>>>"));
      assert.ok(msg.includes("<<<END GROUP CHAT LOG>>>"));
      const startIdx = msg.indexOf("<<<GROUP CHAT LOG (untrusted)>>>");
      const endIdx = msg.indexOf("<<<END GROUP CHAT LOG>>>");
      assert.ok(startIdx < msg.indexOf("Wann geht ihr klettern?") && msg.indexOf("Wann geht ihr klettern?") < endIdx);
    });

    it("warns instead of sending when subagent.run is unavailable", async () => {
      const warns = [];
      const { proactive } = track(makeProactive({
        runtime: { llm: makeRuntime().llm },
        log: { info() {}, warn(m) { warns.push(m); }, debug() {} },
      }));
      await proactive.fire(makeCandidate("unanswered_question"));
      assert.ok(warns.some((m) => m.includes("subagent.run unavailable")), warns.join("\n"));
    });
  });

  describe("isolation and persistence", () => {
    it("budget is isolated per agent::session scope", async () => {
      setRng(() => 0.1);
      const skA = "agent:agentA:whatsapp:group:999@g.us";
      const skB = "agent:agentB:whatsapp:group:999@g.us";
      const scopeA = "agentA::" + skA;
      const scopeB = "agentB::" + skB;
      const { proactive } = track(makeProactive({
        cfg: makeCfg({ minGapMinutes: 0, triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      await proactive.fire(makeCandidate("unanswered_question", { scopeKey: scopeA, sessionKey: skA }));
      await proactive.fire(makeCandidate("unanswered_question", { scopeKey: scopeA, sessionKey: skA }));
      const resB = proactive.evaluate(makeCandidate("unanswered_question", { scopeKey: scopeB, sessionKey: skB }));
      assert.equal(resB.pass, true, resB.reasons.join(","));
    });

    it("persists counters and cooldowns across recreate (roundtrip)", async () => {
      setRng(() => 0.1);
      const { proactive: p1, clock } = track(makeProactive({
        cfg: makeCfg({ minGapMinutes: 0, triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      await p1.fire(makeCandidate("unanswered_question"));
      await p1.fire(makeCandidate("unanswered_question"));
      clock.t += 16 * 60 * 1000;
      await p1.tick();

      const p2 = track(makeProactive());
      const res = p2.proactive.evaluate(makeCandidate("unanswered_question"));
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("budget"), res.reasons.join(","));
      assert.ok(res.reasons.includes("cooldown"), res.reasons.join(","));
    });

    it("writes state/proactive.json with mode 0600", async () => {
      const { proactive } = track(makeProactive());
      await proactive.fire(makeCandidate("unanswered_question"));
      const file = path.join(tmpDir, "proactive.json");
      assert.ok(fs.existsSync(file), "proactive.json should exist");
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.ok(data.counters[SCOPE], "counter persisted for scope");
    });

    it("stop() clears pending timers", async () => {
      setRng(() => 0);
      const { proactive, clock, runtime } = track(makeProactive({
        cfg: makeCfg({ triggers: { contextMatch: false, stalledExchange: false, followUpCommitment: false } }),
      }));
      await proactive.onInbound(SK, { senderName: "Nico", text: "Wann treffen wir uns am Donnerstag?", isGroup: true });
      proactive.stop();
      clock.t += 10 * 60 * 1000;
      await proactive.tick();
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
    });
  });
});
