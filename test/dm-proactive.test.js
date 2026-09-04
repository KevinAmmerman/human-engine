import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createDmProactive } from "../lib/dm-proactive.js";
import { parseFollowupEnvelope, evaluateDmGate, candidateFromEnvelope } from "../lib/dm-gate-core.js";
import { localDayKey } from "../lib/proactive.js";
import { setRng, resetRng } from "../lib/proactive.js";
import * as state from "../lib/state.js";
import { dayFitFactor, resetDayFitWarn } from "../lib/dayfit.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-proactive-test-"));
const PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BIN_GATE = path.join(PLUGIN_ROOT, "bin", "followup-gate.mjs");
const SK = "agent:hori-wa:telegram:direct:999999999"; // fake session key (public repo)
const SCOPE = "hori-wa::" + SK;
const T0 = new Date(2026, 7, 24, 14, 0).getTime();

const BASE_DM = {
  enabled: true,
  shadow: true,
  budgetPerDay: 2,
  minGapMinutes: 180,
  quietStart: "23:00",
  quietEnd: "07:00",
  careBudgetPerDay: 1,
};

function makeCfg(dmOverrides = {}, extra = {}) {
  return {
    enabled: true,
    agents: ["hori-wa"],
    agentName: "Hori",
    dmProactive: { ...BASE_DM, ...dmOverrides },
    ...extra,
  };
}

function makeLog() {
  const infos = [];
  const warns = [];
  return {
    info(msg) { infos.push(msg); },
    warn(msg) { warns.push(msg); },
    debug() {},
    _infos: infos,
    _warns: warns,
  };
}

function makeRuntime({ llmText = "Schaffst du es noch heute? Ich schaue nach." } = {}) {
  return {
    subagent: { run: mock.fn(async () => ({ runId: "run-1" })) },
    llm: { complete: mock.fn(async () => ({ text: llmText })) },
  };
}

function makeSocialMemory(profile = null) {
  return { getOrLoadProfile: mock.fn(() => profile) };
}

function makeCandidate(overrides = {}) {
  return {
    id: "cm_test_001",
    kind: "open_loop",
    sensitivity: "personal",
    confidence: 0.8,
    source: "agent_promise",
    suggestedText: "Kommt ihr heute noch am Projekt voran?",
    dueWindow: { earliestMs: T0, latestMs: T0 + 6 * 60 * 60 * 1000 },
    sessionKey: SK,
    agentId: "hori-wa",
    ...overrides,
  };
}

// v2 envelope helpers (Plan 530): the followup-cron sends
// `[[fu:{…}]]\n<draft>` — fake ids only (public repo).
function makeEnvelope(overrides = {}) {
  return {
    id: "fu-20260824-test-001",
    kind: "soft_followup",
    sensitivity: "normal",
    confidence: 0.8,
    dueWindow: { earliestMs: T0, latestMs: T0 + 6 * 60 * 60 * 1000 },
    lastUserRefMs: T0 - 2 * 60 * 60 * 1000,
    source: "followup-cron",
    ...overrides,
  };
}

function envelopeText(envelope = makeEnvelope(), draft = "Kommt ihr heute noch am Projekt voran?") {
  return "[[fu:" + JSON.stringify(envelope) + "]]\n" + draft;
}

function makeCareCandidate(overrides = {}) {
  return makeCandidate({
    id: "cm_care_001",
    kind: "care_check_in",
    sensitivity: "care",
    confidence: 0.9,
    suggestedText: "Alles klar bei dir heute? Du hattest ja den Termin.",
    ...overrides,
  });
}

function makeDm(overrides = {}) {
  const clock = { t: overrides.now0 ?? T0 };
  const cfg = overrides.cfg ?? makeCfg();
  const runtime = overrides.runtime ?? makeRuntime();
  const socialMemory = overrides.socialMemory ?? makeSocialMemory();
  const log = overrides.log ?? makeLog();
  const stateDir = overrides.stateDir ?? tmpDir;
  const dm = createDmProactive({
    cfg,
    llm: runtime.llm,
    socialMemory,
    runtime,
    stateDir,
    log,
    now: () => clock.t,
    activityFilePath: overrides.activityFilePath,
  });
  return { dm, cfg, clock, runtime, socialMemory, log, stateDir };
}

function readLog(stateDir) {
  try {
    return fs.readFileSync(path.join(stateDir, "dm-proactive.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function writeState(stateDir, data) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "dm-proactive-state.json"), JSON.stringify(data), "utf8");
}

const instances = [];

function track(inst) {
  instances.push(inst);
  return inst;
}

describe("dm-proactive", { concurrency: false }, () => {
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
    for (const inst of instances) inst.dm.stop();
    resetRng();
  });

  describe("shadow mode", () => {
    it("shadow candidate logs an entry and never sends", async () => {
      const { dm, runtime, stateDir, log } = track(makeDm());
      const res = await dm.handleCandidate(makeCandidate());
      assert.equal(res.sent, false);
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
      const entries = readLog(stateDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].mode, "shadow");
      assert.equal(entries[0].candidate.id, "cm_test_001");
      assert.equal(entries[0].gate.pass, true);
      assert.ok(log._infos.some((m) => m.includes("dm-proactive SHADOW") && m.includes("reason=passed")), log._infos.join("\n"));
    });

    it("message_sending reconciles a pending commitment from the store and logs without blocking (v2: envelope source, store removed — Plan 530)", async () => {
      const { dm, stateDir } = track(makeDm());
      const result = await dm.onMessageSending({ content: envelopeText() }, { sessionKey: SK });
      assert.deepEqual(result, { content: "Kommt ihr heute noch am Projekt voran?" }, "shadow must pass through with the envelope stripped");
      const entries = readLog(stateDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].candidate.id, "fu-20260824-test-001");
      assert.equal(entries[0].candidate.source, "followup-cron");
      assert.equal(entries[0].gate.pass, true);
      assert.equal(typeof entries[0].render.draft, "string");
    });

    it("non-commitment outbound text produces no log entry", async () => {
      const { dm, stateDir } = track(makeDm());
      const result = await dm.onMessageSending({ content: "Hey Nico, hier ist die Antwort." }, { sessionKey: SK });
      assert.equal(result, undefined, "normal agent text must stay untouched (fail-open)");
      assert.equal(readLog(stateDir).length, 0);
    });

    it("malformed envelope warns and passes through unchanged — no cancel, no log entry (fail-open)", async () => {
      const { dm, stateDir, log } = track(makeDm());
      const broken = "[[fu:{\"id\":broken…}]]\nDraft text";
      const result = await dm.onMessageSending({ content: broken }, { sessionKey: SK });
      assert.equal(result, undefined, "malformed envelope must pass through");
      assert.equal(readLog(stateDir).length, 0);
      assert.ok(log._warns.some((m) => m.includes("malformed followup envelope")), log._warns.join("\n"));
    });

    it("repeated envelope sends with the same id in shadow deliver both, but the second is logged as duplicate", async () => {
      const { dm, stateDir } = track(makeDm());
      await dm.onMessageSending({ content: envelopeText() }, { sessionKey: SK });
      await dm.onMessageSending({ content: envelopeText() }, { sessionKey: SK });
      const entries = readLog(stateDir);
      assert.equal(entries.length, 2, "shadow never cancels — both cron sends deliver");
      assert.equal(entries[0].gate.reasons.includes("duplicate"), false);
      assert.equal(entries[1].gate.reasons.includes("duplicate"), true, entries[1].gate.reasons.join(","));
      assert.equal(entries[1].gate.verdicts.duplicate, false);
    });

    it("group outbound text is ignored (DM scope only)", async () => {
      const { dm, stateDir } = track(makeDm());
      const groupSk = "agent:hori-wa-public-group-kletter:whatsapp:group:123@g.us";
      await dm.onMessageSending({ content: envelopeText() }, { sessionKey: groupSk });
      assert.equal(readLog(stateDir).length, 0);
    });
  });

  describe("anti-annoyance gate", () => {
    it("2nd care candidate the same day is blocked by care-budget", async () => {
      const { dm } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }) }));
      await dm.handleCandidate(makeCareCandidate());
      const res = dm.evaluateGate(makeCareCandidate({ id: "cm_care_002" }));
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("care-budget"), res.reasons.join(","));
    });

    it("general daily budget blocks after budgetPerDay sends", async () => {
      const { dm } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0, budgetPerDay: 1 }) }));
      await dm.handleCandidate(makeCandidate());
      const res = dm.evaluateGate(makeCandidate({ id: "cm_test_002" }));
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("budget"), res.reasons.join(","));
    });

    it("quiet hours 23:30 block unless the deadline is <2h away", async () => {
      const { dm } = track(makeDm({ now0: new Date(2026, 7, 24, 23, 30).getTime() }));
      const res = dm.evaluateGate(makeCandidate());
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("quiet-hours"), res.reasons.join(","));

      const deadlineClose = dm.evaluateGate(makeCandidate({ dueWindow: { earliestMs: T0, latestMs: new Date(2026, 7, 25, 0, 30).getTime() } }));
      assert.equal(deadlineClose.pass, true, deadlineClose.reasons.join(","));
    });

    it("care send without reply for >=48h blocks further care (hard rule)", async () => {
      const { dm, clock } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }) }));
      await dm.handleCandidate(makeCareCandidate());
      clock.t += 49 * 60 * 60 * 1000;
      const res = dm.evaluateGate(makeCareCandidate({ id: "cm_care_002" }));
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("care-no-reply-48h"), res.reasons.join(","));
    });

    it("an inbound reply after a care send lifts the 48h rule", async () => {
      const { dm, clock } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }) }));
      await dm.handleCandidate(makeCareCandidate());
      clock.t += 25 * 60 * 60 * 1000;
      await dm.onMessageReceived({ content: "Ja, passt schon." }, { sessionKey: SK });
      clock.t += 24 * 60 * 60 * 1000;
      const res = dm.evaluateGate(makeCareCandidate({ id: "cm_care_002" }));
      assert.equal(res.pass, true, res.reasons.join(","));
    });

    it("double-text blocks when the agent owns the newest DM line", async () => {
      state.pushTranscriptPeek(SK, "[Hori] ja, schaue ich mir an");
      const { dm } = track(makeDm());
      const res = dm.evaluateGate(makeCandidate());
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("double-text"), res.reasons.join(","));
    });
  });

  describe("rendering", () => {
    it("no LLM available falls back to the original text (fail-open)", async () => {
      const { dm, stateDir } = track(makeDm({ runtime: { subagent: { run: mock.fn() }, llm: null } }));
      const res = await dm.handleCandidate(makeCandidate());
      assert.equal(res.sent, false);
      const entries = readLog(stateDir);
      assert.equal(entries[0].render.llm, "no-llm-fallback");
      assert.equal(entries[0].render.draft, "Kommt ihr heute noch am Projekt voran?");
    });

    it("renders through llm.complete with purpose dm-proactive-render", async () => {
      const runtime = makeRuntime({ llmText: "Schaffst du das heute noch, oder brauchst du mich?" });
      const { dm, stateDir } = track(makeDm({ runtime }));
      await dm.handleCandidate(makeCandidate());
      const call = runtime.llm.complete.mock.calls[0].arguments[0];
      assert.equal(call.purpose, "dm-proactive-render");
      assert.equal(call.temperature, 0.4);
      const entries = readLog(stateDir);
      assert.equal(entries[0].render.llm, "rendered");
      assert.equal(entries[0].render.draft, "Schaffst du das heute noch, oder brauchst du mich?");
    });

    it("empty llm output falls back to the original text", async () => {
      const { dm, stateDir } = track(makeDm({ runtime: makeRuntime({ llmText: "" }) }));
      await dm.handleCandidate(makeCandidate());
      const entries = readLog(stateDir);
      assert.equal(entries[0].render.llm, "fallback-empty");
      assert.equal(entries[0].render.draft, "Kommt ihr heute noch am Projekt voran?");
    });

    it("social-memory fact that fits the text becomes the memory reference and reaches the draft", async () => {
      const profile = {
        people: {
          Nico: { facts: ["Nico geht gern frueh joggen", "Nico mag Klettern"], preferences: [], situation: "" },
        },
      };
      const runtime = makeRuntime({ llmText: "Du warst ja gern frueh beim Joggen — alles gut?" });
      const { dm, socialMemory, stateDir } = track(makeDm({
        cfg: makeCfg({}, {}),
        runtime,
        socialMemory: makeSocialMemory(profile),
      }));
      const candidate = makeCareCandidate({ suggestedText: "Wie war der fruehe Jogging-Run?" });
      await dm.handleCandidate(candidate);
      assert.equal(socialMemory.getOrLoadProfile.mock.callCount() > 0, true);
      const entries = readLog(stateDir);
      assert.ok(String(entries[0].render.memoryReference).includes("Nico"), String(entries[0].render.memoryReference));
      assert.equal(entries[0].render.draft, "Du warst ja gern frueh beim Joggen — alles gut?");
    });

    it("no fitting social-memory fact means no reference (anti-hallucination)", async () => {
      const profile = { people: { Nico: { facts: ["Nico mag Tee"], preferences: [], situation: "" } } };
      const runtime = makeRuntime({ llmText: "Kurzer Stand, reicht dir das?" });
      const { dm, stateDir } = track(makeDm({ runtime, socialMemory: makeSocialMemory(profile) }));
      await dm.handleCandidate(makeCareCandidate({ suggestedText: "Wie war der fruehe Jogging-Run?" }));
      const entries = readLog(stateDir);
      assert.equal(entries[0].render.memoryReference, null);
    });
  });

  describe("live send (shadow:false)", () => {
    it("sends via subagent.run deliver with idempotency key and records the send", async () => {
      const runtime = makeRuntime({ llmText: "Rendertext" });
      const { dm, runtime: r2, stateDir } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }), runtime }));
      const res = await dm.handleCandidate(makeCandidate({ id: "cm_live_001" }));
      assert.equal(res.sent, true);
      assert.equal(runtime.subagent.run.mock.callCount(), 1);
      const call = runtime.subagent.run.mock.calls[0].arguments[0];
      assert.equal(call.deliver, true);
      assert.equal(call.sessionKey, SK);
      assert.equal(call.idempotencyKey, "human-engine-dm-proactive-cm_live_001");
      assert.equal(call.message, "Rendertext");
      const entries = readLog(stateDir);
      assert.equal(entries[0].sent, true);
      assert.equal(entries[0].candidate.id, "cm_live_001");
    });

    it("budget not bumped after failed send", async () => {
      const runtime = makeRuntime({ llmText: "Rendertext" });
      runtime.subagent.run = mock.fn(async () => { throw new Error("send failed"); });
      const { dm, clock } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }), runtime }));
      const res = await dm.handleCandidate(makeCandidate({ id: "cm_fail_001" }));
      assert.equal(res.sent, false);
      clock.t += 24 * 60 * 60 * 1000;
      const next = dm.evaluateGate(makeCandidate({ id: "cm_fail_002" }));
      assert.equal(next.pass, true, next.reasons.join(","));
    });

    it("shadow flag in config keeps dmProactive from ever sending even on a matched envelope send", async () => {
      const { dm, stateDir, runtime } = track(makeDm());
      await dm.onMessageSending({ content: envelopeText() }, { sessionKey: SK });
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
      assert.equal(readLog(stateDir)[0].sent, false);
    });
  });

  describe("activation safety: shadow-v2 pass-through vs live cancel", () => {
    it("shadow=true passes through with the envelope stripped: never cancels, still logs", async () => {
      const { dm, stateDir, runtime } = track(makeDm());
      const result = await dm.onMessageSending({ content: envelopeText(makeEnvelope({ id: "fu-20260824-as-shadow" })) }, { sessionKey: SK });
      assert.deepEqual(result, { content: "Kommt ihr heute noch am Projekt voran?" }, "shadow must never cancel — strip only");
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
      const entries = readLog(stateDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].candidate.id, "fu-20260824-as-shadow");
    });

    it("live + gate pass + runtime cancels original, sends rendered draft once with idempotencyKey", async () => {
      const runtime = makeRuntime({ llmText: "Rendertext live" });
      const { dm, stateDir } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }), runtime }));
      const result = await dm.onMessageSending({ content: envelopeText(makeEnvelope({ id: "fu-20260824-as-live" })) }, { sessionKey: SK });
      assert.deepEqual(result, { cancel: true });
      assert.equal(runtime.subagent.run.mock.callCount(), 1);
      const call = runtime.subagent.run.mock.calls[0].arguments[0];
      assert.equal(call.deliver, true);
      assert.equal(call.message, "Rendertext live");
      assert.equal(call.idempotencyKey, "human-engine-dm-proactive-fu-20260824-as-live");
      const entries = readLog(stateDir);
      assert.equal(entries[0].sent, true);
      assert.equal(entries[0].candidate.id, "fu-20260824-as-live");
    });

    it("live + gate fail (quiet hours): cancels (v2 — no dist fallback), subagent.run not called, logged", async () => {
      const runtime = makeRuntime({ llmText: "Rendertext" });
      const { dm, stateDir } = track(makeDm({
        cfg: makeCfg({ shadow: false, minGapMinutes: 0 }),
        runtime,
        now0: new Date(2026, 7, 24, 23, 30).getTime(),
      }));
      const result = await dm.onMessageSending({ content: envelopeText(makeEnvelope({ id: "fu-20260824-as-quiet" })) }, { sessionKey: SK });
      assert.deepEqual(result, { cancel: true }, "v2 live gate-fail must cancel — there is no fallback lane");
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
      const entries = readLog(stateDir);
      assert.equal(entries[0].gate.pass, false);
      assert.ok(entries[0].gate.reasons.includes("quiet-hours"), entries[0].gate.reasons.join(","));
    });

    it("live + plain text without envelope: pass-through untouched, no send, no log", async () => {
      const runtime = makeRuntime();
      const { dm, stateDir } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }), runtime }));
      const result = await dm.onMessageSending({ content: "Freeform text, not an envelope" }, { sessionKey: SK });
      assert.equal(result, undefined, "normal agent text must never be touched (fail-open)");
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
      assert.equal(readLog(stateDir).length, 0);
    });

    it("live + no runtime.subagent.run: delivers the stripped raw draft (fail-open, no lost send)", async () => {
      const runtime = makeRuntime();
      runtime.subagent.run = undefined;
      const { dm, stateDir } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }), runtime }));
      const result = await dm.onMessageSending({ content: envelopeText(makeEnvelope({ id: "fu-20260824-no-rt" })) }, { sessionKey: SK });
      assert.deepEqual(result, { content: "Kommt ihr heute noch am Projekt voran?" });
      const entries = readLog(stateDir);
      assert.equal(entries[0].sent, false);
    });

    it("live + subagent.run throws: still cancels, WARN logged with candidate id, budget NOT bumped", async () => {
      const runtime = makeRuntime({ llmText: "Rendertext" });
      runtime.subagent.run = mock.fn(async () => { throw new Error("boom"); });
      const { dm, clock, stateDir, log } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }), runtime }));
      const result = await dm.onMessageSending({ content: envelopeText(makeEnvelope({ id: "fu-20260824-as-throw" })) }, { sessionKey: SK });
      assert.deepEqual(result, { cancel: true }, "cancel still returned after failed send");
      assert.ok(log._warns.some((m) => m.includes("live send failed after cancel") && m.includes("as-throw")), log._warns.join("\n"));
      clock.t += 24 * 60 * 60 * 1000;
      const next = dm.evaluateGate(makeCandidate({ id: "cm_as_throw_2" }));
      assert.equal(next.pass, true, "budget must NOT be bumped after failed send");
      const entries = readLog(stateDir);
      assert.equal(entries[0].sent, false);
    });

    it("duplicate sentId in live: second cron retry is cancelled without a second send", async () => {
      const runtime = makeRuntime({ llmText: "Rendertext" });
      const { dm, stateDir } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }), runtime }));
      const content = envelopeText(makeEnvelope({ id: "fu-20260824-as-dup" }));
      const first = await dm.onMessageSending({ content }, { sessionKey: SK });
      assert.deepEqual(first, { cancel: true });
      assert.equal(runtime.subagent.run.mock.callCount(), 1);
      const second = await dm.onMessageSending({ content }, { sessionKey: SK });
      assert.deepEqual(second, { cancel: true }, "duplicate must cancel in live");
      assert.equal(runtime.subagent.run.mock.callCount(), 1, "duplicate must NOT send twice");
      const entries = readLog(stateDir);
      assert.equal(entries.length, 2);
      assert.ok(entries[1].gate.reasons.includes("duplicate"), entries[1].gate.reasons.join(","));
      assert.equal(entries[1].sent, false);
    });
  });

  describe("e2e dry run with a followup envelope fixture", () => {
    it("ugly raw template from the cron renders (no-llm fallback) into the shadow log with candidate metadata", async () => {
      const { dm, stateDir } = track(makeDm({ runtime: { subagent: { run: mock.fn() }, llm: null } }));
      const envelope = makeEnvelope({
        id: "fu-20260824-voyage-dup-01",
        kind: "care_check_in",
        sensitivity: "care",
        confidence: 0.88,
      });
      await dm.onMessageSending({ content: envelopeText(envelope, "Kurzer Check-in: Alles okay? Du wolltest ja noch was nachreichen.") }, { sessionKey: SK });
      const entries = readLog(stateDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].candidate.id, "fu-20260824-voyage-dup-01");
      assert.equal(entries[0].candidate.kind, "care_check_in");
      assert.equal(entries[0].suggestedText.includes("nachreichen"), true);
      assert.equal(typeof entries[0].gate.pass, "boolean");
      assert.equal(typeof entries[0].render.draft, "string");
      assert.equal(entries[0].sent, false, "shadow dry run must never send");
    });
  });

  describe("DayFit gating (Plan 531 §2.2)", () => {
    const DF_DIR = path.join(tmpDir, "dayfit");
    function writeActivity(activityAtMs) {
      fs.mkdirSync(DF_DIR, { recursive: true });
      fs.writeFileSync(path.join(DF_DIR, "kevin-activity.json"), JSON.stringify({ lastKnownKevinActivityAtMs: activityAtMs }), "utf8");
    }
    function makeDfDm(overrides = {}) {
      return makeDm({
        cfg: makeCfg({ shadow: false, minGapMinutes: 0, dayFitReduceHours: 4, dayFitPauseHours: 12 }),
        activityFilePath: path.join(DF_DIR, "kevin-activity.json"),
        ...overrides,
      });
    }

    beforeEach(() => {
      resetDayFitWarn();
      fs.rmSync(DF_DIR, { recursive: true, force: true });
    });

    it("soft_followup is reduced (cap halved) when DayFit = 0.5 (age 6h)", async () => {
      writeActivity(T0 - 6 * 60 * 60 * 1000);
      const { dm } = track(makeDfDm());
      // budgetPerDay=2, reduced soft cap = ceil(2*0.5)=1
      await dm.handleCandidate(makeCandidate({ id: "cm_df_reduced_1", kind: "soft_followup", sensitivity: "normal", dueWindow: { earliestMs: T0, latestMs: T0 + 3600000 } }));
      const res = dm.evaluateGate(makeCandidate({ id: "cm_df_reduced_2", kind: "soft_followup", sensitivity: "normal", dueWindow: { earliestMs: T0, latestMs: T0 + 3600000 } }));
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("budget"), res.reasons.join(","));
    });

    it("soft_followup blocked with dayfit-stale when DayFit = null (age 20h)", async () => {
      writeActivity(T0 - 20 * 60 * 60 * 1000);
      const { dm } = track(makeDfDm());
      const res = dm.evaluateGate(makeCandidate({ id: "cm_df_stale", kind: "soft_followup", sensitivity: "normal", dueWindow: { earliestMs: T0, latestMs: T0 + 3600000 } }));
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("dayfit-stale"), res.reasons.join(","));
      assert.equal(res.verdicts["dayfit-stale"], false);
    });

    it("soft_followup blocked with dayfit-unknown when the activity file is missing", async () => {
      // no file written → DF_DIR empty
      const { dm } = track(makeDfDm());
      const res = dm.evaluateGate(makeCandidate({ id: "cm_df_unknown", kind: "soft_followup", sensitivity: "normal", dueWindow: { earliestMs: T0, latestMs: T0 + 3600000 } }));
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("dayfit-unknown"), res.reasons.join(","));
      assert.equal(res.verdicts["dayfit-unknown"], false);
    });

    it("hard reminder (reminder) passes in ALL DayFit bands (full/reduced/stale/unknown)", async () => {
      const bands = [
        { name: "full", activity: T0 - 1 * 60 * 60 * 1000, file: true },
        { name: "reduced", activity: T0 - 6 * 60 * 60 * 1000, file: true },
        { name: "stale", activity: T0 - 20 * 60 * 60 * 1000, file: true },
        { name: "unknown", activity: null, file: false },
      ];
      for (const b of bands) {
        resetDayFitWarn();
        fs.rmSync(DF_DIR, { recursive: true, force: true });
        if (b.file) writeActivity(b.activity);
        const { dm } = track(makeDfDm());
        const res = dm.evaluateGate(makeCandidate({ id: "cm_hard_" + b.name, kind: "reminder", sensitivity: "normal", dueWindow: { earliestMs: T0, latestMs: T0 + 3600000 } }));
        assert.equal(res.pass, true, `reminder must pass in ${b.name} band: ${res.reasons.join(",")}`);
        assert.ok(!res.reasons.includes("dayfit-stale") && !res.reasons.includes("dayfit-unknown"), b.name);
      }
    });

    it("event reminder passes in stale band (DayFit-independent)", async () => {
      writeActivity(T0 - 20 * 60 * 60 * 1000);
      const { dm } = track(makeDfDm());
      const res = dm.evaluateGate(makeCandidate({ id: "cm_event_stale", kind: "event", sensitivity: "normal", dueWindow: { earliestMs: T0, latestMs: T0 + 3600000 } }));
      assert.equal(res.pass, true, res.reasons.join(","));
    });

    it("care_check_in at care sensitivity passes in stale band (own rules, not DayFit)", async () => {
      writeActivity(T0 - 20 * 60 * 60 * 1000);
      const { dm } = track(makeDfDm());
      const res = dm.evaluateGate(makeCandidate({ id: "cm_care_df", kind: "care_check_in", sensitivity: "care", dueWindow: { earliestMs: T0, latestMs: T0 + 3600000 } }));
      assert.equal(res.pass, true, res.reasons.join(","));
    });

    it("full DayFit (age 1h) allows soft_followup with normal cap", async () => {
      writeActivity(T0 - 1 * 60 * 60 * 1000);
      const { dm } = track(makeDfDm());
      const res = dm.evaluateGate(makeCandidate({ id: "cm_df_full", kind: "soft_followup", sensitivity: "normal", dueWindow: { earliestMs: T0, latestMs: T0 + 3600000 } }));
      assert.equal(res.pass, true, res.reasons.join(","));
    });

    it("dayFitFactor unit behavior is covered by dayfit.test.js", () => {
      const p = path.join(DF_DIR, "kevin-activity.json");
      fs.mkdirSync(DF_DIR, { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ lastKnownKevinActivityAtMs: Date.now() - 6 * 60 * 60 * 1000 }), "utf8");
      const r = dayFitFactor({ now: Date.now(), filePath: p, cache: {} });
      assert.equal(r.value, 0.5);
    });
  });

  describe("state persistence", () => {
    it("writes dm-proactive-state.json and dm-proactive.jsonl with mode 0600", async () => {
      const { dm } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }) }));
      await dm.handleCandidate(makeCandidate({ id: "cm_persist_001" }));
      dm.stop();
      const stateFile = path.join(tmpDir, "dm-proactive-state.json");
      const logFile = path.join(tmpDir, "dm-proactive.jsonl");
      assert.ok(fs.existsSync(stateFile));
      assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
      assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
      const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      assert.ok(data.scopes[SCOPE], "budget persisted for scope");
    });

    it("budget/care markers survive recreate (roundtrip)", async () => {
      const { dm, clock } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }) }));
      await dm.handleCandidate(makeCareCandidate({ id: "cm_rt_001" }));
      dm.stop();
      clock.t += 49 * 60 * 60 * 1000;
      const second = makeDm({ now0: clock.t, cfg: makeCfg({ shadow: false, minGapMinutes: 0 }) });
      const res = second.dm.evaluateGate(makeCareCandidate({ id: "cm_rt_002" }));
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("care-no-reply-48h"), res.reasons.join(","));
    });

    it("stop() flushes dirty budget synchronously to disk", async () => {
      const { dm } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }) }));
      await dm.handleCandidate(makeCandidate({ id: "cm_stop_001" }));
      const stateFile = path.join(tmpDir, "dm-proactive-state.json");
      fs.rmSync(stateFile, { force: true });
      dm.stop();
      const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      assert.ok(data.scopes[SCOPE], "stop() must persist the dirty budget");
    });

    it("v1 state (only scopes) loads unchanged — sentIds stays empty", async () => {
      writeState(tmpDir, { scopes: { [SCOPE]: { day: localDayKey(T0), count: 1, careCount: 0, lastSentAt: T0, lastCareSentAt: 0, lastReplyAtMs: 0 } } });
      const { dm, log } = track(makeDm({ now0: T0 }));
      const res = dm.evaluateGate(makeCandidate({ id: "fu-20260824-v1-load" }));
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("min-gap"), res.reasons.join(","));
      assert.ok(log._warns.length === 0, "v1 state must load without warnings");
    });

    it("sentIds persist and are bounded (LRU 512)", async () => {
      const old = [];
      for (let i = 0; i < 600; i++) old.push("fu-20200101-old-" + i);
      writeState(tmpDir, { scopes: {}, sentIds: old });
      const { dm, clock } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }) }));
      await dm.handleCandidate(makeCandidate({ id: "fu-20260824-live-001" }));
      dm.stop();
      clock.t += 24 * 60 * 60 * 1000;
      const second = makeDm({ now0: clock.t, cfg: makeCfg({ shadow: false, minGapMinutes: 0 }) });
      const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "dm-proactive-state.json"), "utf8"));
      assert.ok(Array.isArray(data.sentIds));
      assert.ok(data.sentIds.length <= 512, "sentIds must stay bounded");
      assert.ok(data.sentIds.includes("fu-20260824-live-001"), "delivered id must be recorded");
      assert.ok(!data.sentIds.includes("fu-20200101-old-0"), "oldest ids must be evicted");
      const dup = second.dm.evaluateGate(makeCandidate({ id: "fu-20260824-live-001", dueWindow: { earliestMs: clock.t, latestMs: clock.t + 3600000 } }));
      assert.ok(dup.reasons.includes("duplicate"), "recorded sentId must gate a retry as duplicate");
    });
  });

  describe("followup envelope parsing (design §2.1)", () => {
    it("valid envelope parses with draft and all contract fields", () => {
      const parsed = parseFollowupEnvelope(envelopeText());
      assert.equal(parsed.ok, true);
      assert.equal(parsed.envelope.id, "fu-20260824-test-001");
      assert.equal(parsed.envelope.kind, "soft_followup");
      assert.equal(parsed.draftText, "Kommt ihr heute noch am Projekt voran?");
    });

    it("unknown fields are tolerated (§7.1 — ignored, not rejected)", () => {
      const parsed = parseFollowupEnvelope(envelopeText(makeEnvelope({ schemaVersion: 2, futureField: "x" })));
      assert.equal(parsed.ok, true);
    });

    it("content without an envelope line returns null (normal agent text)", () => {
      assert.equal(parseFollowupEnvelope("Ganz normale Antwort ohne Envelope."), null);
      assert.equal(parseFollowupEnvelope(""), null);
    });

    it("malformed envelope JSON reports json-parse", () => {
      const parsed = parseFollowupEnvelope('[[fu:{"id":broken}]]\nDraft');
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error, "json-parse");
    });

    it("unterminated envelope line and empty draft are malformed", () => {
      assert.equal(parseFollowupEnvelope('[[fu:{"id":"fu-20260824-x"}\nDraft').error, "unterminated");
      assert.equal(parseFollowupEnvelope('[[fu:{"id":"fu-20260824-x"}]]').error, "empty-draft");
    });

    it("schema violations are rejected with distinct error codes", () => {
      assert.equal(parseFollowupEnvelope(envelopeText(makeEnvelope({ id: "wrong-format" }))).error, "bad-id");
      assert.equal(parseFollowupEnvelope(envelopeText(makeEnvelope({ kind: "open_loop" }))).error, "bad-kind");
      assert.equal(parseFollowupEnvelope(envelopeText(makeEnvelope({ sensitivity: "urgent" }))).error, "bad-sensitivity");
      assert.equal(parseFollowupEnvelope(envelopeText(makeEnvelope({ confidence: 1.5 }))).error, "bad-confidence");
      assert.equal(parseFollowupEnvelope(envelopeText(makeEnvelope({ dueWindow: null }))).error, "bad-due-window");
      assert.equal(parseFollowupEnvelope(envelopeText(makeEnvelope({ source: "" }))).error, "bad-source");
    });

    it("lastUserRefMs is mandatory for soft_followup only (§3 Q3)", () => {
      const without = makeEnvelope({ id: "fu-20260824-noref", kind: "soft_followup" });
      delete without.lastUserRefMs;
      assert.equal(parseFollowupEnvelope(envelopeText(without)).error, "missing-last-user-ref");
      const reminder = makeEnvelope({ id: "fu-20260824-rem", kind: "reminder" });
      delete reminder.lastUserRefMs;
      assert.equal(parseFollowupEnvelope(envelopeText(reminder)).ok, true);
    });

    it("candidateFromEnvelope maps the envelope onto the candidate shape", () => {
      const parsed = parseFollowupEnvelope(envelopeText());
      const candidate = candidateFromEnvelope(parsed.envelope, parsed.draftText, SK, "hori-wa");
      assert.equal(candidate.id, parsed.envelope.id);
      assert.equal(candidate.suggestedText, parsed.draftText);
      assert.equal(candidate.sessionKey, SK);
      assert.equal(candidate.agentId, "hori-wa");
      assert.deepEqual(candidate.dueWindow, parsed.envelope.dueWindow);
    });
  });

  describe("cadence state v2 (Plan 532 §2.3)", () => {
    function makeCdDm(overrides = {}) {
      return makeDm({
        cfg: makeCfg({ shadow: false, minGapMinutes: 0, inferredCapPerDay: 2, ...overrides.cfg }),
        ...overrides,
      });
    }
    // helper: deliver a candidate and advance the clock to clear min-gap
    async function deliver(dm, clock, cand, gapMs = 1) {
      await dm.handleCandidate(cand);
      clock.t += gapMs;
    }
    function softCand(id) {
      return makeCandidate({ id, kind: "soft_followup", sensitivity: "normal", dueWindow: { earliestMs: T0, latestMs: T0 + 3600000 } });
    }
    function hardCand(id) {
      return makeCandidate({ id, kind: "reminder", sensitivity: "normal", dueWindow: { earliestMs: T0, latestMs: T0 + 3600000 } });
    }

    it("v1 state (only scopes + sentIds) loads unchanged and state file gains byKind on first save (v2 shape)", async () => {
      writeState(tmpDir, { scopes: { [SCOPE]: { day: localDayKey(T0), count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: 0, lastReplyAtMs: 0 } }, sentIds: [] });
      const { dm } = track(makeCdDm({ now0: T0 }));
      await dm.handleCandidate(softCand("fu-20260824-cad-v1"));
      dm.stop();
      const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "dm-proactive-state.json"), "utf8"));
      assert.ok(data.scopes[SCOPE], "v1 scopes must remain readable");
      assert.ok(data.byKind && typeof data.byKind === "object", "byKind must appear in v2 shape after first save");
      assert.ok(data.byKind.soft_followup, "soft_followup byKind entry created");
      assert.ok(Array.isArray(data.byKind.soft_followup.sends), "sends array present");
    });

    it("cap formula: ceil(inferredCapPerDay × dayFit × budgetMultiplier) — 2 × 0.5 × 0.5 = ceil(0.5) = 1", async () => {
      // DayFit reduced (0.5): write activity 6h old.
      const DF_DIR2 = path.join(tmpDir, "dayfit-cap");
      fs.mkdirSync(DF_DIR2, { recursive: true });
      fs.writeFileSync(path.join(DF_DIR2, "kevin-activity.json"), JSON.stringify({ lastKnownKevinActivityAtMs: T0 - 6 * 60 * 60 * 1000 }), "utf8");
      // multiplier 0.5 via ignoreStreak = 2
      writeState(tmpDir, { scopes: {}, byKind: { soft_followup: { budgetMultiplier: 1.0, sends: [{ ts: T0 - 2 * 86400000, scope: SCOPE, id: "fu-20260822-a" }, { ts: T0 - 86400000, scope: SCOPE, id: "fu-20260823-b" }], replyRate14d: 0.0, ignoreStreak: 2, paused: false } }, sentIds: [] });
      const { dm, clock } = track(makeCdDm({ now0: T0, activityFilePath: path.join(DF_DIR2, "kevin-activity.json") }));
      await deliver(dm, clock, softCand("fu-20260824-cap-1"));
      const res = dm.evaluateGate(softCand("fu-20260824-cap-2"));
      assert.equal(res.pass, false, "after 1 send with cap=1 the 2nd must block");
      assert.ok(res.reasons.includes("budget"), res.reasons.join(","));
    });

    it("ignoreStreak ≥ 2 → budgetMultiplier 0.5 (soft cap halved)", async () => {
      writeState(tmpDir, { scopes: {}, byKind: { soft_followup: { budgetMultiplier: 1.0, sends: [{ ts: T0 - 2 * 86400000, scope: SCOPE, id: "fu-20260822-a" }, { ts: T0 - 86400000, scope: SCOPE, id: "fu-20260823-b" }], replyRate14d: 0.0, ignoreStreak: 2, paused: false } }, sentIds: [] });
      const { dm, clock } = track(makeCdDm({ now0: T0 }));
      // full DayFit, cap 2, multiplier 0.5 → ceil(2*1*0.5)=1 → 1st send fills cap
      await deliver(dm, clock, softCand("fu-20260824-ms-1"));
      const res = dm.evaluateGate(softCand("fu-20260824-ms-2"));
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("budget"), res.reasons.join(","));
    });

    it("ignoreStreak ≥ 4 → cadence-paused blocks soft-tier of the kind; hard reminders still pass", async () => {
      writeState(tmpDir, { scopes: {}, byKind: { soft_followup: { budgetMultiplier: 1.0, sends: [{ ts: T0 - 4 * 86400000, scope: SCOPE, id: "a" }, { ts: T0 - 3 * 86400000, scope: SCOPE, id: "b" }, { ts: T0 - 2 * 86400000, scope: SCOPE, id: "c" }, { ts: T0 - 86400000, scope: SCOPE, id: "d" }], replyRate14d: 0.0, ignoreStreak: 4, paused: false } }, sentIds: [] });
      const { dm } = track(makeCdDm({ now0: T0 }));
      const softRes = dm.evaluateGate(softCand("fu-20260824-paused-soft"));
      assert.equal(softRes.pass, false);
      assert.ok(softRes.reasons.includes("cadence-paused"), softRes.reasons.join(","));
      const hardRes = dm.evaluateGate(hardCand("fu-20260824-paused-hard"));
      assert.equal(hardRes.pass, true, "hard reminder must pass despite paused kind: " + hardRes.reasons.join(","));
      assert.ok(!hardRes.reasons.includes("cadence-paused"), "cadence-paused must not gate hard reminders");
    });

    it("reply attribution: inbound ≤ 48 h answers the last sent candidate, resets ignoreStreak, updates replyRate14d", async () => {
      writeState(tmpDir, { scopes: {}, byKind: { soft_followup: { budgetMultiplier: 1.0, sends: [{ ts: T0 - 2 * 86400000, scope: SCOPE, id: "a" }, { ts: T0 - 86400000, scope: SCOPE, id: "b" }], replyRate14d: 0.0, ignoreStreak: 2, paused: false } }, sentIds: [] });
      const { dm, clock } = track(makeCdDm({ now0: T0 }));
      await deliver(dm, clock, softCand("fu-20260824-attrib"));
      // inbound 1h later → attribution
      clock.t += 1 * 60 * 60 * 1000;
      await dm.onMessageReceived({ content: "Ja passt." }, { sessionKey: SK });
      dm.stop();
      const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "dm-proactive-state.json"), "utf8"));
      const k = data.byKind.soft_followup;
      assert.equal(k.ignoreStreak, 0, "reply must reset ignoreStreak");
      assert.ok(k.replyRate14d > 0, "replyRate14d must update after an attributed reply");
      const lastSend = k.sends[k.sends.length - 1];
      assert.ok(lastSend.answeredAt, "last send must be marked answered");
    });

    it("sends list is pruned to the 14-day window on save", async () => {
      writeState(tmpDir, { scopes: {}, byKind: { soft_followup: { budgetMultiplier: 1.0, sends: [{ ts: T0 - 30 * 86400000, scope: SCOPE, id: "old" }, { ts: T0 - 5 * 86400000, scope: SCOPE, id: "recent" }], replyRate14d: 0.0, ignoreStreak: 0, paused: false } }, sentIds: [] });
      const { dm } = track(makeCdDm({ now0: T0 }));
      await dm.handleCandidate(softCand("fu-20260824-prune"));
      dm.stop();
      const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "dm-proactive-state.json"), "utf8"));
      const k = data.byKind.soft_followup;
      const hasOld = k.sends.some((s) => s.id === "old");
      assert.equal(hasOld, false, "sends older than 14 days must be pruned");
      assert.ok(k.sends.some((s) => s.id === "recent"), "recent sends must survive");
    });

    it("hard reminder uses budgetPerDay (DoS fallback) and is exempt from inferredCap", async () => {
      const { dm, clock } = track(makeCdDm({ now0: T0 }));
      // budgetPerDay=2 (BASE_DM) is the hard-tier cap; soft inferredCap=2 with
      // full multiplier also =2, so use a distinguishing check: hard reminders
      // are NOT cadence-gated and use budgetPerDay. After 2 hard sends the 3rd blocks.
      for (let i = 0; i < 2; i++) await deliver(dm, clock, hardCand("fu-20260824-hard-" + i));
      const res3 = dm.evaluateGate(hardCand("fu-20260824-hard-2"));
      assert.equal(res3.pass, false, "3rd hard reminder must block (budgetPerDay=2): " + res3.reasons.join(","));
      assert.ok(res3.reasons.includes("budget"), res3.reasons.join(","));
      // And hard reminders are never cadence-paused even when the kind is paused.
      writeState(tmpDir, { scopes: {}, byKind: { reminder: { budgetMultiplier: 0, sends: [], replyRate14d: 0.0, ignoreStreak: 4, paused: true } }, sentIds: [] });
      const { dm: dm2 } = track(makeCdDm({ now0: T0 }));
      const resPaused = dm2.evaluateGate(hardCand("fu-20260824-hard-paused"));
      assert.equal(resPaused.pass, true, "paused reminder kind must NOT gate a hard reminder: " + resPaused.reasons.join(","));
    });
  });

  describe("shared gate-core verdicts (lib/dm-gate-core.js)", () => {
    it("exposes per-check verdicts alongside reasons", () => {
      const quietNow = new Date(2026, 7, 24, 23, 30).getTime();
      const res = evaluateDmGate(candidateFromEnvelope(makeEnvelope(), "draft", SK, "hori-wa"), { dcfg: BASE_DM, now: quietNow });
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("quiet-hours"));
      assert.equal(res.verdicts["quiet-hours"], false);
      assert.equal(res.verdicts.budget, true);
      assert.equal(res.verdicts.duplicate, true);
    });

    it("duplicate sentId fails the gate", () => {
      const res = evaluateDmGate(candidateFromEnvelope(makeEnvelope(), "draft", SK, "hori-wa"), { dcfg: BASE_DM, now: T0, duplicate: true });
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("duplicate"));
      assert.equal(res.verdicts.duplicate, false);
    });

    it("missing counter (CLI mode) passes scope-dependent checks", () => {
      const res = evaluateDmGate(candidateFromEnvelope(makeEnvelope(), "draft", SK, "hori-wa"), { dcfg: BASE_DM, now: T0 });
      assert.equal(res.pass, true, res.reasons.join(","));
      assert.equal(res.verdicts["min-gap"], true);
    });
  });

  describe("followup-gate CLI (layer 1, bin/followup-gate.mjs)", () => {
    const cfgFixture = path.join(tmpDir, "fixture-config.json");
    const stateFixture = path.join(tmpDir, "fixture-state.json");

    function runGate(args, input) {
      // spawn + stdin.end(): execFile's `input` option deadlocks with a
      // stdin-reading child in this Node version — verified minimal repro.
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [BIN_GATE, "check", ...args], { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { stderr += d; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        if (input !== undefined) child.stdin.end(input);
        else child.stdin.end();
      });
    }

    function parseOut(stdout) {
      return JSON.parse(stdout.trim().split("\n").pop());
    }

    beforeEach(() => {
      writeState(tmpDir, {});
      fs.writeFileSync(cfgFixture, JSON.stringify({ dmProactive: { ...BASE_DM } }), "utf8");
      fs.writeFileSync(stateFixture, JSON.stringify({ scopes: {}, sentIds: [] }), "utf8");
    });

    it("check --file returns a pass verdict for a valid envelope", async () => {
      const envFile = path.join(tmpDir, "env.json");
      fs.writeFileSync(envFile, envelopeText(), "utf8");
      const { code, stdout } = await runGate(["--file", envFile, "--config", cfgFixture, "--state", stateFixture, "--now", String(T0)]);
      assert.equal(code, 0);
      const out = parseOut(stdout);
      assert.equal(out.valid, true);
      assert.equal(out.pass, true);
      assert.deepEqual(out.reasons, []);
      assert.equal(out.candidate.id, "fu-20260824-test-001");
    });

    it("check via STDIN blocks on quiet hours with reasons", async () => {
      const { code, stdout } = await runGate(["--config", cfgFixture, "--state", stateFixture, "--now", String(new Date(2026, 7, 24, 23, 30).getTime())], envelopeText());
      assert.equal(code, 1);
      const out = parseOut(stdout);
      assert.equal(out.pass, false);
      assert.ok(out.reasons.includes("quiet-hours"), out.reasons.join(","));
      assert.equal(out.verdicts["quiet-hours"], false);
    });

    it("check blocks a duplicate sentId from the plugin state", async () => {
      fs.writeFileSync(stateFixture, JSON.stringify({ scopes: {}, sentIds: ["fu-20260824-test-001"] }), "utf8");
      const { code, stdout } = await runGate(["--config", cfgFixture, "--state", stateFixture, "--now", String(T0)], envelopeText());
      assert.equal(code, 1);
      const out = parseOut(stdout);
      assert.equal(out.pass, false);
      assert.ok(out.reasons.includes("duplicate"), out.reasons.join(","));
    });

    it("check blocks on budget via the scope counter from state", async () => {
      fs.writeFileSync(stateFixture, JSON.stringify({ scopes: { [SCOPE]: { day: localDayKey(T0), count: 2, careCount: 0, lastSentAt: T0, lastCareSentAt: 0, lastReplyAtMs: 0 } }, sentIds: [] }), "utf8");
      const { code, stdout } = await runGate(["--config", cfgFixture, "--state", stateFixture, "--session", SK, "--agent", "hori-wa", "--now", String(T0)], envelopeText());
      assert.equal(code, 1);
      const out = parseOut(stdout);
      assert.equal(out.pass, false);
      assert.ok(out.reasons.includes("budget"), out.reasons.join(","));
      assert.equal(out.scope, SCOPE);
    });

    it("invalid envelope exits 2 with an error code", async () => {
      const { code, stdout } = await runGate(["--config", cfgFixture, "--state", stateFixture], '[[fu:{broken}]]\nDraft');
      assert.equal(code, 2);
      const out = parseOut(stdout);
      assert.equal(out.valid, false);
      assert.equal(out.error, "json-parse");
    });

    it("content without an envelope exits 2 with no-envelope", async () => {
      const { code, stdout } = await runGate(["--config", cfgFixture, "--state", stateFixture], "Just a normal message.");
      assert.equal(code, 2);
      assert.equal(parseOut(stdout).error, "no-envelope");
    });
  });
});