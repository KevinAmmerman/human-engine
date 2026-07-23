import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { seedBody, personaText, enhanceAndWrite, maybeAutoEnhance } from "../lib/soul.js";

const TEMPLATE = `# Hermes Agent Persona

<!--
This file defines the agent's personality and tone.
  - "You are a warm, playful assistant."
-->
`;

const REAL = `# Hermes Agent Persona

<!-- edit me -->

You are a concise technical expert. No fluff, just facts.
`;

function makeEngine(result) {
  return {
    async enhancePersona({ persona }) {
      if (result === null) return null;
      if (result instanceof Error) throw result;
      return result || { system_prompt: "Enhanced: " + persona.slice(0, 50) + "..." };
    },
  };
}

describe("soul", () => {
  describe("seedBody", () => {
    it("template has no seed", () => {
      assert.equal(seedBody(TEMPLATE), "");
    });

    it("real persona is a seed", () => {
      assert.ok(seedBody(REAL).includes("concise technical expert"));
    });

    it("returns empty for empty input", () => {
      assert.equal(seedBody(""), "");
    });

    it("strips HTML comments and heading lines", () => {
      const result = seedBody(REAL);
      assert.ok(!result.includes("edit me"));
      assert.ok(!result.includes("# "));
      assert.ok(result.includes("concise technical expert"));
    });
  });

  describe("personaText", () => {
    it("drops comments but keeps headings", () => {
      const sent = personaText(REAL);
      assert.ok(!sent.includes("edit me"));
      assert.ok(sent.includes("concise technical expert"));
      assert.ok(sent.includes("Hermes Agent Persona"));
    });

    it("returns empty for empty input", () => {
      assert.equal(personaText(""), "");
    });
  });

  describe("enhanceAndWrite", () => {
    it("returns no-seed message when SOUL.md is template-only", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-"));
      const soulPath = path.join(tmpDir, "SOUL.md");
      fs.writeFileSync(soulPath, TEMPLATE);
      try {
        const cfg = { soulPath };
        const engine = makeEngine({ system_prompt: "test" });
        const reply = await enhanceAndWrite(cfg, engine);
        assert.ok(reply.includes("no persona to enhance"));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns no-seed when SOUL.md does not exist", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-"));
      try {
        const cfg = { soulPath: path.join(tmpDir, "nonexistent.md") };
        const engine = makeEngine({ system_prompt: "test" });
        const reply = await enhanceAndWrite(cfg, engine);
        assert.ok(reply.includes("no persona to enhance"));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("enhances, creates backup, writes new content", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-"));
      const soulPath = path.join(tmpDir, "SOUL.md");
      fs.writeFileSync(soulPath, REAL);
      try {
        const cfg = { soulPath };
        const engine = makeEngine({ system_prompt: "Enhanced persona text." });
        const reply = await enhanceAndWrite(cfg, engine);
        assert.ok(reply.includes("Enhanced your persona"));
        assert.ok(reply.includes("\u2192"));
        assert.ok(reply.includes(".bak"));
        assert.ok(fs.existsSync(soulPath + ".bak"));
        assert.equal(fs.readFileSync(soulPath + ".bak", "utf8"), REAL);
        assert.equal(fs.readFileSync(soulPath, "utf8"), "Enhanced persona text.\n");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns warning when engine returns null", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-"));
      const soulPath = path.join(tmpDir, "SOUL.md");
      fs.writeFileSync(soulPath, REAL);
      try {
        const cfg = { soulPath };
        const engine = makeEngine(null);
        const reply = await enhanceAndWrite(cfg, engine);
        assert.ok(reply.includes("Couldn\u2019t reach"));
        assert.equal(fs.readFileSync(soulPath, "utf8"), REAL);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("maybeAutoEnhance", () => {
    it("does nothing when soulAutoEnhance is false", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-"));
      const soulPath = path.join(tmpDir, "SOUL.md");
      const markerPath = path.join(tmpDir, ".soul_auto_enhanced");
      try {
        const cfg = { soulPath, soulAutoEnhance: false };
        const engine = makeEngine({ system_prompt: "test" });
        maybeAutoEnhance(cfg, engine);
        assert.ok(!fs.existsSync(soulPath));
        assert.ok(!fs.existsSync(markerPath));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("does nothing when marker already exists", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-"));
      const markerPath = path.join(tmpDir, ".soul_auto_enhanced");
      const soulPath = path.join(tmpDir, "SOUL.md");
      fs.writeFileSync(markerPath, "");
      try {
        const cfg = { soulPath, soulAutoEnhance: true };
        const engine = makeEngine(null);
        maybeAutoEnhance(cfg, engine);
        assert.ok(!fs.existsSync(soulPath));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
