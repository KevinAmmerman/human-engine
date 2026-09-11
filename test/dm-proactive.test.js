import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createDmProactive } from "../lib/dm-proactive.js";
import { parseFollowupEnvelope, evaluateDmGate, candidateFromEnvelope } from "../lib/dm-gate-core.js";
import { createInitiativeStore } from "../lib/initiative-store.js";
import { createProactivityOutbox } from "../lib/proactivity-outbox.js";
import { localDayKey } from "../lib/proactive.js";
import { setRng, resetRng } from "../lib/proactive.js";
import * as state from "../lib/state.js";
import { dayFitFactor, resetDayFitWarn } from "../lib/dayfit.js";
import { SK, SCOPE, readLog, assertV2EntryShape, LOG_RETENTION_DAYS } from "./helpers/dm-proactive-fixtures.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-proactive-test-"));
const PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BIN_GATE = path.join(PLUGIN_ROOT, "bin", "followup-gate.mjs");
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
    ledger: overrides.ledger,
    outbox: overrides.outbox,
  });
  return { dm, cfg, clock, runtime, socialMemory, log, stateDir, ledger: overrides.ledger, outbox: overrides.outbox };
}

function writeState(stateDir, data) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "dm-proactive-state.json"), JSON.stringify(data), "utf8");
}

// Plan 618: seed a durable initiative ledger file at the path the store reads
// (`<stateDir>/initiative/<pathSafe(agentId)>/<pathSafe(sessionKey)>.json`).
// Fake ids only (public repo).
function writeInitiativeState(stateDir, agentId, sessionKey, tasks, cooldowns = {}) {
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = path.join(stateDir, "initiative", safe(agentId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, safe(sessionKey) + ".json"), JSON.stringify({
    version: 1,
    scope: agentId + "::" + sessionKey,
    agentId,
    tasks,
    directives: [],
    cooldowns,
  }), "utf8");
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

    it("malformed envelope with [[fu: prefix in SHADOW → cancel (fail closed), malformed-envelope logged, never delivered ungated (Plan 619)", async () => {
      const { dm, stateDir, log } = track(makeDm());
      const broken = "[[fu:{\"id\":broken…}]]\nDraft text";
      const result = await dm.onMessageSending({ content: broken }, { sessionKey: SK });
      assert.deepEqual(result, { cancel: true }, "shadow must fail closed — never deliver an ungated draft");
      const entries = readLog(stateDir);
      assert.equal(entries.length, 1, "the malformed attempt must be logged");
      assert.equal(entries[0].gatePassed, false, "malformed envelope never passes the gate");
      assert.ok(entries[0].gate.reasons.includes("malformed-envelope"), entries[0].gate.reasons.join(","));
      assert.deepEqual(entries[0].gateVerdicts, {}, "no gate verdicts are computed for an unparseable envelope");
      assert.equal(entries[0].suggestedText, "Draft text", "the draft is preserved in the log for review only");
    });

    it("malformed envelope with [[fu: prefix in LIVE → cancel + malformed-envelope logged, never delivered (Plan 546 AMENDMENT 3)", async () => {
      const { dm, stateDir, log } = track(makeDm({ cfg: makeCfg({ shadow: false }) }));
      const broken = "[[fu:{\"id\":broken…}]]\nDraft text";
      const result = await dm.onMessageSending({ content: broken }, { sessionKey: SK });
      assert.deepEqual(result, { cancel: true }, "live must cancel a malformed followup attempt");
      const entries = readLog(stateDir);
      assert.equal(entries.length, 1, "the malformed attempt must be logged");
      assert.equal(entries[0].mode, "live");
      assert.ok(entries[0].gate.reasons.includes("malformed-envelope"), entries[0].gate.reasons.join(","));
    });

    it("plain text WITHOUT the [[fu: prefix stays untouched even if it mentions fu (parity #24 regression)", async () => {
      const { dm, stateDir, log } = track(makeDm());
      const result = await dm.onMessageSending({ content: "Das sind keine Metadaten, nur normaler Text." }, { sessionKey: SK });
      assert.equal(result, undefined, "normal text must never be touched");
      assert.equal(readLog(stateDir).length, 0);
    });

    it("repeated envelope sends with the same id in shadow: first delivers, second is cancelled as duplicate (Plan 536 AMENDMENT 2)", async () => {
      const { dm, stateDir } = track(makeDm());
      const first = await dm.onMessageSending({ content: envelopeText() }, { sessionKey: SK });
      assert.deepEqual(first, { content: "Kommt ihr heute noch am Projekt voran?" }, "first gate-pass shadow send strips the envelope");
      const second = await dm.onMessageSending({ content: envelopeText() }, { sessionKey: SK });
      assert.deepEqual(second, { cancel: true }, "duplicate must cancel in shadow too (pure idempotency — AMENDMENT 2)");
      const entries = readLog(stateDir);
      assert.equal(entries.length, 2, "both candidate deliveries are logged");
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
      assert.equal(call.agentId, "hori-wa");
      assert.equal(call.allowAgentIdOverride, true);
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
      assert.ok(data.agents["hori-wa"].budget[SCOPE], "budget persisted for scope in the agent bucket");
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
      assert.ok(data.agents["hori-wa"].budget[SCOPE], "stop() must persist the dirty budget");
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
      assert.ok(data.version === 4, "state must be written with version 4");
      assert.ok(data.agents && typeof data.agents === "object", "state must be per-agent buckets");
      const agentBucket = data.agents["hori-wa"].sentIds;
      assert.ok(Array.isArray(agentBucket), "agent sentIds bucket must be an array");
      assert.ok(agentBucket.length <= 512, "sentIds must stay bounded");
      assert.ok(agentBucket.includes("fu-20260824-live-001"), "delivered id must be recorded in the agent bucket");
      assert.ok(!data.agents["__legacy__"].sentIds.includes("fu-20200101-old-0"), "oldest ids must be evicted");
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

    it("Plan 619: optional topicKey/owner tolerated when valid, rejected when malformed; absent = valid", () => {
      const ok = parseFollowupEnvelope(envelopeText(makeEnvelope({ topicKey: "tk-abcdef0123456789", owner: "agent" })));
      assert.equal(ok.ok, true);
      assert.equal(ok.envelope.topicKey, "tk-abcdef0123456789");
      assert.equal(ok.envelope.owner, "agent");
      assert.equal(parseFollowupEnvelope(envelopeText()).ok, true, "absent topicKey/owner stays valid (backward compatible)");
      assert.equal(parseFollowupEnvelope(envelopeText(makeEnvelope({ owner: "user" }))).ok, true);
      assert.equal(parseFollowupEnvelope(envelopeText(makeEnvelope({ topicKey: "tk-x" }))).error, "bad-topic-key");
      assert.equal(parseFollowupEnvelope(envelopeText(makeEnvelope({ topicKey: 42 }))).error, "bad-topic-key");
      assert.equal(parseFollowupEnvelope(envelopeText(makeEnvelope({ owner: "robot" }))).error, "bad-owner");
      assert.equal(parseFollowupEnvelope(envelopeText(makeEnvelope({ owner: 5 }))).error, "bad-owner");
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

    it("Plan 546 AMENDMENT 4: kind variants are normalized before validation (care → care_check_in, soft-followup → soft_followup)", () => {
      for (const variant of ["care", "care-check-in", "care_checkin", "CARE", " Care "]) {
        const parsed = parseFollowupEnvelope(envelopeText(makeEnvelope({ id: "fu-20260904-k" + variant.length, kind: variant })));
        assert.equal(parsed.ok, true, "variant '" + variant + "' must validate after normalization");
        assert.equal(parsed.envelope.kind, "care_check_in", "variant '" + variant + "' must normalize to care_check_in");
      }
      for (const variant of ["soft-followup", "softfollowup", "SOFT_FOLLOWUP"]) {
        const parsed = parseFollowupEnvelope(envelopeText(makeEnvelope({ id: "fu-20260904-s" + variant.length, kind: variant })));
        assert.equal(parsed.ok, true, "variant '" + variant + "' must validate after normalization");
        assert.equal(parsed.envelope.kind, "soft_followup", "variant '" + variant + "' must normalize to soft_followup");
      }
      // Unknown kinds still rejected (→ malformed policy).
      assert.equal(parseFollowupEnvelope(envelopeText(makeEnvelope({ kind: "open_loop" }))).error, "bad-kind");
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

    it("Plan 619: candidateFromEnvelope copies topicKey/owner (absent stays undefined)", () => {
      const withTopic = parseFollowupEnvelope(envelopeText(makeEnvelope({ topicKey: "tk-abcdef0123456789", owner: "user" })));
      const c1 = candidateFromEnvelope(withTopic.envelope, withTopic.draftText, SK, "hori-wa");
      assert.equal(c1.topicKey, "tk-abcdef0123456789");
      assert.equal(c1.owner, "user");
      const plain = parseFollowupEnvelope(envelopeText());
      const c2 = candidateFromEnvelope(plain.envelope, plain.draftText, SK, "hori-wa");
      assert.equal(c2.topicKey, undefined);
      assert.equal(c2.owner, undefined);
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
      assert.ok(data.version === 4, "state must be written with version 4");
      assert.ok(data.agents["hori-wa"].budget[SCOPE], "v1 flat scopes must migrate into the agent's budget bucket");
      assert.ok(data.agents && typeof data.agents === "object", "state must be per-agent buckets");
      const agentKinds = data.agents["hori-wa"].byKind;
      assert.ok(agentKinds && agentKinds.soft_followup, "soft_followup byKind entry created for the agent");
      assert.ok(Array.isArray(agentKinds.soft_followup.sends), "sends array present");
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
      const k = data.agents["hori-wa"].byKind.soft_followup;
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
      const k = data.agents["hori-wa"].byKind.soft_followup;
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

  describe("proactive tenancy (Plan 005) — per-agent buckets", () => {
    function agentCand(id, agentId, overrides = {}) {
      return makeCandidate({ id, agentId, kind: "soft_followup", sensitivity: "normal", dueWindow: { earliestMs: T0, latestMs: T0 + 3600000 }, ...overrides });
    }
    function twoAgentCfg() {
      return makeCfg({ shadow: false, minGapMinutes: 0 }, { agents: ["hori-wa", "kletter"] });
    }

    it("v2 flat state migrates to v4: sentIds + byKind move into __legacy__, flat budget scopes split per agent, version written", async () => {
      writeState(tmpDir, {
        scopes: { [SCOPE]: { day: localDayKey(T0), count: 1, careCount: 0, lastSentAt: T0, lastCareSentAt: 0, lastReplyAtMs: 0 } },
        sentIds: ["fu-20260909-legacy-1"],
        byKind: { soft_followup: { budgetMultiplier: 1.0, sends: [{ ts: T0 - 86400000, scope: SCOPE, id: "a" }], replyRate14d: 0.0, ignoreStreak: 2, paused: false } },
      });
      const { dm } = track(makeDm({ now0: T0 }));
      dm.stop(); // triggers the migrate-on-load immediate save
      const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "dm-proactive-state.json"), "utf8"));
      assert.equal(data.version, 4, "state must be written with version 4 after migration");
      assert.ok(data.agents["hori-wa"].budget[SCOPE], "flat scopes must migrate into the agent's budget bucket");
      assert.ok(Array.isArray(data.agents.__legacy__.sentIds) && data.agents.__legacy__.sentIds.includes("fu-20260909-legacy-1"), "flat sentIds migrate to __legacy__");
      assert.ok(data.agents.__legacy__.byKind.soft_followup, "flat byKind migrates to __legacy__");
      assert.equal(data.agents.__legacy__.byKind.soft_followup.ignoreStreak, 2, "legacy ignoreStreak preserved");
    });

    it("sentId in agent-a bucket blocks agent-a but NOT agent-b", async () => {
      writeState(tmpDir, { version: 3, scopes: {}, sentIds: { "hori-wa": ["fu-20260909-a-only"], __legacy__: [] } });
      const { dm } = track(makeDm({ cfg: twoAgentCfg(), now0: T0 }));
      const a = dm.evaluateGate(agentCand("fu-20260909-a-only", "hori-wa"));
      assert.ok(a.reasons.includes("duplicate"), "agent-a must see its own sentId as duplicate");
      const b = dm.evaluateGate(agentCand("fu-20260909-a-only", "kletter"));
      assert.ok(!b.reasons.includes("duplicate"), "agent-b must NOT be blocked by agent-a's sentId");
    });

    it("__legacy__ sentId blocks BOTH agents (transition dedup safety)", async () => {
      writeState(tmpDir, { version: 3, scopes: {}, sentIds: { __legacy__: ["fu-20260909-legacy-dedup"] } });
      const { dm } = track(makeDm({ cfg: twoAgentCfg(), now0: T0 }));
      for (const ag of ["hori-wa", "kletter"]) {
        const r = dm.evaluateGate(agentCand("fu-20260909-legacy-dedup", ag));
        assert.ok(r.reasons.includes("duplicate"), `agent ${ag} must be blocked by __legacy__ sentId`);
      }
    });

    it("proactive tenancy byKind isolation: ignoreStreak of agent-a's kind does NOT pause agent-b's kind", async () => {
      // agent-a has ignoreStreak 4 (paused); agent-b is fresh → full budget.
      writeState(tmpDir, {
        version: 3,
        scopes: {},
        byKind: { "hori-wa": { soft_followup: { budgetMultiplier: 0, sends: [], replyRate14d: 0.0, ignoreStreak: 4, paused: true } } },
      });
      const { dm } = track(makeDm({ cfg: twoAgentCfg(), now0: T0 }));
      const a = dm.evaluateGate(agentCand("fu-20260909-a-paused", "hori-wa"));
      assert.ok(a.reasons.includes("cadence-paused"), "agent-a's paused kind must block its own soft followup");
      const b = dm.evaluateGate(agentCand("fu-20260909-b-full", "kletter"));
      assert.ok(!b.reasons.includes("cadence-paused"), "agent-b's soft followup must NOT be paused by agent-a's ignoreStreak");
    });
  });

  describe("budget tenancy (Plan 017) — per-agent budget buckets", () => {
    function agentCand2(id, agentId, overrides = {}) {
      return makeCandidate({ id, agentId, kind: "soft_followup", sensitivity: "normal", dueWindow: { earliestMs: T0, latestMs: T0 + 3600000 }, ...overrides });
    }
    function twoAgentCfg() {
      return makeCfg({ shadow: false, minGapMinutes: 0 }, { agents: ["hori-wa", "kletter"] });
    }
    function scopeFor(agentId, uid) {
      return agentId + "::agent:" + agentId + ":telegram:direct:" + uid;
    }
    // Seed a budget entry with a non-zero count for one scope, then overflow
    // the SAME agent with >256 distinct inbounds so capObject evicts its
    // oldest scopes — the surviving check must still find the entry.
    it("per-agent eviction: agent-a overflow (260 scopes) does NOT evict agent-b's active budget entry (count stays)", async () => {
      const cfg = twoAgentCfg();
      // agent-b has one active scope with a real count (seeded via a live send).
      const scopeB = scopeFor("kletter", "999000101");
      const { dm, clock } = track(makeDm({ cfg, now0: T0 }));
      await dm.handleCandidate(agentCand2("fu-017-b-active", "kletter", { sessionKey: "agent:kletter:telegram:direct:999000101" }));
      dm.stop();
      const seeded = JSON.parse(fs.readFileSync(path.join(tmpDir, "dm-proactive-state.json"), "utf8"));
      assert.ok(seeded.agents["kletter"].budget[scopeB], "agent-b must have a persisted budget entry");

      // Overflow agent-a's bucket with 260 distinct scopes.
      const { dm: dmA } = track(makeDm({ cfg, now0: clock.t }));
      for (let i = 0; i < 260; i++) {
        const skA = "agent:hori-wa:telegram:direct:" + (900000000 + i);
        await dmA.onMessageReceived({ content: "x" }, { sessionKey: skA, agentId: "hori-wa" });
      }
      dmA.stop();
      const after = JSON.parse(fs.readFileSync(path.join(tmpDir, "dm-proactive-state.json"), "utf8"));
      assert.ok(after.agents["hori-wa"].budget, "agent-a's budget bucket exists");
      const aCount = Object.keys(after.agents["hori-wa"].budget).length;
      assert.ok(aCount <= 256, "agent-a's bucket must be capped at 256 (got " + aCount + ")");
      assert.ok(after.agents["kletter"].budget[scopeB], "agent-b's active budget entry must survive agent-a's eviction");
      assert.equal(after.agents["kletter"].budget[scopeB].count, 1, "agent-b's count must be preserved");
    });

    it("budget is namespaced per agent: bumping agent-a's scope does NOT touch agent-b's counter", async () => {
      const cfg = twoAgentCfg();
      const { dm, clock } = track(makeDm({ cfg, now0: T0 }));
      // Two live sends for agent-b (its own scope).
      const scopeB = scopeFor("kletter", "999000102");
      await dm.handleCandidate(agentCand2("fu-017-b1", "kletter", { sessionKey: "agent:kletter:telegram:direct:999000102" }));
      await dm.handleCandidate(agentCand2("fu-017-b2", "kletter", { sessionKey: "agent:kletter:telegram:direct:999000102" }));
      // One live send for agent-a in its own scope.
      const scopeA = scopeFor("hori-wa", "999000103");
      await dm.handleCandidate(agentCand2("fu-017-a1", "hori-wa", { sessionKey: "agent:hori-wa:telegram:direct:999000103" }));
      dm.stop();
      const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "dm-proactive-state.json"), "utf8"));
      assert.equal(data.agents["kletter"].budget[scopeB].count, 2, "agent-b's count is its own");
      assert.equal(data.agents["hori-wa"].budget[scopeA].count, 1, "agent-a's count is its own");
    });

    it("v3 flat budget migrates into per-agent buckets; unparseable scopes land in __legacy__", async () => {
      const legacyScope = "no-agent-separator"; // no `::` → parseAgentScope returns null
      writeState(tmpDir, {
        version: 3,
        scopes: {
          [SCOPE]: { day: localDayKey(T0), count: 1, careCount: 0, lastSentAt: T0, lastCareSentAt: 0, lastReplyAtMs: 0 },
          [legacyScope]: { day: localDayKey(T0), count: 3, careCount: 0, lastSentAt: T0, lastCareSentAt: 0, lastReplyAtMs: 0 },
        },
        sentIds: { __legacy__: [] },
        byKind: {},
      });
      const { dm } = track(makeDm({ cfg: twoAgentCfg(), now0: T0 }));
      dm.stop(); // migrate-on-load immediate save
      const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "dm-proactive-state.json"), "utf8"));
      assert.equal(data.version, 4, "state must be rewritten as version 4");
      assert.ok(data.agents["hori-wa"].budget[SCOPE], "parseable scope must migrate into its agent's bucket");
      assert.equal(data.agents["hori-wa"].budget[SCOPE].count, 1, "migrated count preserved");
      assert.ok(data.agents["__legacy__"].budget[legacyScope], "unparseable scope must migrate into __legacy__");
      assert.equal(data.agents["__legacy__"].budget[legacyScope].count, 3, "legacy count preserved");
    });

    it("deriveDmFromEvent: owner resolution across two agent budget buckets stays unambiguous", async () => {
      // Seed one real DM scope for hori-wa and one for kletter in SEPARATE
      // buckets (v4 shape). The target belongs to hori-wa only → resolves.
      const UID = "999000104";
      const s1 = scopeFor("hori-wa", UID);
      const s2 = scopeFor("kletter", "555000104");
      writeState(tmpDir, {
        version: 4,
        agents: {
          "hori-wa": { budget: { [s1]: { day: localDayKey(T0), count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: 0, lastReplyAtMs: 0 } }, sentIds: [], byKind: {} },
          "kletter": { budget: { [s2]: { day: localDayKey(T0), count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: 0, lastReplyAtMs: 0 } }, sentIds: [], byKind: {} },
        },
      });
      const multiCfg = { ...makeCfg(), agents: ["hori-wa", "kletter"] };
      const { dm, stateDir } = track(makeDm({ cfg: multiCfg }));
      const event = { to: "telegram:" + UID, content: envelopeText(makeEnvelope({ id: "fu-20260911-derive" })), metadata: { channel: "telegram" } };
      const result = await dm.onMessageSending(event, { channelId: "telegram" });
      assert.deepEqual(result, { content: "Kommt ihr heute noch am Projekt voran?" }, "unambiguous owner across two buckets must resolve");
      const entries = readLog(stateDir);
      assert.equal(entries[0].scope, s1, "scope must resolve to hori-wa's DM lane from its own bucket");
    });
  });

  describe("shadow-log v2 (Plan 533 AP d)", () => {
    function env(id, overrides = {}) {
      return envelopeText(makeEnvelope({ id, ...overrides }));
    }

    it("entry shape v2: day, candidateId, kind, scope, source, gateVerdicts, gatePassed, outcome, envelope + separated renderPreview/render", async () => {
      const { dm, stateDir } = track(makeDm());
      await dm.onMessageSending({ content: env("fu-20260904-shape-001") }, { sessionKey: SK });
      const e = readLog(stateDir)[0];
      assertV2EntryShape(assert, e);
      assert.equal(e.candidateId, "fu-20260904-shape-001");
      assert.equal(e.kind, "soft_followup");
      assert.equal(e.scope, SCOPE);
      assert.equal(e.source, "followup-cron");
      assert.equal(e.gatePassed, true);
      assert.equal(e.gate.pass, true);
      assert.ok(e.envelope && e.envelope.id === "fu-20260904-shape-001");
      assert.equal(e.mode, "shadow");
      // shadow carries renderPreview, and legacy render also populated
      assert.equal(typeof e.renderPreview, "string");
      assert.equal(typeof e.render.draft, "string");
    });

    it("exactly ONE log entry per candidate (append invariant :364-370)", async () => {
      const { dm, stateDir } = track(makeDm());
      for (let i = 0; i < 3; i++) {
        await dm.onMessageSending({ content: env("fu-20260904-one-" + i) }, { sessionKey: SK });
      }
      const entries = readLog(stateDir);
      assert.equal(entries.length, 3);
      const ids = entries.map((x) => x.candidateId);
      assert.equal(new Set(ids).size, 3, "each candidate logged exactly once");
    });

    it("shadow vs live render fields are separated: renderPreview only in shadow, render only in live", async () => {
      // shadow
      const s = track(makeDm({ stateDir: path.join(tmpDir, "sep-shadow") }));
      await s.dm.onMessageSending({ content: env("fu-20260904-sep-shadow") }, { sessionKey: SK });
      const se = readLog(s.stateDir)[0];
      assert.ok("renderPreview" in se, "shadow must carry renderPreview");
      assert.equal(se.mode, "shadow");

      // live (shadow:false)
      const runtime = makeRuntime({ llmText: "Rendertext live" });
      const l = track(makeDm({ stateDir: path.join(tmpDir, "sep-live"), cfg: makeCfg({ shadow: false, minGapMinutes: 0 }), runtime }));
      await l.dm.onMessageSending({ content: env("fu-20260904-sep-live") }, { sessionKey: SK });
      const le = readLog(l.stateDir)[0];
      assert.ok(!("renderPreview" in le), "live must NOT carry renderPreview");
      assert.equal(le.mode, "live");
      assert.equal(typeof le.render.draft, "string");
    });

    it("outcome backfill: a reply sets repliedWithin48h on the attributed scope's last entry (consistent with 532 attribution)", async () => {
      const { dm, clock, stateDir } = track(makeDm());
      // shadow delivery records the attribution marker
      await dm.onMessageSending({ content: env("fu-20260904-bf-001") }, { sessionKey: SK });
      assert.equal(readLog(stateDir)[0].outcome.repliedWithin48h, null);
      // an inbound ≤ 48 h later backfills the same candidate
      clock.t += 1 * 60 * 60 * 1000;
      await dm.onMessageReceived({ content: "Ja, passt." }, { sessionKey: SK });
      const entries = readLog(stateDir);
      assert.equal(entries.length, 1, "backfill must not add or remove entries");
      const matched = entries.filter((e) => e.candidateId === "fu-20260904-bf-001");
      assert.equal(matched.length, 1);
      assert.equal(matched[0].outcome.repliedWithin48h, true);
    });

    it("outcome backfill only touches the attributed scope's entry, not other scopes", async () => {
      const otherSk = "agent:hori-wa:telegram:direct:999999998"; // fake
      const { dm, clock, stateDir } = track(makeDm());
      await dm.onMessageSending({ content: env("fu-20260904-other-a") }, { sessionKey: otherSk });
      await dm.onMessageSending({ content: env("fu-20260904-other-b") }, { sessionKey: SK });
      clock.t += 1 * 60 * 60 * 1000;
      await dm.onMessageReceived({ content: "Antwort" }, { sessionKey: SK });
      const entries = readLog(stateDir);
      const forSk = entries.find((e) => e.candidateId === "fu-20260904-other-b");
      assert.equal(forSk.outcome.repliedWithin48h, true);
      const forOther = entries.find((e) => e.candidateId === "fu-20260904-other-a");
      assert.equal(forOther.outcome.repliedWithin48h, null, "other scope must stay unanswered");
    });

    it("retention: a 20-day synthetic log is pruned to LOG_RETENTION_DAYS; 7-day and 14-day windows stay fully intact", async () => {
      const now = new Date(2026, 8, 4, 12, 0).getTime(); // 2026-09-04 Berlin
      const stateDir = path.join(tmpDir, "retention-20d");
      fs.mkdirSync(stateDir, { recursive: true });
      const logFile = path.join(stateDir, "dm-proactive.jsonl");
      const lines = [];
      const DAY = 24 * 60 * 60 * 1000;
      for (let i = 20; i >= 0; i--) {
        const ts = now - i * DAY;
        lines.push(JSON.stringify({
          ts,
          day: localDayKey(ts),
          candidateId: "fu-" + i,
          scope: SCOPE,
          outcome: { repliedWithin48h: null },
        }));
      }
      fs.writeFileSync(logFile, lines.join("\n") + "\n", "utf8");
      const dm = track(makeDm({ now0: now, stateDir })).dm;
      // appending triggers the prune
      await dm.handleCandidate(makeCandidate({ id: "fu-20260904-prune-trigger" }));
      const entries = readLog(stateDir);
      const days = entries.map((e) => e.day).sort();
      const oldest = days[0];
      const newest = days[days.length - 1];
      const windowDays = new Set(days).size;
      // window: now-(R-1) .. now (R distinct day keys, R+1 entries incl. trigger)
      assert.ok(windowDays <= LOG_RETENTION_DAYS, `expected ≤ ${LOG_RETENTION_DAYS} distinct days, got ${windowDays}`);
      assert.ok(entries.length <= LOG_RETENTION_DAYS + 1, `expected ≤ ${LOG_RETENTION_DAYS + 1} entries, got ${entries.length}`);
      assert.equal(oldest, "2026-08-22", "oldest kept day must be exactly LOG_RETENTION_DAYS days back");
      assert.equal(newest, "2026-09-04", "newest day must be the append day");
      // the 7-day window (2026-08-29..) is a subset → must be fully intact
      const sevenStart = localDayKey(now - 7 * DAY);
      const sevenDays = new Set(entries.filter((e) => e.day >= sevenStart).map((e) => e.day));
      assert.equal(sevenDays.size, 8, "7-day window must be fully intact (8 distinct days incl. today)");
    });

    it("JSONL stays parse-bar after prune and backfill (no corruption, valid JSON per line)", async () => {
      const { dm, clock, stateDir } = track(makeDm());
      for (let i = 0; i < 5; i++) await dm.onMessageSending({ content: env("fu-20260904-parse-" + i) }, { sessionKey: SK });
      clock.t += 1 * 60 * 60 * 1000;
      await dm.onMessageReceived({ content: "hallo" }, { sessionKey: SK });
      const raw = fs.readFileSync(path.join(stateDir, "dm-proactive.jsonl"), "utf8");
      const parsed = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.equal(parsed.length, 5, "all lines must parse");
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

    function topicCand(overrides = {}) {
      return candidateFromEnvelope(
        makeEnvelope({ id: "fu-20260911-topic-1", topicKey: "tk-abcdef0123456789", ...overrides }),
        "draft",
        SK,
        "hori-wa",
      );
    }

    it("Plan 619: topic-cooldown verdict blocks while the ledger cooldown is in the future", () => {
      const blocked = evaluateDmGate(topicCand(), { dcfg: BASE_DM, now: T0, topicState: { attempts: 0, cooldownUntil: T0 + 1000, openAttemptAt: 0 } });
      assert.equal(blocked.verdicts["topic-cooldown"], false);
      assert.ok(blocked.reasons.includes("topic-cooldown"), blocked.reasons.join(","));
      const clear = evaluateDmGate(topicCand(), { dcfg: BASE_DM, now: T0, topicState: { attempts: 0, cooldownUntil: T0 - 1, openAttemptAt: 0 } });
      assert.equal(clear.verdicts["topic-cooldown"], true);
    });

    it("Plan 619: topic-attempts verdict blocks at topicMaxAttempts (default 3, per-agent override)", () => {
      const blocked = evaluateDmGate(topicCand(), { dcfg: BASE_DM, now: T0, topicState: { attempts: 3, cooldownUntil: 0, openAttemptAt: 0 } });
      assert.equal(blocked.verdicts["topic-attempts"], false);
      assert.ok(blocked.reasons.includes("topic-attempts"), blocked.reasons.join(","));
      const below = evaluateDmGate(topicCand(), { dcfg: BASE_DM, now: T0, topicState: { attempts: 2, cooldownUntil: 0, openAttemptAt: 0 } });
      assert.equal(below.verdicts["topic-attempts"], true);
      const custom = evaluateDmGate(topicCand(), { dcfg: { ...BASE_DM, topicMaxAttempts: 1 }, now: T0, topicState: { attempts: 1, cooldownUntil: 0, openAttemptAt: 0 } });
      assert.equal(custom.verdicts["topic-attempts"], false);
    });

    it("Plan 619: topic-open verdict blocks a recent open attempt within openAttemptCooldownMinutes", () => {
      const blocked = evaluateDmGate(topicCand(), { dcfg: BASE_DM, now: T0, topicState: { attempts: 1, cooldownUntil: 0, openAttemptAt: T0 - 60 * 1000 } });
      assert.equal(blocked.verdicts["topic-open"], false);
      assert.ok(blocked.reasons.includes("topic-open"), blocked.reasons.join(","));
      const clear = evaluateDmGate(topicCand(), { dcfg: BASE_DM, now: T0, topicState: { attempts: 1, cooldownUntil: 0, openAttemptAt: T0 - 300 * 60 * 1000 } });
      assert.equal(clear.verdicts["topic-open"], true);
    });

    it("Plan 619: agent-owed verdict blocks owner=agent but allows user/absent", () => {
      const owned = evaluateDmGate(topicCand({ owner: "agent" }), { dcfg: BASE_DM, now: T0 });
      assert.equal(owned.verdicts["agent-owed"], false);
      assert.ok(owned.reasons.includes("agent-owed"), owned.reasons.join(","));
      assert.equal(evaluateDmGate(topicCand({ owner: "user" }), { dcfg: BASE_DM, now: T0 }).verdicts["agent-owed"], true);
      assert.equal(evaluateDmGate(topicCand(), { dcfg: BASE_DM, now: T0 }).verdicts["agent-owed"], true, "absent owner fails open");
    });

    it("Plan 619: topic gates are skipped entirely for candidates without a topicKey (fail-open)", () => {
      const res = evaluateDmGate(candidateFromEnvelope(makeEnvelope(), "draft", SK, "hori-wa"), {
        dcfg: BASE_DM, now: T0, topicState: { attempts: 9, cooldownUntil: T0 + 999999, openAttemptAt: T0 },
      });
      assert.equal(res.verdicts["topic-cooldown"], undefined);
      assert.equal(res.verdicts["topic-attempts"], undefined);
      assert.equal(res.verdicts["topic-open"], undefined);
      assert.equal(res.verdicts["agent-owed"], undefined);
      assert.equal(res.pass, true, res.reasons.join(","));
    });

    it("Plan 619: topicKey set with null topicState fails open (backward compatible)", () => {
      const res = evaluateDmGate(topicCand(), { dcfg: BASE_DM, now: T0 });
      assert.equal(res.verdicts["topic-cooldown"], true);
      assert.equal(res.verdicts["topic-attempts"], true);
      assert.equal(res.verdicts["topic-open"], true);
      assert.equal(res.pass, true, res.reasons.join(","));
    });
  });

  describe("durable topic ledger integration (Plan 619)", () => {
    const TOPIC = "tk-ledger0123456789";
    const TOPIC_TEXT = "Projekt Meilenstein besprechen";

    function makeLedgerDm(overrides = {}) {
      const stateDir = overrides.stateDir ?? tmpDir;
      const ledger = overrides.ledger ?? createInitiativeStore({ stateDir });
      const outbox = overrides.outbox ?? createProactivityOutbox({ stateDir });
      return makeDm({
        ...overrides,
        stateDir,
        ledger,
        outbox,
        cfg: makeCfg({ minGapMinutes: 0, topicMaxAttempts: 99, topicCooldownMinutes: 0, openAttemptCooldownMinutes: 0, ...(overrides.cfg || {}) }),
      });
    }

    function topicEnvelope(id, overrides = {}) {
      return envelopeText(makeEnvelope({ id, topicKey: TOPIC, ...overrides }), TOPIC_TEXT);
    }

    it("Plan 619: same topic on different days is blocked by topic-attempts after the cap", async () => {
      const { dm, clock, ledger, stateDir } = track(makeLedgerDm({ cfg: { topicMaxAttempts: 1, topicCooldownMinutes: 0, openAttemptCooldownMinutes: 0 } }));
      const first = await dm.onMessageSending({ content: topicEnvelope("fu-20260911-ledger-a") }, { sessionKey: SK });
      assert.deepEqual(first, { content: TOPIC_TEXT }, "first gate-pass shadow delivery strips the envelope");
      clock.t += 24 * 60 * 60 * 1000; // next day: cooldown/open cleared, cap already reached
      const second = await dm.onMessageSending({ content: topicEnvelope("fu-20260911-ledger-b") }, { sessionKey: SK });
      assert.deepEqual(second, { cancel: true }, "second delivery of the same topic must be blocked");
      const entries = readLog(stateDir);
      assert.ok(entries[1].gate.reasons.includes("topic-attempts"), entries[1].gate.reasons.join(","));
      assert.equal(ledger.findByTopicKey(SCOPE, TOPIC).attempts, 1, "blocked delivery must not bump the attempt counter");
    });

    it("Plan 619: an active topic-cooldown blocks a same-topic retry", async () => {
      const { dm, clock, stateDir } = track(makeLedgerDm({ cfg: { topicMaxAttempts: 99, topicCooldownMinutes: 240, openAttemptCooldownMinutes: 0 } }));
      await dm.onMessageSending({ content: topicEnvelope("fu-20260911-cd-a") }, { sessionKey: SK });
      clock.t += 60 * 60 * 1000; // 1 h later, still inside the 240-min cooldown
      const second = await dm.onMessageSending({ content: topicEnvelope("fu-20260911-cd-b") }, { sessionKey: SK });
      assert.deepEqual(second, { cancel: true });
      const entries = readLog(stateDir);
      assert.ok(entries[1].gate.reasons.includes("topic-cooldown"), entries[1].gate.reasons.join(","));
      assert.equal(entries[1].gate.verdicts["topic-cooldown"], false);
    });

    it("Plan 619: a recent unanswered open attempt blocks retry via topic-open", async () => {
      const { dm, clock, stateDir } = track(makeLedgerDm({ cfg: { topicMaxAttempts: 99, topicCooldownMinutes: 0, openAttemptCooldownMinutes: 240 } }));
      await dm.onMessageSending({ content: topicEnvelope("fu-20260911-open-a") }, { sessionKey: SK });
      clock.t += 60 * 60 * 1000;
      const second = await dm.onMessageSending({ content: topicEnvelope("fu-20260911-open-b") }, { sessionKey: SK });
      assert.deepEqual(second, { cancel: true });
      const entries = readLog(stateDir);
      assert.ok(entries[1].gate.reasons.includes("topic-open"), entries[1].gate.reasons.join(","));
      assert.equal(entries[1].gate.verdicts["topic-open"], false);
    });

    it("Plan 619: agent-owed candidate is skipped; a user-owned one passes", async () => {
      const { dm, stateDir } = track(makeLedgerDm());
      const owned = await dm.onMessageSending({ content: topicEnvelope("fu-20260911-owed-a", { owner: "agent" }) }, { sessionKey: SK });
      assert.deepEqual(owned, { cancel: true });
      let entries = readLog(stateDir);
      assert.ok(entries[0].gate.reasons.includes("agent-owed"), entries[0].gate.reasons.join(","));
      const userOwned = await dm.onMessageSending({ content: topicEnvelope("fu-20260911-owed-b", { owner: "user" }) }, { sessionKey: SK });
      assert.deepEqual(userOwned, { content: TOPIC_TEXT });
      entries = readLog(stateDir);
      assert.equal(entries[1].gate.pass, true, entries[1].gate.reasons.join(","));
    });

    it("Plan 619: repeated gate-pass deliveries upsert ONE ledger task and increment attempts", async () => {
      const { dm, clock, ledger } = track(makeLedgerDm());
      await dm.onMessageSending({ content: topicEnvelope("fu-20260911-up-1") }, { sessionKey: SK });
      clock.t += 60 * 1000;
      await dm.onMessageSending({ content: topicEnvelope("fu-20260911-up-2") }, { sessionKey: SK });
      const st = ledger.load(SCOPE);
      const topics = (st.tasks || []).filter((t) => t.topicKey === TOPIC);
      assert.equal(topics.length, 1, "topic upserted, not duplicated");
      assert.equal(topics[0].attempts, 2, "both gate-pass attempts counted");
      assert.equal(topics[0].status, "open");
      assert.ok(topics[0].lastActAt > 0, "lastActAt stamped");
    });

    it("Plan 619: a matching inbound reply resolves the topic and clears topic-open/cooldown", async () => {
      const { dm, clock, ledger } = track(makeLedgerDm({ cfg: { topicCooldownMinutes: 240, openAttemptCooldownMinutes: 240, topicMaxAttempts: 99 } }));
      await dm.onMessageSending({ content: topicEnvelope("fu-20260911-res-1") }, { sessionKey: SK });
      assert.equal(ledger.findByTopicKey(SCOPE, TOPIC).status, "open");
      clock.t += 60 * 60 * 1000;
      // Reply shares >= 2 content tokens with the topic text (Projekt, Meilenstein).
      await dm.onMessageReceived({ content: "Ja, den Projekt Meilenstein besprechen wir morgen." }, { sessionKey: SK });
      const t = ledger.findByTopicKey(SCOPE, TOPIC);
      assert.equal(t.status, "resolved", "matching reply resolves the open topic");
      assert.equal(typeof t.resolvedAt, "number");
      const res = dm.evaluateGate(candidateFromEnvelope(makeEnvelope({ id: "fu-20260911-res-2", topicKey: TOPIC }), TOPIC_TEXT, SK, "hori-wa"));
      assert.ok(!res.reasons.includes("topic-open"), res.reasons.join(","));
      assert.ok(!res.reasons.includes("topic-cooldown"), res.reasons.join(","));
    });

    it("Plan 619: an unrelated inbound does NOT resolve the topic (token-overlap threshold)", async () => {
      const { dm, clock, ledger } = track(makeLedgerDm());
      await dm.onMessageSending({ content: topicEnvelope("fu-20260911-unrel") }, { sessionKey: SK });
      clock.t += 60 * 1000;
      await dm.onMessageReceived({ content: "Kurze Frage zum Wetter morgen." }, { sessionKey: SK });
      assert.equal(ledger.findByTopicKey(SCOPE, TOPIC).status, "open", "unrelated reply must not resolve the topic");
    });

    it("Plan 619: gate-pass records the shared outbox; gate-fail never does", async () => {
      const { dm, outbox } = track(makeLedgerDm());
      await dm.onMessageSending({ content: topicEnvelope("fu-20260911-ob-1") }, { sessionKey: SK });
      assert.equal(outbox.lastOutbound(SCOPE), T0, "outbox recorded for the scope with the send ts");
      const { dm: dm2, outbox: ob2 } = track(makeLedgerDm({ stateDir: path.join(tmpDir, "ob-gatefail"), cfg: { topicMaxAttempts: 0 } }));
      await dm2.onMessageSending({ content: topicEnvelope("fu-20260911-ob-2") }, { sessionKey: SK });
      assert.equal(ob2.lastOutbound(SCOPE), 0, "a gate-fail must never record a delivered outbox entry");
    });
  });

  describe("open-loop age gating (Plan 534 / design §3 Q3)", () => {
    // Helper: build a soft_followup candidate with a given lastUserRefMs age.
    function softWithRef(ageMs) {
      return candidateFromEnvelope(
        makeEnvelope({ id: "fu-20260904-ol-" + ageMs, lastUserRefMs: T0 - ageMs }),
        "draft",
        SK,
        "hori-wa",
      );
    }
    const DAY = 24 * 60 * 60 * 1000;
    // Full DayFit (value 1.0) so the 7-14d band passes on DayFit; the DayFit
    // bands themselves are covered separately (see DayFit gating describe).
    const fullDayFit = { value: 1.0, reason: "dayfit-full" };

    it("≤ 7 days since last user ref: soft-tier allowed (normal open loop)", () => {
      const res = evaluateDmGate(softWithRef(2 * DAY), { dcfg: BASE_DM, now: T0, dayFit: fullDayFit });
      assert.equal(res.pass, true, res.reasons.join(","));
      assert.equal(res.verdicts["open-loop-stale"], true);
      assert.equal(res.verdicts["open-loop-dayfit"], true);
    });

    it("7-14 days: soft-tier allowed ONLY at full DayFit", () => {
      // 10 days old — full DayFit passes.
      const full = evaluateDmGate(softWithRef(10 * DAY), { dcfg: BASE_DM, now: T0, dayFit: fullDayFit });
      assert.equal(full.pass, true, full.reasons.join(","));
      // 10 days old + reduced DayFit (0.5) → blocked (open-loop-dayfit).
      const reduced = evaluateDmGate(softWithRef(10 * DAY), { dcfg: BASE_DM, now: T0, dayFit: { value: 0.5, reason: "dayfit-reduced" } });
      assert.equal(reduced.pass, false);
      assert.ok(reduced.reasons.includes("open-loop-dayfit"), reduced.reasons.join(","));
    });

    it("> 14 days since last user ref: soft-tier excluded (open-loop-stale), even at full DayFit", () => {
      const res = evaluateDmGate(softWithRef(20 * DAY), { dcfg: BASE_DM, now: T0, dayFit: fullDayFit });
      assert.equal(res.pass, false);
      assert.ok(res.reasons.includes("open-loop-stale"), res.reasons.join(","));
      assert.equal(res.verdicts["open-loop-stale"], false);
    });

    it("hard reminder is exempt from open-loop gating even at > 14 days", () => {
      const hard = candidateFromEnvelope(
        makeEnvelope({ id: "fu-20260904-ol-hard", kind: "reminder", lastUserRefMs: T0 - 20 * DAY }),
        "draft",
        SK,
        "hori-wa",
      );
      const res = evaluateDmGate(hard, { dcfg: BASE_DM, now: T0, dayFit: fullDayFit });
      assert.equal(res.pass, true, res.reasons.join(","));
      assert.equal(res.verdicts["open-loop-stale"], true, "hard reminders must never be open-loop-stale");
    });

    it("no lastUserRefMs → fail-open, no open-loop restriction", () => {
      const noRef = candidateFromEnvelope(makeEnvelope({ id: "fu-20260904-ol-noref" }), "draft", SK, "hori-wa");
      // drop the ref (candidateFromEnvelope only copies it when numeric)
      delete noRef.lastUserRefMs;
      const res = evaluateDmGate(noRef, { dcfg: BASE_DM, now: T0, dayFit: fullDayFit });
      assert.equal(res.pass, true, res.reasons.join(","));
      assert.equal(res.verdicts["open-loop-stale"], true);
    });
  });

  describe("followup-gate CLI (layer 1, bin/followup-gate.mjs)", () => {
    const cfgFixture = path.join(tmpDir, "fixture-config.json");
    const stateFixture = path.join(tmpDir, "fixture-state.json");

    function runGate(args, input, env) {
      // spawn + stdin.end(): execFile's `input` option deadlocks with a
      // stdin-reading child in this Node version — verified minimal repro.
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [BIN_GATE, "check", ...args], {
          stdio: ["pipe", "pipe", "pipe"],
          env: env ? { ...process.env, ...env } : process.env,
        });
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
      fs.writeFileSync(stateFixture, JSON.stringify({ version: 3, scopes: {}, sentIds: { __legacy__: ["fu-20260824-test-001"] } }), "utf8");
      const { code, stdout } = await runGate(["--config", cfgFixture, "--state", stateFixture, "--agent", "hori-wa", "--now", String(T0)], envelopeText());
      assert.equal(code, 1);
      const out = parseOut(stdout);
      assert.equal(out.pass, false);
      assert.ok(out.reasons.includes("duplicate"), out.reasons.join(","));
    });

    it("check blocks a duplicate sentId from the v4 plugin state (agents.<agentId>.sentIds)", async () => {
      fs.writeFileSync(stateFixture, JSON.stringify({ version: 4, agents: { "hori-wa": { sentIds: ["fu-20260824-test-001"] } } }), "utf8");
      const { code, stdout } = await runGate(["--config", cfgFixture, "--state", stateFixture, "--agent", "hori-wa", "--now", String(T0)], envelopeText());
      assert.equal(code, 1);
      const out = parseOut(stdout);
      assert.equal(out.pass, false);
      assert.ok(out.reasons.includes("duplicate"), out.reasons.join(","));
      assert.equal(out.verdicts.duplicate, false);
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

    it("check blocks an agent outside the dmProactive allowlist with agent-not-scoped (exit 1)", async () => {
      fs.writeFileSync(cfgFixture, JSON.stringify({ agents: ["hori-wa"], dmProactive: { ...BASE_DM, agents: ["hori-wa"] } }), "utf8");
      const { code, stdout } = await runGate(["--config", cfgFixture, "--state", stateFixture, "--agent", "other-agent", "--now", String(T0)], envelopeText());
      assert.equal(code, 1);
      const out = parseOut(stdout);
      assert.equal(out.pass, false);
      assert.ok(out.reasons.includes("agent-not-scoped"), out.reasons.join(","));
    });

    it("check passes a scoped agent (agent-not-scoped NOT raised) and reads its own sentIds bucket", async () => {
      fs.writeFileSync(cfgFixture, JSON.stringify({ agents: ["hori-wa", "other-agent"], dmProactive: { ...BASE_DM, agents: ["hori-wa", "other-agent"] } }), "utf8");
      // hori-wa's bucket holds the id → duplicate; other-agent's does not → pass.
      fs.writeFileSync(stateFixture, JSON.stringify({ version: 3, scopes: {}, sentIds: { "hori-wa": ["fu-20260824-test-001"] } }), "utf8");
      const blocked = await runGate(["--config", cfgFixture, "--state", stateFixture, "--agent", "hori-wa", "--now", String(T0)], envelopeText());
      assert.equal(blocked.code, 1);
      const outBlocked = parseOut(blocked.stdout);
      assert.ok(outBlocked.reasons.includes("duplicate"), "agent's own bucket must block its duplicate");
      const passed = await runGate(["--config", cfgFixture, "--state", stateFixture, "--agent", "other-agent", "--now", String(T0)], envelopeText());
      assert.equal(passed.code, 0, "scoped agent with a clean bucket must pass: " + parseOut(passed.stdout).reasons.join(","));
    });

    it("check blocks on topic-cooldown from the initiative ledger", async () => {
      const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-ledger-"));
      writeInitiativeState(ledgerDir, "hori-wa", SK, [
        { id: "t-cd", topicKey: "tk-cd12345678", kind: "task", text: "cooldown topic", status: "open", attempts: 0, lastActAt: 0, createdAt: 1, dueAt: null },
      ], { "t-cd": { until: T0 + 3600000 } });
      const { code, stdout } = await runGate(
        ["--config", cfgFixture, "--state", stateFixture, "--agent", "hori-wa", "--session", SK, "--now", String(T0)],
        envelopeText(makeEnvelope({ topicKey: "tk-cd12345678" })),
        { HUMAN_ENGINE_STATE_DIR: ledgerDir },
      );
      assert.equal(code, 1);
      const out = parseOut(stdout);
      assert.ok(out.reasons.includes("topic-cooldown"), out.reasons.join(","));
      assert.equal(out.verdicts["topic-cooldown"], false);
    });

    it("check blocks on topic-attempts from the initiative ledger", async () => {
      const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-ledger-"));
      writeInitiativeState(ledgerDir, "hori-wa", SK, [
        { id: "t-at", topicKey: "tk-at12345678", kind: "task", text: "attempt cap topic", status: "open", attempts: 3, lastActAt: 0, createdAt: 1, dueAt: null },
      ]);
      const { code, stdout } = await runGate(
        ["--config", cfgFixture, "--state", stateFixture, "--agent", "hori-wa", "--session", SK, "--now", String(T0)],
        envelopeText(makeEnvelope({ topicKey: "tk-at12345678" })),
        { HUMAN_ENGINE_STATE_DIR: ledgerDir },
      );
      assert.equal(code, 1);
      const out = parseOut(stdout);
      assert.ok(out.reasons.includes("topic-attempts"), out.reasons.join(","));
      assert.equal(out.verdicts["topic-attempts"], false);
    });

    it("check without a topicKey skips the ledger checks (fail-open, backward compatible)", async () => {
      const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-ledger-"));
      writeInitiativeState(ledgerDir, "hori-wa", SK, [
        { id: "t-open", topicKey: "tk-open", kind: "task", text: "would block by topic", status: "open", attempts: 9, lastActAt: T0, createdAt: 1, dueAt: null },
      ], { "t-open": { until: T0 + 3600000 } });
      const { code, stdout } = await runGate(
        ["--config", cfgFixture, "--state", stateFixture, "--agent", "hori-wa", "--session", SK, "--now", String(T0)],
        envelopeText(),
        { HUMAN_ENGINE_STATE_DIR: ledgerDir },
      );
      const out = parseOut(stdout);
      assert.equal(code, 0, out.reasons.join(","));
      assert.equal(out.pass, true);
      assert.equal(out.verdicts["topic-cooldown"], undefined);
      assert.equal(out.verdicts["topic-attempts"], undefined);
    });
  });

  describe("initiative-ledger CLI (Plan 618, bin/initiative-ledger.mjs)", () => {
    const BIN_LEDGER = path.join(PLUGIN_ROOT, "bin", "initiative-ledger.mjs");

    function runLedger(args, input) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [BIN_LEDGER, ...args], { stdio: ["pipe", "pipe", "pipe"] });
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

    it("initiative-ledger CLI list returns open tasks as JSON lines with cooldownUntil and creates no file", async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-cli-"));
      writeInitiativeState(stateDir, "hori-wa", SK, [
        { id: "t-1", topicKey: "tk-1", kind: "task", text: "open one", status: "open", attempts: 1, lastActAt: 5, createdAt: 7, dueAt: null },
        { id: "t-2", topicKey: "tk-2", kind: "task", text: "done one", status: "done", attempts: 0, lastActAt: 0, createdAt: 8, dueAt: null },
      ], { "t-1": { until: T0 + 60000 } });

      const before = fs.readdirSync(stateDir).sort();
      const { code, stdout } = await runLedger(["list", "--agent", "hori-wa", "--state-dir", stateDir]);
      assert.equal(code, 0);
      const rows = stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.equal(rows.length, 1, "only the open task listed");
      const row = rows[0];
      assert.equal(row.scope, SCOPE);
      assert.equal(row.agentId, "hori-wa");
      assert.equal(row.topicKey, "tk-1");
      assert.equal(row.status, "open");
      assert.equal(row.attempts, 1);
      assert.equal(row.lastActAt, 5);
      assert.equal(row.cooldownUntil, T0 + 60000);
      assert.equal(row.createdAt, 7);
      assert.deepEqual(fs.readdirSync(stateDir).sort(), before, "list must not create any file");
    });

    it("initiative-ledger CLI list on an unknown agent exits 0 with no tasks and creates no file", async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-cli-"));
      const before = fs.readdirSync(stateDir).sort();
      const { code, stdout } = await runLedger(["list", "--agent", "nobody", "--state-dir", stateDir]);
      assert.equal(code, 0);
      assert.equal(stdout.trim(), "[]");
      assert.deepEqual(fs.readdirSync(stateDir).sort(), before, "no file created for an unknown agent");
    });

    it("initiative-ledger CLI get returns the matching task by topicKey or {found:false}", async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-cli-"));
      writeInitiativeState(stateDir, "hori-wa", SK, [
        { id: "t-get", topicKey: "tk-get", kind: "task", text: "get me", status: "open", attempts: 2, lastActAt: 0, createdAt: 9, dueAt: null },
      ], { "t-get": { until: T0 + 120000 } });

      const hit = await runLedger(["get", "--topic-key", "tk-get", "--agent", "hori-wa", "--state-dir", stateDir]);
      assert.equal(hit.code, 0);
      const found = JSON.parse(hit.stdout.trim());
      assert.equal(found.found, true);
      assert.equal(found.topicKey, "tk-get");
      assert.equal(found.scope, SCOPE);
      assert.equal(found.cooldownUntil, T0 + 120000);

      const miss = await runLedger(["get", "--topic-key", "tk-nope", "--agent", "hori-wa", "--state-dir", stateDir]);
      assert.equal(miss.code, 0);
      assert.deepEqual(JSON.parse(miss.stdout.trim()), { found: false, topicKey: "tk-nope" });
    });
  });

  describe("production message_sending shape (Plan 536 — incident 2026-09-04)", () => {
    // OpenClaw 2026.8.1 PluginHookMessageContext = {channelId, accountId?,
    // conversationId?} — NO sessionKey (types.d.ts:2094). The DM scope is
    // derived from the event target. Fake contact id 999999999 (public repo).
    const PROD_TO = "999999999";
    const PROD_SK = "agent:hori-wa:telegram:direct:" + PROD_TO; // derived, matches cfg.agents single fallback
    const PROD_SCOPE = "hori-wa::" + PROD_SK;

    function prodEvent(content, to = PROD_TO, overrides = {}) {
      return { to, content, metadata: { channel: "telegram", accountId: "bot-1" }, ...overrides };
    }

    it("message-tool outbound shape (ctx {channelId, accountId}, no sessionKey): envelope send is stripped and logged, scope derived from event", async () => {
      const { dm, stateDir } = track(makeDm());
      const result = await dm.onMessageSending(prodEvent(envelopeText()), { channelId: "telegram", accountId: "bot-1" });
      assert.deepEqual(result, { content: "Kommt ihr heute noch am Projekt voran?" }, "shadow gate-pass delivers the stripped draft");
      const entries = readLog(stateDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].candidateId, "fu-20260824-test-001");
      assert.equal(entries[0].scope, PROD_SCOPE, "DM scope must be derived from event target");
      assert.equal(entries[0].mode, "shadow");
    });

    it("session-delivery shape (ctx {channelId, conversationId}, no sessionKey): envelope send is stripped and logged", async () => {
      const { dm, stateDir } = track(makeDm());
      const result = await dm.onMessageSending(prodEvent(envelopeText()), { channelId: "telegram", conversationId: "c-1" });
      assert.deepEqual(result, { content: "Kommt ihr heute noch am Projekt voran?" });
      const entries = readLog(stateDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].scope, PROD_SCOPE);
    });

    it("INCIDENT REGRESSION: 3 identical envelope sends (fresh state) → 1 stripped delivery, 2 cancels, 3 logs, sentIds set", async () => {
      const { dm, stateDir } = track(makeDm({ cfg: makeCfg({ minGapMinutes: 180 }) }));
      const event = prodEvent(envelopeText());
      const ctx = { channelId: "telegram", accountId: "bot-1" };
      const r1 = await dm.onMessageSending(event, ctx);
      assert.deepEqual(r1, { content: "Kommt ihr heute noch am Projekt voran?" }, "first send must deliver with the envelope stripped");
      assert.ok(!r1.content.includes("[[fu:"), "delivered content must NOT contain the envelope metadata");
      const r2 = await dm.onMessageSending(event, ctx);
      assert.deepEqual(r2, { cancel: true }, "second identical send must cancel (duplicate + min-gap)");
      const r3 = await dm.onMessageSending(event, ctx);
      assert.deepEqual(r3, { cancel: true }, "third identical send must cancel");
      const entries = readLog(stateDir);
      assert.equal(entries.length, 3, "all three candidates must be logged");
      assert.equal(entries[0].gatePassed, true, "only the first send passes the gate");
      assert.equal(entries[1].gatePassed, false);
      assert.equal(entries[2].gatePassed, false);
      assert.ok(entries[1].gate.reasons.includes("duplicate"), entries[1].gate.reasons.join(","));
      assert.ok(entries[2].gate.reasons.includes("duplicate"), entries[2].gate.reasons.join(","));
      // sentIds must be set (the delivered id recorded)
      dm.stop();
      const state = JSON.parse(fs.readFileSync(path.join(stateDir, "dm-proactive-state.json"), "utf8"));
      assert.ok(state.agents["hori-wa"].sentIds.includes("fu-20260824-test-001"), "delivered id must be recorded in the agent sentIds bucket");
    });

    it("shadow gate-fail (quiet hours) in production shape → cancel + log, no delivery, no sentId", async () => {
      const now0 = new Date(2026, 7, 24, 23, 30).getTime(); // quiet hours
      const { dm, stateDir, log } = track(makeDm({ now0 }));
      const result = await dm.onMessageSending(prodEvent(envelopeText(makeEnvelope({ id: "fu-20260904-prod-quiet" }))), { channelId: "telegram", accountId: "bot-1" });
      assert.deepEqual(result, { cancel: true }, "shadow must suppress gate-fail (AMENDMENT 1)");
      const entries = readLog(stateDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].gatePassed, false);
      assert.ok(entries[0].gate.reasons.includes("quiet-hours"), entries[0].gate.reasons.join(","));
      assert.ok(log._infos.some((m) => m.includes("reason=failed:quiet-hours")), log._infos.join("\n"));
    });

    it("normal text send without envelope in production shape → untouched (fail-open), no log", async () => {
      const { dm, stateDir } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }) }));
      const result = await dm.onMessageSending(prodEvent("Hey Nico, hier die Antwort."), { channelId: "telegram", accountId: "bot-1" });
      assert.equal(result, undefined, "normal agent text must never be touched");
      assert.equal(readLog(stateDir).length, 0);
    });

    it("unknown target with a single configured agent derives via fallback (no warn)", async () => {
      const { dm, stateDir, log } = track(makeDm());
      const result = await dm.onMessageSending(prodEvent(envelopeText(), "5551234"), { channelId: "telegram", accountId: "bot-1" });
      assert.deepEqual(result, { content: "Kommt ihr heute noch am Projekt voran?" }, "single-agent fallback must derive the DM scope");
      assert.equal(log._warns.length, 0, "no warn expected for the single-agent fallback");
      const entries = readLog(stateDir);
      assert.equal(entries[0].scope, "hori-wa::agent:hori-wa:telegram:direct:5551234");
    });

    it("group target (telegram negative chat id) → return, never touched", async () => {
      const { dm, stateDir } = track(makeDm());
      const result = await dm.onMessageSending(prodEvent(envelopeText(), "-1001234567890"), { channelId: "telegram", accountId: "bot-1" });
      assert.equal(result, undefined, "group target must not be derived or touched");
      assert.equal(readLog(stateDir).length, 0);
    });

    it("ambiguous target (no scope match, multiple agents) → warn + fail-open, no touch", async () => {
      const multiCfg = { ...makeCfg(), agents: ["hori-wa", "hori-wa-public-group-kletter"] };
      const { dm, stateDir, log } = track(makeDm({ cfg: multiCfg }));
      const result = await dm.onMessageSending(prodEvent(envelopeText(), "5551234"), { channelId: "telegram", accountId: "bot-1" });
      assert.equal(result, undefined, "ambiguous target must fail open");
      assert.equal(readLog(stateDir).length, 0);
      assert.ok(log._warns.some((m) => m.includes("cannot derive DM scope")), log._warns.join("\n"));
    });

    it("known scope suffix match (multi-agent config) derives the exact agentId from state — no fallback ambiguity", async () => {
      // Seed a real scope key for hori-wa against this target, then use a
      // multi-agent config so the single-agent fallback is NOT available —
      // the derivation must still succeed via the state scope-suffix match.
      const multiCfg = { ...makeCfg(), agents: ["hori-wa", "hori-wa-public-group-kletter"] };
      writeState(tmpDir, { scopes: { [PROD_SCOPE]: { day: localDayKey(T0), count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: 0, lastReplyAtMs: 0 } }, sentIds: [] });
      const { dm, stateDir, log } = track(makeDm({ cfg: multiCfg }));
      const result = await dm.onMessageSending(prodEvent(envelopeText(makeEnvelope({ id: "fu-20260904-prod-known" }))), { channelId: "telegram", accountId: "bot-1" });
      assert.deepEqual(result, { content: "Kommt ihr heute noch am Projekt voran?" }, "known scope must derive even with multiple agents");
      const entries = readLog(stateDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].scope, PROD_SCOPE, "scope must match the seeded known scope");
      assert.equal(log._warns.length, 0, "no warn for a known-scope match");
    });

    it("INCIDENT 2 REGRESSION: to=telegram:968721694 (channel prefix) + 2 agents + kind care → normalized care_check_in, care gates run, stripped delivery, logged, sentIds set, NO raw output", async () => {
      // Real production shape (incident 2026-09-04 ~12:46 UTC): OpenClaw
      // delivers `to` WITH a channel prefix (`telegram:968721694`), the ctx has
      // NO sessionKey, and cfg.agents names TWO agents. hori-wa owns the DM
      // scope, kletter does not → unambiguous scope resolution across agents.
      // The cron wrote `kind:"care"` (invalid schema) which must be normalized
      // to `care_check_in` so the care gates run and delivery is STRIPPED.
      const UID = "968721694";
      const incidentScope = "hori-wa::agent:hori-wa:telegram:direct:" + UID;
      const multiCfg = { ...makeCfg(), agents: ["hori-wa-public-group-kletter", "hori-wa"] };
      writeState(tmpDir, { scopes: { [incidentScope]: { day: localDayKey(T0), count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: 0, lastReplyAtMs: 0 } }, sentIds: [] });
      const { dm, stateDir, log } = track(makeDm({ cfg: multiCfg }));
      const envelope = makeEnvelope({ id: "fu-20260904-momentum-tagebuch", kind: "care", sensitivity: "care", confidence: 0.9, lastUserRefMs: T0 - 60 * 60 * 1000 });
      const event = { to: "telegram:" + UID, content: envelopeText(envelope), metadata: { channel: "telegram", accountId: "bot-1" } };
      const result = await dm.onMessageSending(event, { channelId: "telegram", accountId: "bot-1" });
      assert.ok(result && result.content, "delivery must not be suppressed for the valid momentum case");
      assert.equal(result.content, "Kommt ihr heute noch am Projekt voran?", "delivery must be the stripped draft");
      assert.ok(!result.content.includes("[[fu:"), "delivered content must NOT contain the RAW envelope metadata");
      assert.ok(!result.content.includes("968721694"), "delivered content must NOT leak the target uid");
      const entries = readLog(stateDir);
      assert.equal(entries.length, 1, "one candidate logged");
      assert.equal(entries[0].candidateId, "fu-20260904-momentum-tagebuch");
      assert.equal(entries[0].kind, "care_check_in", "kind care must be normalized to care_check_in");
      assert.equal(entries[0].candidate.kind, "care_check_in");
      assert.equal(entries[0].scope, incidentScope, "scope must resolve to hori-wa's DM lane");
      assert.equal(entries[0].gatePassed, true, "care gates must have run and passed for this candidate");
      assert.equal(log._warns.length, 0, "no cannot-derive warn — scope resolved across agents");
      dm.stop();
      const state = JSON.parse(fs.readFileSync(path.join(stateDir, "dm-proactive-state.json"), "utf8"));
      assert.ok(state.agents["hori-wa"].sentIds.includes("fu-20260904-momentum-tagebuch"), "delivered id must be recorded in the agent sentIds bucket");
    });

    it("multi-agent: DM scope owner unambiguous across agents resolves even when single-agent fallback is absent", async () => {
      // hori-wa owns the DM scope, kletter owns only a group scope — the target
      // is resolvable to hori-wa despite cfg.agents.length === 2.
      const UID = "968721694";
      const incidentScope = "hori-wa::agent:hori-wa:telegram:direct:" + UID;
      const kletterGroupScope = "hori-wa-public-group-kletter::agent:hori-wa-public-group-kletter:telegram:direct:555000";
      const multiCfg = { ...makeCfg(), agents: ["hori-wa-public-group-kletter", "hori-wa"] };
      writeState(tmpDir, { scopes: { [incidentScope]: { day: localDayKey(T0), count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: 0, lastReplyAtMs: 0 }, [kletterGroupScope]: { day: localDayKey(T0), count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: 0, lastReplyAtMs: 0 } }, sentIds: [] });
      const { dm, stateDir, log } = track(makeDm({ cfg: multiCfg }));
      const event = { to: "telegram:" + UID, content: envelopeText(makeEnvelope({ id: "fu-20260904-uniq" })), metadata: { channel: "telegram" } };
      const result = await dm.onMessageSending(event, { channelId: "telegram" });
      assert.deepEqual(result, { content: "Kommt ihr heute noch am Projekt voran?" }, "unambiguous DM owner must resolve");
      assert.equal(log._warns.length, 0, "no warn for unambiguous owner");
    });

    it("multi-agent: target owned by TWO agents → warn + fail-open (never guess)", async () => {
      const UID = "968721694";
      const s1 = "hori-wa::agent:hori-wa:telegram:direct:" + UID;
      const s2 = "hori-wa-public-group-kletter::agent:hori-wa-public-group-kletter:telegram:direct:" + UID;
      const multiCfg = { ...makeCfg(), agents: ["hori-wa-public-group-kletter", "hori-wa"] };
      writeState(tmpDir, { scopes: { [s1]: { day: localDayKey(T0), count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: 0, lastReplyAtMs: 0 }, [s2]: { day: localDayKey(T0), count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: 0, lastReplyAtMs: 0 } }, sentIds: [] });
      const { dm, stateDir, log } = track(makeDm({ cfg: multiCfg }));
      const event = { to: "telegram:" + UID, content: envelopeText(makeEnvelope({ id: "fu-20260904-ambig" })), metadata: { channel: "telegram" } };
      const result = await dm.onMessageSending(event, { channelId: "telegram" });
      assert.equal(result, undefined, "ambiguous multi-owner target must fail open (not delivered raw)");
      assert.equal(readLog(stateDir).length, 0);
      assert.ok(log._warns.some((m) => m.includes("cannot derive DM scope")), log._warns.join("\n"));
    });

    it("bare uid WITHOUT channel prefix still resolves (backward compat with Plan 536)", async () => {
      const { dm, stateDir } = track(makeDm());
      const event = { to: "5551234", content: envelopeText(makeEnvelope({ id: "fu-20260904-bare" })), metadata: { channel: "telegram" } };
      const result = await dm.onMessageSending(event, { channelId: "telegram" });
      assert.deepEqual(result, { content: "Kommt ihr heute noch am Projekt voran?" }, "bare uid must still derive via single-agent fallback");
      const entries = readLog(stateDir);
      assert.equal(entries[0].scope, "hori-wa::agent:hori-wa:telegram:direct:5551234");
    });

    it("group targets with a channel prefix (telegram:-100…) are still rejected, not derived as DM", async () => {
      const { dm, stateDir, log } = track(makeDm());
      const event = { to: "telegram:-1001234567890", content: envelopeText(makeEnvelope({ id: "fu-20260904-group" })), metadata: { channel: "telegram" } };
      const result = await dm.onMessageSending(event, { channelId: "telegram" });
      assert.equal(result, undefined, "prefixed negative chat id must never be derived as a DM");
      assert.equal(readLog(stateDir).length, 0);
    });

    it(":topic: suffix target is rejected as a DM (group sub-thread)", async () => {
      const { dm, stateDir, log } = track(makeDm());
      const event = { to: "telegram:12345:topic:678", content: envelopeText(makeEnvelope({ id: "fu-20260904-topic" })), metadata: { channel: "telegram" } };
      const result = await dm.onMessageSending(event, { channelId: "telegram" });
      assert.equal(result, undefined, ":topic: target must never be derived as a DM");
      assert.equal(readLog(stateDir).length, 0);
    });
  });
});