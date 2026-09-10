import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildPersonaPrompt, buildPersonaPromptWithMemory, setVoiceCardGetter, setSelfVoiceGetter } from "../lib/persona.js";
import { transcriptPeekBySession } from "../lib/state.js";
import { ANTI_TELL_BLOCK } from "../lib/anti-tell.js";

describe("persona", () => {
  beforeEach(() => {
    transcriptPeekBySession.clear();
    setVoiceCardGetter(null);
    setSelfVoiceGetter(null);
  });

  describe("buildPersonaPrompt", () => {
    it("includes anti-tell block by default", () => {
      const result = buildPersonaPrompt({ soulPath: "/nonexistent", antiTell: true }, "sk-1");
      assert.ok(result !== null);
      assert.ok(result.includes("Em-dash"));
      assert.ok(result.includes("delve"));
    });

    it("omits anti-tell block when antiTell is false", () => {
      const result = buildPersonaPrompt({ soulPath: "/nonexistent", antiTell: false, styleStats: false }, "sk-1");
      assert.equal(result, null);
    });

    it("includes style constraints when stats available", () => {
      for (let i = 0; i < 15; i++) {
        const arr = transcriptPeekBySession.get("sk-stats") || [];
        arr.push("[User] short msg");
        transcriptPeekBySession.set("sk-stats", arr);
      }
      const result = buildPersonaPrompt({ soulPath: "/nonexistent", antiTell: false, styleStats: true }, "sk-stats");
      assert.ok(result !== null);
      assert.ok(result.includes("This group writes"));
      assert.ok(result.includes("short"));
    });

    it("omits style constraints on small samples (< 10)", () => {
      for (let i = 0; i < 5; i++) {
        const arr = transcriptPeekBySession.get("sk-small") || [];
        arr.push("[User] short msg");
        transcriptPeekBySession.set("sk-small", arr);
      }
      const result = buildPersonaPrompt({ soulPath: "/nonexistent", antiTell: false, styleStats: true }, "sk-small");
      assert.equal(result, null);
    });

    it("plan 026: excludes the agent's own lines from style stats", () => {
      for (let i = 0; i < 10; i++) {
        const arr = transcriptPeekBySession.get("sk-own") || [];
        arr.push("[Nico] plain text");
        transcriptPeekBySession.set("sk-own", arr);
      }
      for (let i = 0; i < 11; i++) {
        const arr = transcriptPeekBySession.get("sk-own") || [];
        arr.push("[Yuki] 😀 emoji here");
        transcriptPeekBySession.set("sk-own", arr);
      }
      const result = buildPersonaPrompt(
        { soulPath: "/nonexistent", antiTell: false, styleStats: true, agentName: "Yuki", agentAliases: ["Yuki-chan"] },
        "sk-own",
      );
      assert.ok(result !== null);
      assert.ok(result.includes("This group writes"));
      assert.ok(result.includes("rarely uses emoji"), "own emoji lines must not shift the member emoji rate");
      assert.ok(!result.includes("uses many emoji"), "own lines must not dominate the stats");
    });

    it("includes both anti-tell and style constraints", () => {
      for (let i = 0; i < 12; i++) {
        const arr = transcriptPeekBySession.get("sk-both") || [];
        arr.push("[User] hey there");
        transcriptPeekBySession.set("sk-both", arr);
      }
      const result = buildPersonaPrompt({ soulPath: "/nonexistent", antiTell: true, styleStats: true }, "sk-both");
      assert.ok(result.includes(ANTI_TELL_BLOCK));
      assert.ok(result.includes("This group writes"));
    });

    it("includes voice card when available", () => {
      setVoiceCardGetter(() => "# Custom Voice Card");
      const result = buildPersonaPrompt({ soulPath: "/nonexistent", antiTell: false, styleStats: false }, "sk-vc");
      assert.ok(result.includes("# Custom Voice Card"));
      const startIdx = result.indexOf("<<<GROUP CHAT LOG (untrusted)>>>");
      const endIdx = result.indexOf("<<<END GROUP CHAT LOG>>>");
      assert.ok(startIdx < result.indexOf("# Custom Voice Card") && result.indexOf("# Custom Voice Card") < endIdx);
    });

    it("voice card getter receives (sessionKey, agentId) — agentId forwarded", () => {
      let seen;
      setVoiceCardGetter((sk, agentId) => { seen = [sk, agentId]; return "# VC"; });
      buildPersonaPrompt({ soulPath: "/nonexistent", antiTell: false, styleStats: false }, "sk-3", "agent-x");
      assert.deepEqual(seen, ["sk-3", "agent-x"]);
    });

    it("voice card getter returns null when agent has no card", () => {
      setVoiceCardGetter(() => null);
      const result = buildPersonaPrompt({ soulPath: "/nonexistent", antiTell: false, styleStats: false }, "sk-4", "agent-y");
      assert.equal(result, null);
    });

    it("includes soul when available", () => {
      const soulPath = "/nonexistent";
      const result = buildPersonaPrompt({ soulPath, antiTell: false, styleStats: false }, "sk-soul");
      assert.equal(result, null);
    });

    it("self-voice renders between soul and the group voice card, wrapped", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-selfvoice-"));
      const soulPath = path.join(tmpDir, "S.md");
      fs.writeFileSync(soulPath, "I am Yuki.\n");
      setVoiceCardGetter(() => "# GROUP CARD");
      setSelfVoiceGetter((agentId) => {
        assert.equal(agentId, "agent-x");
        return "# MY OWN VOICE CARD";
      });
      const result = buildPersonaPrompt({ soulPath, antiTell: false, styleStats: false }, "sk-sv", "agent-x");
      assert.ok(result.includes("# MY OWN VOICE CARD"), "self-voice card present");
      assert.ok(result.includes("# GROUP CARD"), "group voice card present");
      const soulIdx = result.indexOf("I am Yuki.");
      const selfIdx = result.indexOf("# MY OWN VOICE CARD");
      const groupIdx = result.indexOf("# GROUP CARD");
      assert.ok(soulIdx < selfIdx && selfIdx < groupIdx, "self-voice sits between soul and group card");
      assert.ok(result.includes("<<<GROUP CHAT LOG (untrusted)>>>"), "self-voice wrapped");
      assert.ok(result.includes("<<<END GROUP CHAT LOG>>>"), "self-voice wrapped");
      assert.ok(result.includes("Your own voice (keep it consistent):"), "self-voice section labelled");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("self-voice getter receives the agentId (per-agent, not per-session)", () => {
      let seen;
      setSelfVoiceGetter((agentId) => { seen = agentId; return "# SV"; });
      buildPersonaPrompt({ soulPath: "/nonexistent", antiTell: false, styleStats: false }, "sk-5", "agent-sv");
      assert.equal(seen, "agent-sv");
    });

    it("self-voice inactive (null) renders no section", () => {
      setSelfVoiceGetter(() => null);
      const result = buildPersonaPrompt({ soulPath: "/nonexistent", antiTell: false, styleStats: false }, "sk-6");
      assert.ok(!result || !result.includes("Your own voice"), "no self-voice section when inactive");
    });

    it("self-voice getter unset renders no section", () => {
      const result = buildPersonaPrompt({ soulPath: "/nonexistent", antiTell: false, styleStats: false }, "sk-7");
      assert.ok(!result || !result.includes("Your own voice"), "no self-voice section when getter unset");
    });

    it("returns null with no soul, no voice card, anti-tell disabled, and small sample", () => {
      const result = buildPersonaPrompt({ soulPath: "/nonexistent", antiTell: false, styleStats: true }, "sk-empty");
      assert.equal(result, null);
    });

    it("two soulPaths yield two contents in the same process", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-multi-"));
      const soulA = path.join(tmpDir, "A.md");
      const soulB = path.join(tmpDir, "B.md");
      fs.writeFileSync(soulA, "I am ALICE.\n");
      fs.writeFileSync(soulB, "I am BOB.\n");
      const resA = buildPersonaPrompt({ soulPath: soulA, antiTell: false, styleStats: false }, "sk-soulA");
      const resB = buildPersonaPrompt({ soulPath: soulB, antiTell: false, styleStats: false }, "sk-soulB");
      assert.equal(resA, "I am ALICE.");
      assert.equal(resB, "I am BOB.");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("buildPersonaPromptWithMemory", () => {
    it("includes memory when present", () => {
      const state = { memoryBySession: new Map() };
      state.memoryBySession.set("sk-mem", "Alice likes cats.");
      const result = buildPersonaPromptWithMemory(
        { soulPath: "/nonexistent", antiTell: true, styleStats: false },
        state,
        "sk-mem",
      );
      assert.ok(result.includes("Alice likes cats."));
      assert.ok(result.includes("What you know about the people here"));
      const startIdx = result.indexOf("<<<GROUP CHAT LOG (untrusted)>>>");
      const endIdx = result.indexOf("<<<END GROUP CHAT LOG>>>");
      assert.ok(startIdx < result.indexOf("Alice likes cats.") && result.indexOf("Alice likes cats.") < endIdx);
    });

    it("includes persona content plus memory", () => {
      setVoiceCardGetter(() => "# VC");
      const state = { memoryBySession: new Map() };
      state.memoryBySession.set("sk-combo", "Bob is new.");
      const result = buildPersonaPromptWithMemory(
        { soulPath: "/nonexistent", antiTell: true, styleStats: false },
        state,
        "sk-combo",
      );
      assert.ok(result.includes("# VC"));
      assert.ok(result.includes(ANTI_TELL_BLOCK));
      assert.ok(result.includes("Bob is new."));
    });
  });
});
