import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildPersonaPrompt, buildPersonaPromptWithMemory, setVoiceCardGetter } from "../lib/persona.js";
import { transcriptPeekBySession } from "../lib/state.js";
import { ANTI_TELL_BLOCK } from "../lib/anti-tell.js";

describe("persona", () => {
  beforeEach(() => {
    transcriptPeekBySession.clear();
    setVoiceCardGetter(null);
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
