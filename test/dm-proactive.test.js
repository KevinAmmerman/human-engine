import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDmProactive } from "../lib/dm-proactive.js";
import { setRng, resetRng } from "../lib/proactive.js";
import * as state from "../lib/state.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-proactive-test-"));
const SK = "agent:hori-wa:telegram:direct:111111111";
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
  const commitmentsPath = overrides.commitmentsPath ?? path.join(tmpDir, "commitments.json");
  const dm = createDmProactive({
    cfg,
    llm: runtime.llm,
    socialMemory,
    runtime,
    stateDir,
    log,
    now: () => clock.t,
    commitmentsPath,
  });
  return { dm, cfg, clock, runtime, socialMemory, log, stateDir, commitmentsPath };
}

function readLog(stateDir) {
  try {
    return fs.readFileSync(path.join(stateDir, "dm-proactive.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function writeStore(file, commitments) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, commitments }), "utf8");
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

    it("message_sending reconciles a pending commitment from the store and logs without blocking", async () => {
      const { dm, stateDir, commitmentsPath } = track(makeDm());
      writeStore(commitmentsPath, [{
        id: "cm_due_001", agentId: "hori-wa", sessionKey: SK, kind: "open_loop",
        sensitivity: "personal", confidence: 0.8, source: "agent_promise", status: "pending",
        suggestedText: "Kommt ihr heute noch am Projekt voran?", updatedAtMs: T0,
      }]);
      const result = await dm.onMessageSending({ content: "Kommt ihr heute noch am Projekt voran?" }, { sessionKey: SK });
      assert.equal(result, undefined, "shadow must pass through without rewriting");
      const entries = readLog(stateDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].candidate.id, "cm_due_001");
      assert.equal(entries[0].gate.pass, true);
    });

    it("non-commitment outbound text produces no log entry", async () => {
      const { dm, stateDir } = track(makeDm());
      writeStore(path.join(tmpDir, "commitments.json"), []);
      await dm.onMessageSending({ content: "Hey Nico, hier ist die Antwort." }, { sessionKey: SK });
      assert.equal(readLog(stateDir).length, 0);
    });

    it("unchanged commitments file reconciles across repeated outbound sends (mtime cache)", async () => {
      const { dm, stateDir, commitmentsPath } = track(makeDm());
      writeStore(commitmentsPath, [{
        id: "cm_due_001", agentId: "hori-wa", sessionKey: SK, kind: "open_loop",
        sensitivity: "personal", confidence: 0.8, source: "agent_promise", status: "pending",
        suggestedText: "Kommt ihr heute noch am Projekt voran?", updatedAtMs: T0,
      }]);
      await dm.onMessageSending({ content: "Kommt ihr heute noch am Projekt voran?" }, { sessionKey: SK });
      await dm.onMessageSending({ content: "Kommt ihr heute noch am Projekt voran?" }, { sessionKey: SK });
      const entries = readLog(stateDir);
      assert.equal(entries.length, 2, "both sends must reconcile from the cached store");
      assert.equal(entries[0].candidate.id, "cm_due_001");
      assert.equal(entries[1].candidate.id, "cm_due_001");
    });

    it("group outbound text is ignored (DM scope only)", async () => {
      const { dm, stateDir } = track(makeDm());
      const groupSk = "agent:hori-wa-public-group-kletter:whatsapp:group:123@g.us";
      await dm.onMessageSending({ content: "Kommt ihr heute noch am Projekt voran?" }, { sessionKey: groupSk });
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

    it("shadow flag in config keeps dmProactive from ever sending even on a matched send event", async () => {
      const { dm, stateDir, commitmentsPath, runtime } = track(makeDm());
      writeStore(commitmentsPath, [{
        id: "cm_due_001", agentId: "hori-wa", sessionKey: SK, kind: "open_loop",
        sensitivity: "personal", confidence: 0.8, source: "agent_promise", status: "pending",
        suggestedText: "Kommt ihr heute noch am Projekt voran?", updatedAtMs: T0,
      }]);
      await dm.onMessageSending({ content: "Kommt ihr heute noch am Projekt voran?" }, { sessionKey: SK });
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
      assert.equal(readLog(stateDir)[0].sent, false);
    });
  });

  describe("activation safety: cancel-on-live-send", () => {
    it("shadow=true passes through: never cancels, still logs", async () => {
      const { dm, stateDir, commitmentsPath, runtime } = track(makeDm());
      writeStore(commitmentsPath, [{
        id: "cm_as_shadow", agentId: "hori-wa", sessionKey: SK, kind: "open_loop",
        sensitivity: "personal", confidence: 0.8, source: "agent_promise", status: "pending",
        suggestedText: "Kommt ihr heute noch am Projekt voran?", updatedAtMs: T0,
      }]);
      const result = await dm.onMessageSending({ content: "Kommt ihr heute noch am Projekt voran?" }, { sessionKey: SK });
      assert.equal(result, undefined, "shadow must never cancel");
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
      const entries = readLog(stateDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].candidate.id, "cm_as_shadow");
    });

    it("live + gate pass + runtime cancels original, sends rendered draft once with idempotencyKey", async () => {
      const runtime = makeRuntime({ llmText: "Rendertext live" });
      const { dm, commitmentsPath, stateDir } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }), runtime }));
      writeStore(commitmentsPath, [{
        id: "cm_as_live", agentId: "hori-wa", sessionKey: SK, kind: "open_loop",
        sensitivity: "personal", confidence: 0.8, source: "agent_promise", status: "pending",
        suggestedText: "Kommt ihr heute noch am Projekt voran?", updatedAtMs: T0,
      }]);
      const result = await dm.onMessageSending({ content: "Kommt ihr heute noch am Projekt voran?" }, { sessionKey: SK });
      assert.deepEqual(result, { cancel: true });
      assert.equal(runtime.subagent.run.mock.callCount(), 1);
      const call = runtime.subagent.run.mock.calls[0].arguments[0];
      assert.equal(call.deliver, true);
      assert.equal(call.message, "Rendertext live");
      assert.equal(call.idempotencyKey, "human-engine-dm-proactive-cm_as_live");
      const entries = readLog(stateDir);
      assert.equal(entries[0].sent, true);
      assert.equal(entries[0].candidate.id, "cm_as_live");
    });

    it("live + gate fail (quiet hours): no cancel, subagent.run not called", async () => {
      const runtime = makeRuntime({ llmText: "Rendertext" });
      const { dm, commitmentsPath, stateDir } = track(makeDm({
        cfg: makeCfg({ shadow: false, minGapMinutes: 0 }),
        runtime,
        now0: new Date(2026, 7, 24, 23, 30).getTime(),
      }));
      writeStore(commitmentsPath, [{
        id: "cm_as_quiet", agentId: "hori-wa", sessionKey: SK, kind: "open_loop",
        sensitivity: "personal", confidence: 0.8, source: "agent_promise", status: "pending",
        suggestedText: "Kommt ihr heute noch am Projekt voran?", updatedAtMs: T0,
      }]);
      const result = await dm.onMessageSending({ content: "Kommt ihr heute noch am Projekt voran?" }, { sessionKey: SK });
      assert.equal(result, undefined, "gate-fail live path must NOT cancel (dist fallback delivers)");
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
      const entries = readLog(stateDir);
      assert.equal(entries[0].gate.pass, false);
      assert.ok(entries[0].gate.reasons.includes("quiet-hours"), entries[0].gate.reasons.join(","));
    });

    it("live + no candidate match (store miss): no cancel, dist fallback delivers", async () => {
      const runtime = makeRuntime();
      const { dm, commitmentsPath } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }), runtime }));
      writeStore(commitmentsPath, []);
      const result = await dm.onMessageSending({ content: "Freeform text, not a commitment" }, { sessionKey: SK });
      assert.equal(result, undefined, "non-match must pass through");
      assert.equal(runtime.subagent.run.mock.callCount(), 0);
    });

    it("live + subagent.run throws: still cancels, WARN logged with candidate id, budget NOT bumped", async () => {
      const runtime = makeRuntime({ llmText: "Rendertext" });
      runtime.subagent.run = mock.fn(async () => { throw new Error("boom"); });
      const { dm, commitmentsPath, clock, stateDir, log } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }), runtime }));
      writeStore(commitmentsPath, [{
        id: "cm_as_throw", agentId: "hori-wa", sessionKey: SK, kind: "open_loop",
        sensitivity: "personal", confidence: 0.8, source: "agent_promise", status: "pending",
        suggestedText: "Kommt ihr heute noch am Projekt voran?", updatedAtMs: T0,
      }]);
      const result = await dm.onMessageSending({ content: "Kommt ihr heute noch am Projekt voran?" }, { sessionKey: SK });
      assert.deepEqual(result, { cancel: true }, "cancel still returned after failed send");
      assert.ok(log._warns.some((m) => m.includes("live send failed after cancel") && m.includes("cm_as_throw")), log._warns.join("\n"));
      clock.t += 24 * 60 * 60 * 1000;
      const next = dm.evaluateGate(makeCandidate({ id: "cm_as_throw_2" }));
      assert.equal(next.pass, true, "budget must NOT be bumped after failed send");
      const entries = readLog(stateDir);
      assert.equal(entries[0].sent, false);
    });

    it("duplicate delivery guard: same content/store twice → same idempotencyKey twice", async () => {
      const runtime = makeRuntime({ llmText: "Rendertext" });
      const { dm, commitmentsPath } = track(makeDm({ cfg: makeCfg({ shadow: false, minGapMinutes: 0 }), runtime }));
      writeStore(commitmentsPath, [{
        id: "cm_as_dup", agentId: "hori-wa", sessionKey: SK, kind: "open_loop",
        sensitivity: "personal", confidence: 0.8, source: "agent_promise", status: "pending",
        suggestedText: "Kommt ihr heute noch am Projekt voran?", updatedAtMs: T0,
      }]);
      await dm.onMessageSending({ content: "Kommt ihr heute noch am Projekt voran?" }, { sessionKey: SK });
      await dm.onMessageSending({ content: "Kommt ihr heute noch am Projekt voran?" }, { sessionKey: SK });
      assert.equal(runtime.subagent.run.mock.callCount(), 2);
      const k0 = runtime.subagent.run.mock.calls[0].arguments[0].idempotencyKey;
      const k1 = runtime.subagent.run.mock.calls[1].arguments[0].idempotencyKey;
      assert.equal(k0, k1);
      assert.equal(k0, "human-engine-dm-proactive-cm_as_dup");
    });
  });

  describe("e2e dry run with a pending commitment fixture", () => {
    it("ugly raw template from the store renders (no-llm fallback) into the shadow log with candidate metadata", async () => {
      const { dm, stateDir, commitmentsPath } = track(makeDm());
      writeStore(commitmentsPath, [{
        id: "cm_voyage_dup_01", agentId: "hori-wa", sessionKey: SK, kind: "care_check_in",
        sensitivity: "care", confidence: 0.88, source: "agent_promise", status: "pending",
        suggestedText: "Kurzer Check-in: Alles okay? Du wolltest ja noch was nachreichen.",
        updatedAtMs: T0,
      }]);
      await dm.onMessageSending({ content: "Kurzer Check-in: Alles okay? Du wolltest ja noch was nachreichen." }, { sessionKey: SK });
      const entries = readLog(stateDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].candidate.id, "cm_voyage_dup_01");
      assert.equal(entries[0].candidate.kind, "care_check_in");
      assert.equal(entries[0].suggestedText.includes("nachreichen"), true);
      assert.equal(typeof entries[0].gate.pass, "boolean");
      assert.equal(typeof entries[0].render.draft, "string");
      assert.equal(entries[0].sent, false, "shadow dry run must never send");
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
  });
});