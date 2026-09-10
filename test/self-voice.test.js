import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSelfVoice } from "../lib/self-voice.js";
import { createObservedStore } from "../lib/observed-store.js";

const SK = "agent:test-agent:whatsapp:group:123@g.us";

function makeCfg(overrides = {}) {
  return {
    enabled: true,
    agents: [],
    agentName: "Yuki",
    agentAliases: ["Hori"],
    selfVoice: { enabled: true, refreshMinutes: 60, minVolume: 3 },
    ...overrides,
  };
}

function makeLog() {
  const infos = [];
  return { info(msg) { infos.push(msg); }, warn() {}, debug() {}, _infos: infos };
}

function makeEngine(block) {
  return {
    extractSelfVoice: async () => (block ? { prompt_block: block } : null),
  };
}

function statePath(tmpDir, agentId) {
  return path.join(tmpDir, "self-voice", String(agentId).replace(/[^a-zA-Z0-9_-]/g, "_") + ".json");
}

describe("self-voice", { concurrency: false }, () => {
  let tmpDir;
  let observed;
  let log;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-voice-test-"));
    fs.mkdirSync(tmpDir, { recursive: true });
    log = makeLog();
    observed = createObservedStore({ stateDir: tmpDir, log });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  function seedOwnReplies(n, name = "Yuki") {
    for (let i = 0; i < n; i++) {
      observed.appendObserved(SK, { speaker: name, text: "own line " + i, ts: Date.now() + i });
    }
  }
  function seedOthers(n, name = "Bob") {
    for (let i = 0; i < n; i++) {
      observed.appendObserved(SK, { speaker: name, text: "other " + i, ts: Date.now() + i });
    }
  }

  describe("off-by-default", () => {
    it("selfVoice.enabled:false → zero files, snapshotFor null, refresh/accept/reset no-op", async () => {
      const sv = createSelfVoice({
        cfg: makeCfg({ selfVoice: { enabled: false, refreshMinutes: 60, minVolume: 3 } }),
        engine: makeEngine("# Card"),
        stateDir: tmpDir,
        observedStore: observed,
        log,
      });
      seedOwnReplies(5);
      const ok = await sv.refreshFor("test-agent", SK);
      assert.equal(ok, false, "refresh no-op when disabled");
      assert.equal(sv.snapshotFor("test-agent"), null, "snapshotFor null when disabled");
      assert.equal(sv.accept("test-agent"), false, "accept no-op when disabled");
      assert.equal(sv.reset("test-agent"), false, "reset no-op when disabled");
      assert.ok(!fs.existsSync(path.join(tmpDir, "self-voice")), "no state directory created when disabled");
    });
  });

  describe("extract/preview/accept/reset loop", () => {
    it("below min volume → no learn, no state file", async () => {
      const sv = createSelfVoice({
        cfg: makeCfg(),
        engine: makeEngine("# Card"),
        stateDir: tmpDir,
        observedStore: observed,
        log,
      });
      seedOwnReplies(2);
      const ok = await sv.refreshFor("test-agent", SK);
      assert.equal(ok, false, "below min volume does not learn");
      assert.ok(!fs.existsSync(path.join(tmpDir, "self-voice")), "no state file below min volume");
    });

    it("refresh writes pending (preview), not active", async () => {
      const sv = createSelfVoice({
        cfg: makeCfg(),
        engine: makeEngine("Own voice card"),
        stateDir: tmpDir,
        observedStore: observed,
        log,
      });
      seedOwnReplies(5);
      const ok = await sv.refreshFor("test-agent", SK);
      assert.equal(ok, true, "learned at sufficient volume");
      assert.equal(sv.snapshotFor("test-agent"), null, "preview does not leak into active");
      const raw = fs.readFileSync(statePath(tmpDir, "test-agent"), "utf8");
      const parsed = JSON.parse(raw);
      assert.equal(parsed.version, 1, "state version 1");
      assert.equal(parsed.activeCard, null, "active still null before accept");
      assert.equal(parsed.pendingCard, "Own voice card", "pending holds preview");
    });

    it("accept moves pending → active and writes .bak of previous active", async () => {
      const sv = createSelfVoice({
        cfg: makeCfg(),
        engine: makeEngine("First voice"),
        stateDir: tmpDir,
        observedStore: observed,
        log,
      });
      seedOwnReplies(5);
      await sv.refreshFor("test-agent", SK);
      assert.equal(sv.accept("test-agent"), true, "accept succeeds with pending");
      assert.equal(sv.snapshotFor("test-agent"), "First voice", "active renders after accept");
      const file = statePath(tmpDir, "test-agent");
      let parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(parsed.activeCard, "First voice");
      assert.equal(parsed.pendingCard, null);

      // second refresh → new pending; accept backs up previous active
      await sv.refreshFor("test-agent", SK);
      assert.equal(sv.snapshotFor("test-agent"), "First voice", "still active until second accept");
      assert.equal(sv.accept("test-agent"), true);
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(parsed.activeCard, "First voice", "engine still returns First voice");
      assert.ok(fs.existsSync(file + ".bak"), ".bak written on second accept");
    });

    it("extract uses only the agent's own lines (aliases count, others excluded)", async () => {
      let seen = null;
      const engine = {
        extractSelfVoice: async ({ transcript }) => {
          seen = transcript;
          return { prompt_block: "# V" };
        },
      };
      const sv = createSelfVoice({ cfg: makeCfg(), engine, stateDir: tmpDir, observedStore: observed, log });
      seedOthers(10);
      seedOwnReplies(4, "hori");
      const ok = await sv.refreshFor("test-agent", SK);
      assert.equal(ok, true);
      assert.ok(seen.length >= 4, "own alias lines extracted");
      assert.ok(seen.every((l) => String(l.speaker).toLowerCase() === "hori"), "only own lines passed");
    });

    it("reset clears active and pending", async () => {
      const sv = createSelfVoice({
        cfg: makeCfg(),
        engine: makeEngine("Voice"),
        stateDir: tmpDir,
        observedStore: observed,
        log,
      });
      seedOwnReplies(5);
      await sv.refreshFor("test-agent", SK);
      sv.accept("test-agent");
      assert.equal(sv.snapshotFor("test-agent"), "Voice");
      assert.equal(sv.reset("test-agent"), true, "reset succeeds");
      assert.equal(sv.snapshotFor("test-agent"), null, "voice died after reset");
      const parsed = JSON.parse(fs.readFileSync(statePath(tmpDir, "test-agent"), "utf8"));
      assert.equal(parsed.activeCard, null);
      assert.equal(parsed.pendingCard, null);
    });

    it("state file is 0600, dir is 0700", async () => {
      const sv = createSelfVoice({
        cfg: makeCfg(),
        engine: makeEngine("V"),
        stateDir: tmpDir,
        observedStore: observed,
        log,
      });
      seedOwnReplies(5);
      await sv.refreshFor("test-agent", SK);
      sv.accept("test-agent");
      const dirMode = fs.statSync(path.join(tmpDir, "self-voice")).mode & 0o777;
      const fileMode = fs.statSync(statePath(tmpDir, "test-agent")).mode & 0o777;
      assert.equal(dirMode, 0o700, "dir is 0700");
      assert.equal(fileMode, 0o600, "file is 0600");
    });
  });
});
