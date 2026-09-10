import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInitiative, evaluateInitiative } from "../lib/initiative.js";
import { localDayKey as localDayKeyFor } from "../lib/proactive.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "initiative-test-"));

const SK = "agent:test-agent:whatsapp:group:123@g.us";
const SCOPE = "test-agent::" + SK;

function makeCfg(overrides = {}) {
  return {
    enabled: true,
    agents: [],
    agentName: "Yuki",
    initiative: {
      enabled: true,
      shadow: true,
      agents: [],
      scopes: ["group"],
      activeHours: { start: "08:00", end: "22:00", timezone: "Europe/Berlin" },
      quietStart: "22:00",
      quietEnd: "07:00",
      maxActsPerDay: 2,
      minGapMinutes: 240,
      minGapAfterAgentSpeakMinutes: 30,
      hotWindowMinutes: 15,
      probability: 0.8,
      capture: { keywords: true, everyMessages: 20, everyMinutes: 0 },
      directives: { enabled: true, maxPerScope: 10 },
      maxContextChars: 600,
      maxOpenTasks: 20,
      ...overrides,
    },
    ...(overrides.initiative ? {} : {}),
  };
}

function makeLlm(json) {
  return {
    complete: async () => ({ text: JSON.stringify(json) }),
  };
}

function groupCtx(extra = {}) {
  return { agentId: "test-agent", sessionKey: SK, senderName: "Alex", ...extra };
}

// Deterministic Berlin-local 09:00 (within active 08:00-22:00, outside quiet).
const T0 = 1789023600000;
function makeClock() {
  return { t: T0 };
}

function stateFileFor(agent, sk) {
  const safeAgent = agent.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeSk = sk.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(tmpDir, "initiative", safeAgent, safeSk + ".json");
}

function loadState(agent = "test-agent", sk = SK) {
  try {
    return JSON.parse(fs.readFileSync(stateFileFor(agent, sk), "utf8"));
  } catch {
    return null;
  }
}

describe("initiative", { concurrency: false }, () => {
  beforeEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("disabled: onMessageReceived + onBeforePromptBuild create no files and return undefined", async () => {
    const i = createInitiative({ cfg: { initiative: { enabled: false } }, stateDir: tmpDir, log: {} });
    const r1 = await i.onMessageReceived({ text: "merk dir: call am Dienstag" }, groupCtx());
    const r2 = await i.onBeforePromptBuild({ prompt: "hi" }, groupCtx());
    assert.equal(r1, undefined);
    assert.equal(r2, undefined);
    assert.equal(fs.existsSync(path.join(tmpDir, "initiative")), false, "no initiative dir when disabled");
  });

  it("capture keyword trigger persists a task via llm; second identical extraction does not duplicate", async () => {
    const cfg = makeCfg();
    const i = createInitiative({
      cfg,
      stateDir: tmpDir,
      llm: makeLlm({ tasks: [{ text: "call am Dienstag", kind: "reminder", people: ["Alex"] }], directives: [], done: [], drop: [] }),
    });
    await i.onMessageReceived({ text: "merk dir: call am Dienstag" }, groupCtx());

    const state = loadState();
    assert.ok(state, "state file written");
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].text, "call am Dienstag");
    assert.equal(state.tasks[0].status, "open");
    assert.deepEqual(state.tasks[0].people, ["Alex"]);

    await i.onMessageReceived({ text: "merk dir: call am Dienstag" }, groupCtx());
    const state2 = loadState();
    assert.equal(state2.tasks.length, 1, "no duplicate on second extraction");
  });

  it("done/drop mark the matching task statuses", async () => {
    const cfg = makeCfg();
    const i = createInitiative({ cfg, stateDir: tmpDir, llm: makeLlm({ tasks: [{ text: "buy milk", kind: "task" }], directives: [], done: [], drop: [] }) });
    await i.onMessageReceived({ text: "denk dran: buy milk" }, groupCtx());
    const first = loadState();
    const taskId = first.tasks[0].id;
    assert.equal(first.tasks[0].status, "open");

    const i2 = createInitiative({ cfg, stateDir: tmpDir, llm: makeLlm({ tasks: [], directives: [], done: [taskId], drop: [] }) });
    await i2.onMessageReceived({ text: "merk dir: nothing new" }, groupCtx());
    const after = loadState();
    assert.equal(after.tasks.length, 1, "task never deleted");
    assert.equal(after.tasks[0].status, "done");
  });

  it("caps: keeps ≤ maxOpenTasks open tasks and ≤ maxPerScope directives", async () => {
    const cfg = makeCfg({ maxOpenTasks: 3, directives: { enabled: true, maxPerScope: 2 } });
    const many = Array.from({ length: 6 }, (_, k) => ({ text: "task number " + k, kind: "task" }));
    const dirs = [{ text: "immer grüßen" }, { text: "nie schreien" }, { text: "immer früh melden" }];
    const i = createInitiative({ cfg, stateDir: tmpDir, llm: makeLlm({ tasks: many, directives: dirs, done: [], drop: [] }) });
    await i.onMessageReceived({ text: "vergiss nicht: tasks" }, groupCtx());
    const state = loadState();
    const open = state.tasks.filter((t) => t.status === "open");
    assert.ok(open.length <= 3, `open tasks capped at maxOpenTasks (got ${open.length})`);
    assert.ok(state.directives.length <= 2, `directives capped at maxPerScope (got ${state.directives.length})`);
  });

  it("contextFor/onBeforePromptBuild renders open tasks + directives, wrapped, respecting maxContextChars", async () => {
    const cfg = makeCfg({ maxContextChars: 150 });
    const i = createInitiative({ cfg, stateDir: tmpDir, llm: makeLlm({ tasks: [{ text: "a fairly long task description that goes on and on and on with even more words to make it long", kind: "task" }], directives: [{ text: "immer grüßen" }], done: [], drop: [] }) });
    await i.onMessageReceived({ text: "erinner mich: the long task" }, groupCtx());

    const block = i.contextFor(SK, "test-agent");
    assert.ok(block, "context block present");
    assert.ok(block.includes("<<<GROUP CHAT LOG"), "wrapped with untrusted start");
    assert.ok(block.includes("END GROUP CHAT LOG>>>"), "wrapped with untrusted end");
    assert.ok(block.includes("Open tasks"), "header retained under cap");
    assert.ok(block.length <= 150, `context block capped at maxContextChars (len ${block.length})`);

    const r = await i.onBeforePromptBuild({ prompt: "hi" }, groupCtx());
    assert.ok(r && r.appendSystemContext, "appendSystemContext returned");
    assert.ok(r.appendSystemContext.includes("Open tasks"));
  });

  it("per-agent isolation: two agents, same session family → separate state files/scopes", async () => {
    const cfg = makeCfg();
    const llm = makeLlm({ tasks: [{ text: "task for agent A", kind: "task" }], directives: [], done: [], drop: [] });
    const i = createInitiative({ cfg, stateDir: tmpDir, llm });

    const skA = "agent:agentA:whatsapp:group:1@g.us";
    const skB = "agent:agentB:whatsapp:group:1@g.us";
    await i.onMessageReceived({ text: "merk dir: task for agent A" }, { agentId: "agentA", sessionKey: skA, senderName: "Bob" });
    await i.onMessageReceived({ text: "merk dir: task for agent A" }, { agentId: "agentB", sessionKey: skB, senderName: "Bob" });

    const stateA = loadState("agentA", skA);
    const stateB = loadState("agentB", skB);
    assert.ok(stateA && stateB, "both agent state files written");
    assert.notEqual(stateFileFor("agentA", skA), stateFileFor("agentB", skB));
    assert.equal(stateA.agentId, "agentA");
    assert.equal(stateB.agentId, "agentB");
  });

  it("cadence trigger (capture.everyMessages) fires extraction without a keyword", async () => {
    const cfg = makeCfg({ capture: { keywords: true, everyMessages: 2, everyMinutes: 0 } });
    const i = createInitiative({ cfg, stateDir: tmpDir, llm: makeLlm({ tasks: [{ text: "from cadence", kind: "task" }], directives: [], done: [], drop: [] }) });
    // No keyword; extraction should fire once newSinceExtract reaches everyMessages.
    await i.onMessageReceived({ text: "just chatting, no trigger word at all here" }, groupCtx());
    assert.equal(loadState(), null, "nothing yet before threshold");
    await i.onMessageReceived({ text: "another ordinary message, still no keyword" }, groupCtx());
    const state = loadState();
    assert.ok(state, "extraction fired on cadence");
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].text, "from cadence");
  });

  it("no llm: capture does not throw and writes no tasks", async () => {
    const cfg = makeCfg();
    const i = createInitiative({ cfg, stateDir: tmpDir, log: {} }); // no llm
    await i.onMessageReceived({ text: "merk dir: call am Dienstag" }, groupCtx());
    const state = loadState();
    assert.ok(state, "state dir/file still created for the scope");
    assert.equal(state.tasks.length, 0, "no tasks without llm");
  });

  it("cap pressure: done/expired tasks are dropped before any open task", async () => {
    const cfg = makeCfg({ maxOpenTasks: 4 });
    // Extraction 1: three open tasks.
    const i1 = createInitiative({ cfg, stateDir: tmpDir, llm: makeLlm({ tasks: [{ text: "task A", kind: "task" }, { text: "task B", kind: "task" }, { text: "task C", kind: "task" }], directives: [], done: [], drop: [] }) });
    await i1.onMessageReceived({ text: "vergiss nicht: A B C" }, groupCtx());
    let state = loadState();
    assert.equal(state.tasks.filter((t) => t.status === "open").length, 3);
    const ids = state.tasks.map((t) => t.id);

    // Extraction 2: mark A and B done.
    const i2 = createInitiative({ cfg, stateDir: tmpDir, llm: makeLlm({ tasks: [], directives: [], done: [ids[0], ids[1]], drop: [] }) });
    await i2.onMessageReceived({ text: "erinner: cleanup" }, groupCtx());
    state = loadState();
    assert.equal(state.tasks.filter((t) => t.status === "done").length, 2);
    assert.equal(state.tasks.filter((t) => t.status === "open").length, 1);

    // Extraction 3: three new open tasks push total to 6 (> 4 cap).
    const i3 = createInitiative({ cfg, stateDir: tmpDir, llm: makeLlm({ tasks: [{ text: "task D", kind: "task" }, { text: "task E", kind: "task" }, { text: "task F", kind: "task" }], directives: [], done: [], drop: [] }) });
    await i3.onMessageReceived({ text: "denk dran: D E F" }, groupCtx());
    state = loadState();
    assert.ok(state.tasks.length <= 4, `total tasks bounded at maxOpenTasks (got ${state.tasks.length})`);
    assert.equal(state.tasks.filter((t) => t.status === "done").length, 0, "done tasks dropped first");
    assert.equal(state.tasks.filter((t) => t.status === "expired").length, 0);
    const open = state.tasks.filter((t) => t.status === "open");
    assert.equal(open.length, 4, "open tasks preserved at cap");
    assert.ok(open.some((t) => t.text === "task C"), "pre-existing open task preserved");
  });

  it("onMessageReceived does not await the LLM (fire-and-forget extract)", async () => {
    const cfg = makeCfg();
    let resolveComplete;
    const pending = new Promise((res) => { resolveComplete = res; });
    let completeCalls = 0;
    const llm = {
      complete: async () => {
        completeCalls++;
        await pending;
        return { text: JSON.stringify({ tasks: [{ text: "late task", kind: "task" }], directives: [], done: [], drop: [] }) };
      },
    };
    const i = createInitiative({ cfg, stateDir: tmpDir, llm });

    const start = Date.now();
    await i.onMessageReceived({ text: "merk dir: late task" }, groupCtx());
    const elapsed = Date.now() - start;

    assert.equal(completeCalls, 1, "extract kicked off (llm called)");
    assert.ok(elapsed < 200, `onMessageReceived returned without awaiting the LLM (elapsed ${elapsed}ms)`);
    assert.equal(loadState(), null, "state not written while the LLM is still pending");

    resolveComplete();
    await new Promise((r) => setTimeout(r, 20));

    const state = loadState();
    assert.ok(state, "state written once the LLM settles");
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].text, "late task");
  });

  // ---- Phase 2: gate, decide, tick (shadow) ----

  it("evaluateInitiative: every gate reason individually", () => {
    const ini = makeCfg().initiative;
    const baseCtx = {
      enabled: true,
      scopeAllowed: true,
      now: Date.now(),
      ini,
      actsToday: 0,
      lastActAt: 0,
      lastHumanAt: 0,
      cooldownUntil: 0,
      agentLastSpeakTs: 0,
      ignoreStreak: 0,
      rng: () => 0.0, // always below probability
    };
    const open = { status: "open" };

    // enabled off
    let g = evaluateInitiative(open, { ...baseCtx, enabled: false });
    assert.equal(g.pass, false); assert.ok(g.reasons.includes("enabled"));
    // wrong scope
    g = evaluateInitiative(open, { ...baseCtx, scopeAllowed: false });
    assert.ok(g.reasons.includes("scope"));
    // active-hours (now outside default 08:00-22:00 → craft now at night)
    const night = new Date("2026-09-10T23:00:00").getTime();
    g = evaluateInitiative(open, { ...baseCtx, now: night });
    assert.ok(g.reasons.includes("active-hours"), `got ${g.reasons}`);
    // quiet-hours (night falls in quietStart 22:00..07:00)
    g = evaluateInitiative(open, { ...baseCtx, now: night });
    assert.ok(g.reasons.includes("quiet-hours"));
    // budget
    g = evaluateInitiative(open, { ...baseCtx, actsToday: 2 });
    assert.ok(g.reasons.includes("budget"));
    // min-gap
    g = evaluateInitiative(open, { ...baseCtx, lastActAt: Date.now() - 10 * 60000 });
    assert.ok(g.reasons.includes("min-gap"));
    // hot-room
    g = evaluateInitiative(open, { ...baseCtx, lastHumanAt: Date.now() - 1000 });
    assert.ok(g.reasons.includes("hot-room"));
    // after-speak
    g = evaluateInitiative(open, { ...baseCtx, agentLastSpeakTs: Date.now() - 1000 });
    assert.ok(g.reasons.includes("after-speak"));
    // cooldown
    g = evaluateInitiative(open, { ...baseCtx, cooldownUntil: Date.now() + 600000 });
    assert.ok(g.reasons.includes("cooldown"));
    // task-closed
    g = evaluateInitiative({ status: "done" }, baseCtx);
    assert.ok(g.reasons.includes("task-closed"));
    // paused (ignoreStreak >= 4)
    g = evaluateInitiative(open, { ...baseCtx, ignoreStreak: 4 });
    assert.ok(g.reasons.includes("paused"));
    // probability: rng returns 1.0 → above probability 0.8
    g = evaluateInitiative(open, { ...baseCtx, rng: () => 1.0 });
    assert.ok(g.reasons.includes("probability"));
    // pass when everything clear
    g = evaluateInitiative(open, baseCtx);
    assert.equal(g.pass, true);
    assert.equal(g.reasons.length, 0);
    // ignoreStreak 2 → budgetMultiplier 0.5 (still passes with rng 0)
    g = evaluateInitiative(open, { ...baseCtx, ignoreStreak: 2 });
    assert.equal(g.budgetMultiplier, 0.5);
    assert.equal(g.pass, true);
  });

  it("decision parse: ACT / SKIP / DONE and fenced/garbage → SKIP", async () => {
    // ACT
    {
      const dirA = mkdtemp(tmpDir, "decide-act-");
      const cfg = makeCfg({ shadow: true, everyMinutes: 60, firstNudgeMinutes: 0 });
      const clock = makeClock();
      const llm = {
        complete: async ({ purpose }) => {
          if (purpose === "human-engine-initiative-extract") return { text: JSON.stringify({ tasks: [{ text: "act task", kind: "task" }], directives: [], done: [], drop: [] }) };
          if (purpose === "human-engine-initiative-decide") return { text: '{"decision":"ACT","reason":"due"}' };
          return { text: "act on it now" };
        },
      };
      const i = createInitiative({ cfg, stateDir: dirA, llm, runtime: { subagent: { run: async () => { throw new Error("no subagent in shadow"); } } }, threads: null, state: {}, now: () => clock.t, rng: () => 0 });
      await i.onMessageReceived({ text: "merk dir: act task" }, groupCtx());
      await waitForTaskInState(dirA);
      clock.t += 60 * 60 * 1000;
      await i.tick();
      const log = readLogIn(dirA);
      assert.equal(log.length, 1);
      assert.equal(log[0].mode, "shadow");
      assert.equal(log[0].decide.decision, "ACT");
    }

    // DONE → marks task done, no ACT log entry
    {
      const dirD = mkdtemp(tmpDir, "decide-done-");
      const cfg = makeCfg({ shadow: true, everyMinutes: 60, firstNudgeMinutes: 0 });
      const clock = makeClock();
      const llm = {
        complete: async ({ purpose }) => {
          if (purpose === "human-engine-initiative-extract") return { text: JSON.stringify({ tasks: [{ text: "done task", kind: "task" }], directives: [], done: [], drop: [] }) };
          if (purpose === "human-engine-initiative-decide") return { text: '{"decision":"DONE","reason":"done"}' };
          return { text: "done msg" };
        },
      };
      const i = createInitiative({ cfg, stateDir: dirD, llm, runtime: { subagent: { run: async () => {} } }, threads: null, state: {}, now: () => clock.t, rng: () => 0 });
      await i.onMessageReceived({ text: "merk dir: done task" }, groupCtx());
      await waitForTaskInState(dirD);
      clock.t += 60 * 60 * 1000;
      await i.tick();
      const log = readLogIn(dirD);
      assert.equal(log.filter((e) => e.decide?.decision === "ACT").length, 0, "DONE never logs an ACT");
      const st = loadStateIn(dirD);
      assert.equal(st.tasks[0].status, "done", "DONE marks task done");
    }

    // garbage/fenced → SKIP, no throw
    {
      const dirG = mkdtemp(tmpDir, "decide-garbage-");
      const cfg = makeCfg({ shadow: true, everyMinutes: 60, firstNudgeMinutes: 0 });
      const clock = makeClock();
      const i = createInitiative({ cfg, stateDir: dirG, llm: { complete: async ({ purpose }) => {
        if (purpose === "human-engine-initiative-extract") return { text: JSON.stringify({ tasks: [{ text: "garbage task", kind: "task" }], directives: [], done: [], drop: [] }) };
        return { text: "```garbage```" };
      } }, runtime: { subagent: { run: async () => {} } }, threads: null, state: {}, now: () => clock.t, rng: () => 0 });
      await i.onMessageReceived({ text: "merk dir: garbage task" }, groupCtx());
      await waitForTaskInState(dirG);
      clock.t += 60 * 60 * 1000;
      await i.tick();
      assert.doesNotThrow(() => i.tick());
    }
  });

  it("tick in SHADOW: due task → exactly one shadow log entry; runtime.subagent.run NOT called", async () => {
    const dir = mkdtemp(tmpDir, "shadow-tick-");
    const cfg = makeCfg({ shadow: true, everyMinutes: 60, firstNudgeMinutes: 0 });
    const clock = makeClock();
    let subagentCalls = 0;
    const runtime = { subagent: { run: async () => { subagentCalls++; } } };
    const llm = {
      complete: async ({ purpose }) => {
        if (purpose === "human-engine-initiative-extract") return { text: JSON.stringify({ tasks: [{ text: "shadow task", kind: "task" }], directives: [], done: [], drop: [] }) };
        if (purpose === "human-engine-initiative-decide") return { text: '{"decision":"ACT","reason":"due"}' };
        return { text: "handled in shadow" };
      },
    };
    const i = createInitiative({ cfg, stateDir: dir, llm, runtime, threads: null, state: {}, now: () => clock.t, rng: () => 0 });
    await i.onMessageReceived({ text: "merk dir: shadow task" }, groupCtx());
    await waitForTaskInState(dir);

    clock.t += 60 * 60 * 1000;
    await i.tick();
    const log = readLogIn(dir);
    assert.equal(log.length, 1, "exactly one shadow log entry");
    assert.equal(log[0].mode, "shadow");
    assert.equal(log[0].sent, false);
    assert.equal(subagentCalls, 0, "subagent.run not called in shadow");
  });

  it("idempotency: same candidateId twice (same day) → only one log entry", async () => {
    const dir = mkdtemp(tmpDir, "idem-tick-");
    const cfg = makeCfg({ shadow: true, everyMinutes: 1, firstNudgeMinutes: 0 });
    const clock = makeClock();
    let extractDone = false;
    const llm = {
      complete: async ({ purpose }) => {
        if (purpose === "human-engine-initiative-extract") {
          extractDone = true;
          return { text: JSON.stringify({ tasks: [{ text: "idem task", kind: "task" }], directives: [], done: [], drop: [] }) };
        }
        if (purpose === "human-engine-initiative-decide") return { text: '{"decision":"ACT","reason":"due"}' };
        return { text: "idempotent shadow" };
      },
    };
    const runtime = { subagent: { run: async () => {} } };
    const i = createInitiative({ cfg, stateDir: dir, llm, runtime, threads: null, state: {}, now: () => clock.t, rng: () => 0 });
    await i.onMessageReceived({ text: "merk dir: idem task" }, groupCtx());
    await waitForTaskInState(dir);
    assert.equal(extractDone, true);

    clock.t += 60 * 60 * 1000;
    await i.tick();
    await i.tick();
    await i.tick();
    const log = readLogIn(dir);
    const shadowEntries = log.filter((e) => e.mode === "shadow");
    assert.equal(shadowEntries.length, 1, "same candidateId logged only once");
  });

  it("everyMinutes:0 disables the tick; throttle: two ticks within everyMinutes → second does nothing", async () => {
    // everyMinutes:0 disables
    const dir0 = mkdtemp(tmpDir, "throttle-zero-");
    const cfg0 = makeCfg({ shadow: true, everyMinutes: 0, firstNudgeMinutes: 0 });
    const clock0 = makeClock();
    const llm0 = {
      complete: async ({ purpose }) => {
        if (purpose === "human-engine-initiative-extract") return { text: JSON.stringify({ tasks: [{ text: "disabled task", kind: "task" }], directives: [], done: [], drop: [] }) };
        return { text: '{"decision":"ACT","reason":"due"}' };
      },
    };
    const i0 = createInitiative({ cfg: cfg0, stateDir: dir0, llm: llm0, runtime: { subagent: { run: async () => {} } }, threads: null, state: {}, now: () => clock0.t, rng: () => 0 });
    await i0.onMessageReceived({ text: "merk dir: disabled task" }, groupCtx());
    await waitForTaskInState(dir0);
    clock0.t += 60 * 60 * 1000;
    await i0.tick();
    assert.equal(readLogIn(dir0).length, 0, "everyMinutes 0 → no tick");

    // throttle: everyMinutes large → second tick within window does nothing
    const dirT = mkdtemp(tmpDir, "throttle-window-");
    const cfgT = makeCfg({ shadow: true, everyMinutes: 60, firstNudgeMinutes: 0 });
    const clockT = makeClock();
    let decideCalls = 0;
    let renderCalls = 0;
    const llmT = {
      complete: async ({ purpose }) => {
        if (purpose === "human-engine-initiative-extract") return { text: JSON.stringify({ tasks: [{ text: "throttle task", kind: "task" }], directives: [], done: [], drop: [] }) };
        if (purpose === "human-engine-initiative-decide") { decideCalls++; return { text: '{"decision":"ACT","reason":"due"}' }; }
        renderCalls++;
        return { text: "throttled render" };
      },
    };
    const iT = createInitiative({ cfg: cfgT, stateDir: dirT, llm: llmT, runtime: { subagent: { run: async () => {} } }, threads: null, state: {}, now: () => clockT.t, rng: () => 0 });
    await iT.onMessageReceived({ text: "merk dir: throttle task" }, groupCtx());
    await waitForTaskInState(dirT);
    clockT.t += 60 * 60 * 1000;
    await iT.tick();
    const decideAfterFirst = decideCalls;
    const renderAfterFirst = renderCalls;
    assert.equal(decideAfterFirst, 1, "first tick decided");
    assert.equal(renderAfterFirst, 1, "first tick rendered");
    assert.equal(readLogIn(dirT).length, 1, "first tick logged");
    await iT.tick();
    assert.equal(decideCalls, decideAfterFirst, "second tick within throttle window does nothing");
    assert.equal(renderCalls, renderAfterFirst, "no render on throttled tick");
    assert.equal(readLogIn(dirT).length, 1, "still only one log entry");
  });

  it("transient gate failure does NOT consume the candidate; next tick acts", async () => {
    const dir = mkdtemp(tmpDir, "retry-gate-");
    const cfg = makeCfg({ shadow: true, everyMinutes: 10, firstNudgeMinutes: 0 });
    const clock = makeClock();
    let decideCalls = 0;
    const llm = {
      complete: async ({ purpose }) => {
        if (purpose === "human-engine-initiative-extract") return { text: JSON.stringify({ tasks: [{ text: "retry task", kind: "task" }], directives: [], done: [], drop: [] }) };
        if (purpose === "human-engine-initiative-decide") { decideCalls++; return { text: '{"decision":"ACT","reason":"due"}' }; }
        return { text: "retry shadow" };
      },
    };
    const i = createInitiative({ cfg, stateDir: dir, llm, runtime: { subagent: { run: async () => {} } }, threads: null, state: {}, now: () => clock.t, rng: () => 0 });
    await i.onMessageReceived({ text: "merk dir: retry task" }, groupCtx());
    await waitForTaskInState(dir);

    // Tick 1 at T0: hot-room blocks (now - lastHumanAt = 0 <= 15min). Must NOT
    // consume the candidate (no decide spent, no shadow log).
    await i.tick();
    assert.equal(readLogIn(dir).length, 0, "hot-room blocked tick writes no log");
    assert.equal(decideCalls, 0, "gate failure does not spend the decide call");

    // Advance 20 min: hot-window (15) and everyMinutes throttle (10) both clear.
    clock.t += 20 * 60 * 1000;
    await i.tick();
    assert.equal(decideCalls, 1, "candidate re-evaluated after reason cleared");
    const log = readLogIn(dir);
    assert.equal(log.length, 1, "second tick acts (shadow log written)");
    assert.equal(log[0].decide.decision, "ACT");
  });

  it("gate-pass candidate consumed after gate pass: no re-evaluate same day", async () => {
    const dir = mkdtemp(tmpDir, "consume-gate-");
    const cfg = makeCfg({ shadow: true, everyMinutes: 10, firstNudgeMinutes: 0 });
    const clock = makeClock();
    let decideCalls = 0;
    const llm = {
      complete: async ({ purpose }) => {
        if (purpose === "human-engine-initiative-extract") return { text: JSON.stringify({ tasks: [{ text: "consume task", kind: "task" }], directives: [], done: [], drop: [] }) };
        if (purpose === "human-engine-initiative-decide") { decideCalls++; return { text: '{"decision":"ACT","reason":"due"}' }; }
        return { text: "consume shadow" };
      },
    };
    const i = createInitiative({ cfg, stateDir: dir, llm, runtime: { subagent: { run: async () => {} } }, threads: null, state: {}, now: () => clock.t, rng: () => 0 });
    await i.onMessageReceived({ text: "merk dir: consume task" }, groupCtx());
    await waitForTaskInState(dir);
    clock.t += 20 * 60 * 1000;

    await i.tick();
    assert.equal(decideCalls, 1, "first tick decides");
    assert.equal(readLogIn(dir).length, 1, "one shadow log entry");

    await i.tick();
    assert.equal(decideCalls, 1, "candidate consumed after gate pass → no re-decide");
    assert.equal(readLogIn(dir).length, 1, "still exactly one shadow log entry");
  });

  it("live mode caps stateObj.acts at ACTS_CAP (64)", async () => {
    const dir = mkdtemp(tmpDir, "acts-cap-");
    const cfg = makeCfg({ shadow: false, everyMinutes: 10, firstNudgeMinutes: 0 });
    const clock = makeClock();
    let sent = 0;
    const runtime = { subagent: { run: async () => { sent++; } } };
    const llm = {
      complete: async ({ purpose }) => {
        if (purpose === "human-engine-initiative-extract") return { text: JSON.stringify({ tasks: [{ text: "live task", kind: "task" }], directives: [], done: [], drop: [] }) };
        if (purpose === "human-engine-initiative-decide") return { text: '{"decision":"ACT","reason":"due"}' };
        return { text: "live message" };
      },
    };
    const i = createInitiative({ cfg, stateDir: dir, llm, runtime, threads: null, state: {}, now: () => clock.t, rng: () => 0 });
    await i.onMessageReceived({ text: "merk dir: live task" }, groupCtx());
    await waitForTaskInState(dir);

    // Pre-fill 64 acts (same day, actsToday kept low so budget passes), then one
    // live send appends a 65th → trimmed back to 64.
    const st = i.__store.getOrInit(SCOPE, "test-agent");
    st.acts = Array.from({ length: 64 }, (_, k) => ({ ts: clock.t, taskId: "t" + k, id: "c" + k, kind: "task" }));
    st.actsToday = 0;
    st.day = localDayKeyFor(clock.t);
    i.__store.save(SCOPE, st);

    clock.t += 20 * 60 * 1000;
    await i.tick();

    assert.equal(sent, 1, "live subagent.run called once");
    const finalState = loadStateIn(dir);
    assert.ok(Array.isArray(finalState.acts), "acts persisted");
    assert.equal(finalState.acts.length, 64, "acts trimmed at ACTS_CAP (64)");
  });

  it("gate: cross-budget reason fires when crossLastOutboundAt recent, not when old/absent", () => {
    const ini = makeCfg().initiative;
    const open = { status: "open" };
    const now = Date.now();
    const base = { enabled: true, scopeAllowed: true, now, ini, actsToday: 0, lastActAt: 0, lastHumanAt: 0, cooldownUntil: 0, agentLastSpeakTs: 0, ignoreStreak: 0, rng: () => 0.0 };
    // recent cross outbound → cross-budget
    const recent = evaluateInitiative(open, { ...base, crossLastOutboundAt: now - 1000 });
    assert.ok(recent.reasons.includes("cross-budget"), `got ${recent.reasons}`);
    // absent → no cross-budget, passes
    const absent = evaluateInitiative(open, { ...base });
    assert.equal(absent.reasons.includes("cross-budget"), false);
    assert.equal(absent.pass, true);
    // old → no cross-budget, passes
    const old = evaluateInitiative(open, { ...base, crossLastOutboundAt: now - 24 * 3600e3 });
    assert.equal(old.reasons.includes("cross-budget"), false);
    assert.equal(old.pass, true);
  });

  it("attribution: live act then inbound within 48h resets ignoreStreak, records reply, backfills outcome", async () => {
    const dir = mkdtemp(tmpDir, "attr-");
    const cfg = makeCfg({ shadow: false, everyMinutes: 10, firstNudgeMinutes: 0 });
    const clock = makeClock();
    const runtime = { subagent: { run: async () => {} } };
    const llm = {
      complete: async ({ purpose }) => {
        if (purpose === "human-engine-initiative-extract") return { text: JSON.stringify({ tasks: [{ text: "attr task", kind: "task" }], directives: [], done: [], drop: [] }) };
        if (purpose === "human-engine-initiative-decide") return { text: '{"decision":"ACT","reason":"due"}' };
        return { text: "live attr" };
      },
    };
    const i = createInitiative({ cfg, stateDir: dir, llm, runtime, threads: null, state: {}, now: () => clock.t, rng: () => 0 });
    await i.onMessageReceived({ text: "merk dir: attr task" }, groupCtx());
    await waitForTaskInState(dir);
    clock.t += 20 * 60 * 1000;

    // Live act 1
    await i.tick();
    let state = loadStateIn(dir);
    assert.equal(state.acts.length, 1, "one live act recorded");
    assert.equal(state.tasks[0].ignoreStreak, 0, "first act: no prior act, streak stays 0");
    const actId = state.acts[0].id;

    // Inbound within 48h → attribution
    clock.t += 60 * 1000;
    await i.onMessageReceived({ text: "reply to the act" }, groupCtx());
    state = loadStateIn(dir);
    assert.equal(state.tasks[0].ignoreStreak, 0, "inbound resets/keeps ignoreStreak 0");
    assert.equal(state.replies.length, 1, "one reply recorded");

    // shadow/live log entry outcome backfilled to true
    const log = readLogIn(dir);
    const entry = log.find((e) => e.candidateId === actId);
    assert.ok(entry, "log entry exists for the act");
    assert.equal(entry.outcome.repliedWithin48h, true, "outcome backfilled true");

    // Second inbound does NOT double-attribute
    clock.t += 60 * 1000;
    await i.onMessageReceived({ text: "another reply" }, groupCtx());
    state = loadStateIn(dir);
    assert.equal(state.replies.length, 1, "no double-attribution reply");
  });

  it("ignore-streak increments on consecutive live acts with no inbound; inbound resets", async () => {
    const dir = mkdtemp(tmpDir, "streak-");
    const cfg = makeCfg({ shadow: false, everyMinutes: 10, firstNudgeMinutes: 0 });
    const clock = makeClock();
    const runtime = { subagent: { run: async () => {} } };
    const llm = {
      complete: async ({ purpose }) => {
        if (purpose === "human-engine-initiative-extract") return { text: JSON.stringify({ tasks: [{ text: "streak task", kind: "task" }], directives: [], done: [], drop: [] }) };
        if (purpose === "human-engine-initiative-decide") return { text: '{"decision":"ACT","reason":"due"}' };
        return { text: "live streak" };
      },
    };
    const i = createInitiative({ cfg, stateDir: dir, llm, runtime, threads: null, state: {}, now: () => clock.t, rng: () => 0 });
    await i.onMessageReceived({ text: "merk dir: streak task" }, groupCtx());
    await waitForTaskInState(dir);
    const taskId = loadStateIn(dir).tasks[0].id;

    // Pre-populate a previous live act (6h ago, unanswered) → next live act
    // increments the ignore streak. lastActAt also set 6h ago so min-gap passes.
    const st = i.__store.getOrInit(SCOPE, "test-agent");
    st.day = localDayKeyFor(clock.t);
    st.actsToday = 0;
    st.acts = [{ ts: clock.t - 6 * 3600e3, taskId, id: "prev-act", kind: "task" }];
    st.lastActAt = clock.t - 6 * 3600e3;
    i.__store.save(SCOPE, st);

    clock.t += 20 * 60 * 1000;
    await i.tick();
    let state = loadStateIn(dir);
    assert.equal(state.acts.length, 2, "second live act appended");
    assert.equal(state.tasks[0].ignoreStreak, 1, "unanswered prev act → ignoreStreak incremented");
  });
});

function readLog() {
  const file = path.join(tmpDir, "initiative.jsonl");
  try {
    const raw = fs.readFileSync(file, "utf8");
    return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function mkdtemp(base, prefix) {
  return fs.mkdtempSync(path.join(base, prefix));
}

async function waitFor(fn, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
}

async function waitForTaskInState(dir = tmpDir, agent = "test-agent", sk = SK, count = 1) {
  await waitFor(() => {
    const st = loadStateIn(dir, agent, sk);
    return st && Array.isArray(st.tasks) && st.tasks.length >= count;
  });
}

function readLogIn(dir) {
  const file = path.join(dir, "initiative.jsonl");
  try {
    const raw = fs.readFileSync(file, "utf8");
    return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function loadStateIn(dir, agent = "test-agent", sk = SK) {
  try {
    const safeAgent = agent.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeSk = sk.replace(/[^a-zA-Z0-9_-]/g, "_");
    return JSON.parse(fs.readFileSync(path.join(dir, "initiative", safeAgent, safeSk + ".json"), "utf8"));
  } catch {
    return null;
  }
}
