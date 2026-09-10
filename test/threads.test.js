import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createThreads } from "../lib/threads.js";
import { createObservedStore } from "../lib/observed-store.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "threads-test-"));

const SK = "agent:test-agent:whatsapp:group:123@g.us";
const SCOPE = "test-agent::" + SK;

function makeCfg(overrides = {}) {
  return {
    enabled: true,
    agents: [],
    agentName: "Yuki",
    agentAliases: ["Hori"],
    threads: {
      enabled: true,
      absenceThresholdHours: 24,
      topicExpiryDays: 14,
    },
    ...overrides,
  };
}

function makeLog() {
  const warns = [];
  return { info() {}, warn(msg) { warns.push(msg); }, debug() {}, _warns: warns };
}

// A person store whose getOrLoadProfile returns open_threads from a per-agent
// profile (plan 019 semantics: scope → agent profile).
function makeSocialMemory(profile) {
  return {
    getOrLoadProfile(scope) {
      return profile || { people: {} };
    },
  };
}

function threadsFile() {
  const safe = String(SK).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(tmpDir, "social-threads", "test-agent", safe + ".json");
}

describe("threads", { concurrency: false }, () => {
  let log;
  let observed;

  beforeEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(tmpDir, { recursive: true });
    log = makeLog();
    observed = createObservedStore({ stateDir: tmpDir, log });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  function makeThreads(overrides = {}) {
    return createThreads({
      cfg: makeCfg(),
      stateDir: tmpDir,
      socialMemory: makeSocialMemory(),
      observedStore: observed,
      log,
      ...overrides,
    });
  }

  describe("persistence", () => {
    it("onActivity + onSpeak + stop writes a version-1 0600 file with correct values", () => {
      const threads = makeThreads();
      threads.onActivity(SK, "test-agent");
      threads.onSpeak(SK, "test-agent");
      threads.stop();

      const file = threadsFile();
      assert.ok(fs.existsSync(file), "state file created");
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, "file mode 0600");
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700, "dir mode 0700");

      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(parsed.version, 1, "version-1 state convention");
      assert.ok(typeof parsed.lastAgentSpeakTs === "number");
      assert.ok(typeof parsed.lastGroupActivityTs === "number");
      assert.equal(parsed.agentAbsentSince, 0, "onSpeak clears absence");
    });
  });

  describe("rebuild", () => {
    it("rebuilds lastGroupActivityTs and agentAbsentSince from the observed store when the file is missing", () => {
      const now = Date.now();
      observed.appendObserved(SK, { speaker: "Nico", text: "frage", ts: now - 3 * 86400e3 });
      observed.appendObserved(SK, { speaker: "Yuki", text: "meine antwort", ts: now - 2 * 86400e3 });
      observed.appendObserved(SK, { speaker: "Anna", text: "letzte aktivitaet", ts: now - 1 * 86400e3 });

      const threads = makeThreads();
      const line = threads.contextFor(SK, "test-agent");

      assert.ok(line, "absence line rendered after rebuild");
      assert.ok(line.includes("2 days ago"), "gap computed from last own speak (2 days)");
      const file = threadsFile();
      assert.ok(fs.existsSync(file), "file created lazily after flush");
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 1);
    });

    it("freshly onboarded scope (no observed) starts absence at 0", () => {
      const threads = makeThreads();
      const line = threads.contextFor(SK, "test-agent");
      assert.equal(line, null, "no absence line for a fresh scope");
    });
  });

  describe("rendering guards", () => {
    it("renders exactly ONE line only when absent > 24h or a thread awaits the agent", () => {
      const threads = makeThreads();
      // onActivity now, no gap
      threads.onActivity(SK, "test-agent");
      assert.equal(threads.contextFor(SK, "test-agent"), null, "no line right after activity");

      // Simulate an old lastAgentSpeakTs persisted to disk
      threads.stop();
      const file = threadsFile();
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      state.lastAgentSpeakTs = Date.now() - 2 * 86400e3;
      state.lastGroupActivityTs = Date.now() - 1 * 86400e3;
      state.agentAbsentSince = Date.now() - 2 * 86400e3;
      fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });

      const fresh = createThreads({
        cfg: makeCfg(),
        stateDir: tmpDir,
        socialMemory: makeSocialMemory(),
        observedStore: observed,
        log,
      });
      const line = fresh.contextFor(SK, "test-agent");
      assert.ok(line, "absence line rendered for a >24h gap");
      assert.equal((line.match(/pick ONE/g) || []).length, 1, "exactly ONE bounded instruction");
      assert.ok(!line.includes("Open threads:"), "no thread sentence when there are no topics");
    });

    it("never renders a line when the agent recently spoke", () => {
      const threads = makeThreads();
      threads.onSpeak(SK, "test-agent");
      assert.equal(threads.contextFor(SK, "test-agent"), null, "no absence right after agent speak");
    });
  });

  describe("topic expiry", () => {
    it("filters topics older than topicExpiryDays using the entry lastTs, falling back to lastSeenTs", () => {
      const now = Date.now();
      const fresh = { topic: "Wochenendplan", lastExchange: "Wir planen Samstag.", whoOwesWhat: "Yuki muss antworten", lastTs: now - 1000 };
      const stale = { topic: "Alter Kram", lastExchange: "längst vorbei.", whoOwesWhat: "Yuki", lastTs: now - 20 * 86400e3 };
      const profile = {
        people: {
          Nico: {
            open_threads: [fresh, stale],
            lastSeenTs: now - 1000,
          },
        },
      };

      // agent last spoke 2 days ago -> gap active, topics rendered
      const threads = createThreads({
        cfg: makeCfg(),
        stateDir: tmpDir,
        socialMemory: makeSocialMemory(profile),
        observedStore: observed,
        log,
      });
      threads.onSpeak(SK, "test-agent");
      threads.stop();
      const file = threadsFile();
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      state.lastAgentSpeakTs = now - 2 * 86400e3;
      state.lastGroupActivityTs = now - 1 * 86400e3;
      state.agentAbsentSince = now - 2 * 86400e3;
      fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });

      const fresh2 = createThreads({
        cfg: makeCfg(),
        stateDir: tmpDir,
        socialMemory: makeSocialMemory(profile),
        observedStore: observed,
        log,
      });
      const line = fresh2.contextFor(SK, "test-agent");
      assert.ok(line, "gap line rendered");
      assert.ok(line.includes("Wir planen Samstag."), "fresh topic present");
      assert.ok(!line.includes("längst vorbei"), "stale topic filtered by expiry");
    });

    it("falls back to lastSeenTs when an entry lacks lastTs", () => {
      const now = Date.now();
      const noTs = { topic: "Neues Thema", lastExchange: "Wer macht mit?", whoOwesWhat: "Yuki" };
      const profile = {
        people: {
          Anna: { open_threads: [noTs], lastSeenTs: now - 1000 },
        },
      };
      const threads = createThreads({
        cfg: makeCfg(),
        stateDir: tmpDir,
        socialMemory: makeSocialMemory(profile),
        observedStore: observed,
        log,
      });
      threads.onSpeak(SK, "test-agent");
      threads.stop();
      const file = threadsFile();
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      state.lastAgentSpeakTs = now - 2 * 86400e3;
      state.lastGroupActivityTs = now - 1 * 86400e3;
      state.agentAbsentSince = now - 2 * 86400e3;
      fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });

      const fresh = createThreads({
        cfg: makeCfg(),
        stateDir: tmpDir,
        socialMemory: makeSocialMemory(profile),
        observedStore: observed,
        log,
      });
      const line = fresh.contextFor(SK, "test-agent");
      assert.ok(line, "line rendered");
      assert.ok(line.includes("Wer macht mit?"), "no-ts topic kept via lastSeenTs fallback");
    });
  });

  describe("snapshotFor", () => {
    it("returns raw state (no rendering) with absent-since and open topics", () => {
      const now = Date.now();
      const owedToAgent = { topic: "Tour morgen", lastExchange: "Startzeit unklar", whoOwesWhat: "Yuki muss Bescheid geben" };
      const memberOwes = { topic: "Leihgabe", lastExchange: "Basti leiht die Ausrüstung", whoOwesWhat: "Basti bringt sie mit" };
      const profile = {
        people: {
          Nico: { open_threads: [owedToAgent], lastSeenTs: now - 1000 },
          Basti: { open_threads: [memberOwes], lastSeenTs: now - 1000 },
        },
      };
      observed.appendObserved(SK, { speaker: "Nico", text: "frage", ts: now - 3 * 86400e3 });
      observed.appendObserved(SK, { speaker: "Yuki", text: "meine antwort", ts: now - 2 * 86400e3 });
      const threads = createThreads({
        cfg: makeCfg(),
        stateDir: tmpDir,
        socialMemory: makeSocialMemory(profile),
        observedStore: observed,
        log,
      });
      const snap = threads.snapshotFor(SK, "test-agent");
      assert.ok(snap, "snapshot returned for enabled threads");
      assert.ok(snap.agentAbsentSince > 24 * 3600e3, "absent since computed from last own speak");
      assert.ok(typeof snap.lastGroupActivityTs === "number");
      assert.ok(typeof snap.lastAgentSpeakTs === "number");
      assert.ok(Array.isArray(snap.openTopics));
      const awaitingAgent = snap.openTopics.find((t) => t.awaiting === "agent");
      assert.ok(awaitingAgent, "awaiting-agent topic present raw");
      assert.equal(awaitingAgent.topic, "Tour morgen");
    });

    it("returns null when threads are disabled", () => {
      const threads = createThreads({
        cfg: { ...makeCfg(), threads: { enabled: false, absenceThresholdHours: 24, topicExpiryDays: 14 } },
        stateDir: tmpDir,
        socialMemory: makeSocialMemory(),
        observedStore: observed,
        log,
      });
      assert.equal(threads.snapshotFor(SK, "test-agent"), null);
    });
  });

  describe("awaiting classification", () => {
    it("classifies a thread awaiting the agent from whoOwesWhat mentioning the agent name/alias", () => {
      const now = Date.now();
      const owedToAgent = { topic: "Tour morgen", lastExchange: "Startzeit unklar", whoOwesWhat: "Yuki muss Bescheid geben" };
      const memberOwes = { topic: "Leihgabe", lastExchange: "Basti leiht die Ausrüstung", whoOwesWhat: "Basti bringt sie mit" };
      const profile = {
        people: {
          Nico: { open_threads: [owedToAgent], lastSeenTs: now - 1000 },
          Basti: { open_threads: [memberOwes], lastSeenTs: now - 1000 },
        },
      };

      const threads = createThreads({
        cfg: makeCfg(),
        stateDir: tmpDir,
        socialMemory: makeSocialMemory(profile),
        observedStore: observed,
        log,
      });
      // no gap (agent recently spoke), but an awaiting-agent thread must still render
      threads.onSpeak(SK, "test-agent");
      threads.stop();
      const file = threadsFile();
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });

      const fresh = createThreads({
        cfg: makeCfg(),
        stateDir: tmpDir,
        socialMemory: makeSocialMemory(profile),
        observedStore: observed,
        log,
      });
      const line = fresh.contextFor(SK, "test-agent");
      assert.ok(line, "thread awaiting the agent renders the line even without a gap");
      assert.ok(line.includes("Startzeit unklar"), "agent-awaiting topic summary present");
    });
  });

  describe("off-by-default", () => {
    it("threads.enabled:false → contextFor always null, zero files, zero injection", () => {
      const disabled = createThreads({
        cfg: { ...makeCfg(), threads: { enabled: false, absenceThresholdHours: 24, topicExpiryDays: 14 } },
        stateDir: tmpDir,
        socialMemory: makeSocialMemory(),
        observedStore: observed,
        log,
      });
      disabled.onActivity(SK, "test-agent");
      disabled.onSpeak(SK, "test-agent");
      disabled.stop();
      assert.equal(disabled.contextFor(SK, "test-agent"), null, "contextFor null when disabled");
      assert.ok(!fs.existsSync(path.join(tmpDir, "social-threads")), "no state directory created when disabled");
    });
  });
});
