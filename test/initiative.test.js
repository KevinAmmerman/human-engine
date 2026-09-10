import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInitiative } from "../lib/initiative.js";

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
});
