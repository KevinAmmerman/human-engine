import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInitiativeStore } from "../lib/initiative-store.js";
import { localDayKey } from "../lib/proactive.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "initiative-store-test-"));

const SK = "agent:test-agent:whatsapp:group:123@g.us";
const SCOPE = "test-agent::" + SK;

function makeLog() {
  const warns = [];
  return { info() {}, warn(msg) { warns.push(msg); }, debug() {}, _warns: warns };
}

function storeFile(scope = SCOPE) {
  const agent = String(scope.split("::")[0]).replace(/[^a-zA-Z0-9_-]/g, "_");
  const sk = String(scope.split("::").slice(1).join("::")).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(tmpDir, "initiative", agent, sk + ".json");
}

describe("initiative-store", { concurrency: false }, () => {
  let log;

  beforeEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(tmpDir, { recursive: true });
    log = makeLog();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("defaultState returns the version-1 shape with empty arrays/zeros", () => {
    const s = createInitiativeStore({ stateDir: tmpDir, log });
    const d = s.defaultState();
    assert.equal(d.version, 1);
    assert.deepEqual(d.tasks, []);
    assert.deepEqual(d.directives, []);
    assert.equal(d.lastCaptureTs, 0);
    assert.equal(d.lastActAt, 0);
    assert.equal(d.lastHumanAt, 0);
    assert.equal(d.day, "");
    assert.equal(d.actsToday, 0);
    assert.deepEqual(d.acts, []);
    assert.deepEqual(d.replies, []);
    assert.deepEqual(d.cooldowns, {});
  });

  it("getOrInit creates a default state without writing to disk until dirty", () => {
    const s = createInitiativeStore({ stateDir: tmpDir, log });
    const stateObj = s.getOrInit(SCOPE, "test-agent");
    assert.equal(stateObj.version, 1);
    assert.equal(stateObj.scope, SCOPE);
    assert.equal(stateObj.agentId, "test-agent");
    assert.equal(fs.existsSync(storeFile()), false, "no file until save/flush");
  });

  it("save persists to disk (tmp+rename 0600) and load reads it back", () => {
    const s = createInitiativeStore({ stateDir: tmpDir, log });
    const stateObj = s.getOrInit(SCOPE, "test-agent");
    stateObj.tasks.push({ id: "t1", kind: "todo", text: "buy milk" });
    s.save(SCOPE, stateObj);

    const stat = fs.statSync(storeFile());
    assert.equal(stat.mode & 0o777, 0o600, "state file mode 0600");

    const s2 = createInitiativeStore({ stateDir: tmpDir, log });
    const loaded = s2.load(SCOPE);
    assert.equal(loaded.version, 1);
    assert.equal(loaded.tasks.length, 1);
    assert.equal(loaded.tasks[0].text, "buy milk");
  });

  it("evicts done/oldest tasks first when the state exceeds the 64 KB cap", () => {
    const s = createInitiativeStore({ stateDir: tmpDir, log });
    const stateObj = s.getOrInit(SCOPE, "test-agent");
    const big = "x".repeat(5000);
    for (let i = 0; i < 30; i++) {
      stateObj.tasks.push({ id: "t" + i, kind: "todo", text: big, status: i % 2 ? "open" : "done", createdAt: i });
    }
    s.save(SCOPE, stateObj);

    const s2 = createInitiativeStore({ stateDir: tmpDir, log });
    const loaded = s2.load(SCOPE);
    const remaining = loaded.tasks;
    assert.ok(remaining.length < 30, "tasks evicted to fit cap");
    assert.ok(Buffer.byteLength(JSON.stringify(loaded), "utf8") <= 64 * 1024, "state under 64 KB");
    const openRemaining = remaining.filter((t) => t.status === "open");
    assert.equal(openRemaining.length, remaining.length, "no open task evicted while done tasks remain");
  });

  it("appendLog/pruneLog maintain a 14-day day-key retention and 4 MB cap", () => {
    const s = createInitiativeStore({ stateDir: tmpDir, log });
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      const ts = now - i * 86400e3;
      s.appendLog({ ts, day: localDayKey(ts), kind: "candidate", scope: SCOPE });
    }
    const lines = fs.readFileSync(path.join(tmpDir, "initiative.jsonl"), "utf8").trim().split("\n").filter(Boolean);
    assert.ok(lines.length <= 14 + 1, `log pruned to at most 14+1 days (got ${lines.length})`);
    const keptDays = [...new Set(lines.map((l) => JSON.parse(l).day))];
    assert.ok(keptDays.length <= 14 + 1, "at most 14+1 distinct days kept");
  });

  it("stop flushes dirty scopes", () => {
    const s = createInitiativeStore({ stateDir: tmpDir, log });
    const stateObj = s.getOrInit(SCOPE, "test-agent");
    stateObj.lastHumanAt = 123;
    s.getOrInit(SCOPE, "test-agent");
    s.__stateForTests().dirty.add(SCOPE);
    s.stop();
    const loaded = createInitiativeStore({ stateDir: tmpDir, log }).load(SCOPE);
    assert.equal(loaded.lastHumanAt, 123, "dirty scope flushed on stop");
  });

  it("findByTopicKey round-trips save/load and its topicKey survives evictToCap", () => {
    const s = createInitiativeStore({ stateDir: tmpDir, log });
    const stateObj = s.getOrInit(SCOPE, "test-agent");
    stateObj.tasks.push({ id: "t1", topicKey: "tk-abc", kind: "task", text: "buy milk", status: "open", createdAt: 1 });
    s.save(SCOPE, stateObj);

    const s2 = createInitiativeStore({ stateDir: tmpDir, log });
    const found = s2.findByTopicKey(SCOPE, "tk-abc");
    assert.ok(found, "found by topic key after save/load");
    assert.equal(found.text, "buy milk");
    assert.equal(s2.findByTopicKey(SCOPE, "tk-missing"), null, "missing topic key returns null");

    const evDir = fs.mkdtempSync(path.join(tmpDir, "evict-"));
    const se = createInitiativeStore({ stateDir: evDir, log });
    const big = se.getOrInit(SCOPE, "test-agent");
    const filler = "x".repeat(5000);
    for (let i = 0; i < 30; i++) {
      big.tasks.push({ id: "f" + i, kind: "todo", text: filler, status: "done", createdAt: i });
    }
    big.tasks.push({ id: "keeper", topicKey: "tk-keep", kind: "task", text: "keeper", status: "open", createdAt: 1e9 });
    se.save(SCOPE, big);

    const se2 = createInitiativeStore({ stateDir: evDir, log });
    const keeper = se2.findByTopicKey(SCOPE, "tk-keep");
    assert.ok(keeper, "open topic-keyed task survives evictToCap");
    assert.equal(keeper.topicKey, "tk-keep", "topicKey survives evictToCap");
    const loaded = se2.load(SCOPE);
    assert.ok(Buffer.byteLength(JSON.stringify(loaded), "utf8") <= 64 * 1024, "state under cap");
  });

  it("listOpenTasksForAgent returns only open tasks, each tagged with its scope", () => {
    const s = createInitiativeStore({ stateDir: tmpDir, log });
    const a = s.getOrInit(SCOPE, "test-agent");
    a.tasks.push({ id: "open-1", topicKey: "tk-1", kind: "task", text: "open one", status: "open", createdAt: 1 });
    a.tasks.push({ id: "done-1", topicKey: "tk-2", kind: "task", text: "done one", status: "done", createdAt: 2 });
    s.save(SCOPE, a);

    const SK2 = "agent:test-agent:whatsapp:group:456@g.us";
    const SCOPE2 = "test-agent::" + SK2;
    const b = s.getOrInit(SCOPE2, "test-agent");
    b.tasks.push({ id: "open-2", topicKey: "tk-3", kind: "task", text: "open two", status: "open", createdAt: 3 });
    b.tasks.push({ id: "expired-1", topicKey: "tk-4", kind: "task", text: "expired one", status: "expired", createdAt: 4 });
    s.save(SCOPE2, b);

    const s2 = createInitiativeStore({ stateDir: tmpDir, log });
    const open = s2.listOpenTasksForAgent("test-agent");
    assert.equal(open.length, 2, "only the two open tasks returned");
    assert.ok(open.every((t) => t.status === "open"), "all returned tasks are open");
    assert.deepEqual(open.map((t) => t.id).sort(), ["open-1", "open-2"], "both scopes' open tasks included");
    assert.ok(open.every((t) => typeof t.scope === "string" && t.scope.includes("::")), "each row carries its scope");
    assert.deepEqual(s2.listOpenTasksForAgent("other-agent"), [], "unknown agent has no open tasks");
  });
});
