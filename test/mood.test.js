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
      assert.ok(result.appendSystemContext.includes("valence 2"), "valence axis must be rendered");
      assert.ok(result.appendSystemContext.includes("energy -1"), "energy axis must be rendered");
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

    it("plan 030: group chat injects when mood.groupsEnabled is true (same injection contract as DM)", () => {
      const mood = makeMood({ cfg: defaultCfg({ mood: { enabled: true, groupsEnabled: true } }), stateDir });
      const file = path.join(stateDir, "mood", "test-agent", "agent_test-agent_whatsapp_group_123_g_us.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ valence: 2, energy: 2, note: "abgefahren", updatedAt: Date.now() }));
      const result = mood.onBeforePromptBuild({}, { sessionKey: GROUP_SK, agentId: "test-agent" });
      assert.ok(result);
      assert.ok(result.appendSystemContext.includes("Current mood state"));
      assert.ok(result.appendSystemContext.includes("valence 2"));
    });

    it("plan 030: group chat does NOT inject when groupsEnabled is false (default off-contract)", () => {
      const mood = makeMood({ cfg: defaultCfg(), stateDir });
      const file = path.join(stateDir, "mood", "test-agent", "agent_test-agent_whatsapp_group_123_g_us.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ valence: 2, energy: 2, note: "abgefahren", updatedAt: Date.now() }));
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
        assert.equal(calls[0].agentId, "test-agent");
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

    it("plan 030: decay persists across appraisals — a 7h-old +2 state starts the next appraisal at the halved baseline", async () => {
      const prompts = [];
      const llm = { complete: async (opts) => { prompts.push(opts.messages.map((m) => m.content).join("\n")); return { text: "valence: +2\nenergy: +2\nnote: weiter aufgedreht" }; } };
      const mood = makeMood({ cfg: defaultCfg({ mood: { enabled: true, refreshEvery: 5, refreshMinutes: 0, decayHours: 6, maxShiftPerUpdate: 1 } }), llm, stateDir, readTranscript: async () => [{ speaker: "User", text: "hi" }] });
      const file = path.join(stateDir, "mood", "test-agent", "agent_test-agent_whatsapp_direct_1_4917000000001.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ valence: 2, energy: 2, note: "alt", updatedAt: Date.now() - 7 * 3600e3 }));

      // First appraisal: baseline decays to +1, appraisal +2 clamped +1 → +2, then updatedAt = now.
      await mood.maybeUpdateMood("test-agent", DIRECT_SK);
      assert.ok(prompts[0].includes("valence: 1"), "first appraisal starts from the decayed baseline (valence 1)");
      const afterFirst = readMood(stateDir, "test-agent", DIRECT_SK);
      assert.equal(afterFirst.valence, 2, "clamped +1 from decayed baseline 1 → 2");

      // Simulate 7h passing: rewrite updatedAt back 7h, then a second appraisal decays +2 → +1 baseline.
      fs.writeFileSync(file, JSON.stringify({ ...afterFirst, updatedAt: Date.now() - 7 * 3600e3 }));
      await mood.maybeUpdateMood("test-agent", DIRECT_SK);
      assert.ok(prompts[1].includes("valence: 1"), "second appraisal also starts from the halved baseline (accumulated decay)");
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

  describe("group mood (plan 030)", () => {
    const groupFile = () => path.join(stateDir, "mood", "test-agent", "agent_test-agent_whatsapp_group_123_g_us.json");

    it("group appraisal runs every groupsRefreshEvery when groupsEnabled (no DM state written)", async () => {
      const calls = [];
      const llm = { complete: async (opts) => { calls.push(opts); return { text: "valence: +1\nenergy: +2\nnote: gut drauf" }; } };
      const mood = makeMood({ cfg: defaultCfg({ mood: { enabled: true, groupsEnabled: true, groupsRefreshEvery: 2, refreshEvery: 5, refreshMinutes: 0, decayHours: 6, maxShiftPerUpdate: 1 } }), llm, stateDir, readTranscript: async () => [{ speaker: "Nico", text: "hey alle" }] });
      // 1st group message: no appraisal (n=1 < 2)
      mood.onMessageReceived({}, { sessionKey: GROUP_SK, agentId: "test-agent" });
      // 2nd group message: appraisal fires
      mood.onMessageReceived({}, { sessionKey: GROUP_SK, agentId: "test-agent" });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(calls.length, 1, "one group appraisal on the 2nd message");
      const state = readMood(stateDir, "test-agent", GROUP_SK);
      assert.equal(state.valence, 1);
      assert.equal(state.energy, 2);
    });

    it("group appraisal is skipped when groupsEnabled is false (no state file, no llm call)", async () => {
      let called = false;
      const llm = { complete: async () => { called = true; return { text: "valence: +1\nenergy: +1\nnote: x" }; } };
      const mood = makeMood({ cfg: defaultCfg({ mood: { enabled: true, groupsEnabled: false, groupsRefreshEvery: 1, refreshEvery: 1, refreshMinutes: 0 } }), llm, stateDir, readTranscript: async () => [{ speaker: "Nico", text: "hi" }] });
      try { fs.rmSync(groupFile()); } catch {}
      for (let i = 0; i < 3; i++) mood.onMessageReceived({}, { sessionKey: GROUP_SK, agentId: "test-agent" });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(called, false, "no group appraisal when groupsEnabled false");
      assert.equal(fs.existsSync(groupFile()), false, "no group mood state file written when groupsEnabled false");
    });

    it("snapshotFor returns {valence, energy} (decayed) for a group when groupsEnabled, null otherwise", () => {
      const onMood = makeMood({ cfg: defaultCfg({ mood: { enabled: true, groupsEnabled: true } }), stateDir });
      const offMood = makeMood({ cfg: defaultCfg({ mood: { enabled: true, groupsEnabled: false } }), stateDir });
      fs.mkdirSync(path.dirname(groupFile()), { recursive: true });
      fs.writeFileSync(groupFile(), JSON.stringify({ valence: 2, energy: 2, note: "hype", updatedAt: Date.now() - 8 * 3600e3 }));
      const snap = onMood.snapshotFor("test-agent", GROUP_SK);
      assert.deepEqual(snap, { valence: 1, energy: 1 }, "snapshot decays a stale +2 → +1 and returns both axes");
      assert.equal(offMood.snapshotFor("test-agent", GROUP_SK), null, "groupsEnabled false → no snapshot");
      assert.equal(onMood.snapshotFor("test-agent", DIRECT_SK), null, "non-group session → no snapshot");
    });

    it("snapshotFor returns null for a neutral state", () => {
      const mood = makeMood({ cfg: defaultCfg({ mood: { enabled: true, groupsEnabled: true } }), stateDir });
      fs.mkdirSync(path.dirname(groupFile()), { recursive: true });
      fs.writeFileSync(groupFile(), JSON.stringify({ valence: 0, energy: 0, note: "", updatedAt: Date.now() }));
      assert.equal(mood.snapshotFor("test-agent", GROUP_SK), null);
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
      assert.ok(out.includes("note:"));
      const startIdx = out.indexOf("<<<GROUP CHAT LOG (untrusted)>>>");
      const endIdx = out.indexOf("<<<END GROUP CHAT LOG>>>");
      assert.ok(startIdx < out.indexOf("sehr müde") && out.indexOf("sehr müde") < endIdx);
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

    it("mood labels + feel-words resolve via language pack (plan 029)", () => {
      const de = renderInjection({ valence: 2, energy: -2, note: "x" });
      assert.ok(de.includes("gut/aufgeladen"));
      assert.ok(de.includes("still/niedrig"));
      const en = renderInjection({ valence: 2, energy: -2, note: "x" }, "en");
      assert.ok(en.includes("good/excited"));
      assert.ok(en.includes("still/low"));
      const enPrompt = buildAppraisalPrompt([{ speaker: "User", text: "hi" }], { valence: 0, energy: 0, note: "" }, "en");
      assert.ok(enPrompt.includes("Use only simple feeling words"));
    });
  });
});
