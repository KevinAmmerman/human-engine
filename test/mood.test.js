import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { createMood, readMood, applyDecay, clampShift, parseAppraisal, renderInjection, buildAppraisalPrompt } from "../lib/mood.js";

const DIRECT_SK = "agent:test-agent:whatsapp:direct:1:4917000000001";
const GROUP_SK = "agent:test-agent:whatsapp:group:123@g.us";

function makeMood({ cfg = {}, llm = null, stateDir, log = { info() {}, warn() {} }, readTranscript = async () => [] }) {
  return createMood({ cfg, llm, stateDir, log, readTranscript });
}

function defaultCfg(over = {}) {
  return {
    enabled: true,
    agents: [],
    mood: { enabled: true, refreshEvery: 5, refreshMinutes: 0, decayHours: 6, maxShiftPerUpdate: 1 },
    ...over,
  };
}

describe("mood", () => {
  let tmpDir;
  let stateDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mood-test-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("injection", () => {
    it("returns appendSystemContext with mood state when enabled + direct + scoped + non-neutral", () => {
      const { moodStatePath } = { moodStatePath: (sd, a, s) => path.join(sd, "mood", a, s + ".json") };
      const mood = makeMood({ cfg: defaultCfg(), stateDir });
      const file = path.join(stateDir, "mood", "test-agent", "agent_test-agent_whatsapp_direct_1_4917000000001.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ valence: 2, energy: -1, note: "genervt aber ruhig", updatedAt: Date.now() }));
      const result = mood.onBeforePromptBuild({}, { sessionKey: DIRECT_SK, agentId: "test-agent" });
      assert.ok(result);
      assert.ok(result.appendSystemContext.includes("Current mood state"));
      assert.notEqual(result.appendSystemContext, undefined);
    });

    it("mood disabled returns undefined (master switch)", () => {
      const mood = makeMood({ cfg: defaultCfg({ mood: { enabled: false } }), stateDir });
      const result = mood.onBeforePromptBuild({}, { sessionKey: DIRECT_SK, agentId: "test-agent" });
      assert.equal(result, undefined);
    });

    it("mood group chat returns undefined even when enabled", () => {
      const mood = makeMood({ cfg: defaultCfg(), stateDir });
      const result = mood.onBeforePromptBuild({}, { sessionKey: GROUP_SK, agentId: "test-agent" });
      assert.equal(result, undefined);
    });

    it("mood unscoped agent returns undefined", () => {
      const mood = makeMood({ cfg: defaultCfg({ agents: ["agent-a"] }), stateDir });
      const result = mood.onBeforePromptBuild({}, { sessionKey: DIRECT_SK, agentId: "agent-b" });
      assert.equal(result, undefined);
    });

    it("returns undefined when state is neutral and note empty", () => {
      const mood = makeMood({ cfg: defaultCfg(), stateDir });
      const result = mood.onBeforePromptBuild({}, { sessionKey: "agent:test-agent:telegram:direct:1:9999", agentId: "test-agent" });
      assert.equal(result, undefined);
    });
  });

  describe("appraisal path", () => {
    it("clamps valence +2 from 0 to +1 (maxShiftPerUpdate) and trims note to 8 words", () => {
      const calls = [];
      const llm = { complete: async (opts) => {
        calls.push(opts);
        return { text: "valence: +2\nenergy: +1\nnote: a b c d e f g h i j" };
      } };
      const mood = makeMood({ cfg: defaultCfg(), llm, stateDir, readTranscript: async () => [{ speaker: "User", text: "hi" }] });
      const file = path.join(stateDir, "mood", "test-agent", "agent_test-agent_whatsapp_direct_1_4917000000001.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ valence: 0, energy: 0, note: "", updatedAt: 0 }));
      return mood.maybeUpdateMood("test-agent", DIRECT_SK).then(() => {
        const state = readMood(stateDir, "test-agent", DIRECT_SK);
        assert.equal(state.valence, 1);
        assert.equal(state.energy, 1);
        assert.equal(state.note.split(" ").length, 8);
        assert.ok(calls.length > 0);
      });
    });

    it("leaves state unchanged and does not throw on unparseable engine output", () => {
      const llm = { complete: async () => ({ text: "garbage nonsense here" }) };
      const mood = makeMood({ cfg: defaultCfg(), llm, stateDir, readTranscript: async () => [{ speaker: "User", text: "hi" }] });
      const file = path.join(stateDir, "mood", "test-agent", "agent_test-agent_whatsapp_direct_1_4917000000001.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ valence: 0, energy: 0, note: "stabil", updatedAt: Date.now() }));
      return mood.maybeUpdateMood("test-agent", DIRECT_SK).then(() => {
        const state = readMood(stateDir, "test-agent", DIRECT_SK);
        assert.equal(state.valence, 0);
        assert.equal(state.note, "stabil");
      });
    });
  });

  describe("decay", () => {
    it("halves valence/energy toward 0 and clears note when older than decayHours", () => {
      const old = { valence: 2, energy: -2, note: "stressed out", updatedAt: Date.now() - 8 * 3600e3 };
      const decayed = applyDecay(old, Date.now(), 6);
      assert.equal(decayed.valence, 1);
      assert.equal(decayed.energy, -1);
      assert.equal(decayed.note, "");
    });

    it("does not decay within decayHours window", () => {
      const fresh = { valence: 2, energy: 2, note: "upbeat", updatedAt: Date.now() - 3600e3 };
      const kept = applyDecay(fresh, Date.now(), 6);
      assert.equal(kept.valence, 2);
      assert.equal(kept.note, "upbeat");
    });
  });

  describe("state file", () => {
    it("writes mood state file with 0600 permissions", () => {
      const mood = makeMood({ cfg: defaultCfg(), llm: { complete: async () => ({ text: "valence: +1\nenergy: 0\nnote: gut" }) }, stateDir, readTranscript: async () => [{ speaker: "User", text: "hi" }] });
      const sk = "agent:test-agent:telegram:direct:1:12345";
      return mood.maybeUpdateMood("test-agent", sk).then(() => {
        const file = path.join(stateDir, "mood", "test-agent", "agent_test-agent_telegram_direct_1_12345.json");
        assert.ok(fs.existsSync(file));
        const mode = fs.statSync(file).mode & 0o777;
        assert.equal(mode, 0o600);
      });
    });
  });

  describe("parsing and rendering", () => {
    it("parseAppraisal returns null for missing fields", () => {
      assert.equal(parseAppraisal("hello world"), null);
    });

    it("parseAppraisal parses valence/energy/note", () => {
      const parsed = parseAppraisal("valence: -1\nenergy: +2\nnote: ziemlich aufgedreht");
      assert.deepEqual(parsed, { valence: -1, energy: 2, note: "ziemlich aufgedreht" });
    });

    it("renderInjection resolves semantic labels", () => {
      const out = renderInjection({ valence: 2, energy: -2, note: "sehr müde" });
      assert.ok(out.includes("Current mood state"));
      assert.ok(out.includes("gut/aufgeladen"));
      assert.ok(out.includes("still/niedrig"));
      assert.ok(out.includes("note: sehr müde"));
    });

    it("clampShift clamps movement per axis", () => {
      assert.equal(clampShift({ valence: 0, energy: 0 }, { valence: 2, energy: 2 }, 1).valence, 1);
      assert.equal(clampShift({ valence: 0, energy: 0 }, { valence: -3, energy: -3 }, 1).valence, -1);
      assert.equal(clampShift({ valence: 1, energy: 1 }, { valence: 1, energy: 1 }, 1).valence, 1);
    });

    it("buildAppraisalPrompt includes recent turns and current state", () => {
      const p = buildAppraisalPrompt([{ speaker: "User", text: "hallo" }], { valence: 0, energy: 0, note: "" });
      assert.ok(p.includes("hallo"));
      assert.ok(p.includes("valence:"));
    });
  });
});
