import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLocalEngine, getState } from "../lib/local-engine.js";
import { enhanceAndWrite, maybeAutoEnhance, seedBody, personaText } from "../lib/soul.js";

function makeTiming() {
  return {
    scheduleForBubbles(bubbles, ctx, timingCfg) {
      return bubbles.map((b, i) => ({ content: b.content, position: i, delayMs: (i + 1) * 10 }));
    },
  };
}

const REAL = `# Test Agent

<!-- seed -->

You are a concise technical expert.
`;

describe("soul-local", () => {
  beforeEach(() => {
    getState().epochs.clear();
  });

  it("seedBody and personaText still work", () => {
    assert.ok(seedBody(REAL).includes("concise technical expert"));
    assert.ok(personaText(REAL).includes("concise technical expert"));
  });

  it("enhanceAndWrite writes file and .bak on success", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-local-"));
    const soulPath = path.join(tmpDir, "SOUL.md");
    fs.writeFileSync(soulPath, REAL);

    try {
      const engine = createLocalEngine({
        cfg: {},
        llm: {
          complete: async () => ({ text: "Enhanced persona text." }),
        },
        timing: makeTiming(),
      });

      const reply = await enhanceAndWrite({ soulPath }, engine);
      assert.ok(reply.includes("Enhanced your persona"));
      assert.ok(reply.includes("\u2192"));
      assert.ok(reply.includes(".bak"));
      assert.ok(fs.existsSync(soulPath + ".bak"));
      assert.equal(fs.readFileSync(soulPath + ".bak", "utf8"), REAL);

      const written = fs.readFileSync(soulPath, "utf8");
      assert.ok(written.includes("concise technical expert"), "operator content survives");
      assert.ok(written.includes("Enhanced persona text."));
      assert.ok(written.includes("<!-- human-engine:persona:start -->"));
      assert.ok(written.includes("<!-- human-engine:persona:end -->"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("enhanceAndWrite returns warning when no seed", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-local-"));
    const soulPath = path.join(tmpDir, "SOUL.md");
    fs.writeFileSync(soulPath, "# Template Only\n\n<!-- nothing -->");

    try {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "enhanced" }) },
        timing: makeTiming(),
      });

      const reply = await enhanceAndWrite({ soulPath }, engine);
      assert.ok(reply.includes("no persona to enhance"));
      assert.ok(!fs.existsSync(soulPath + ".bak"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("enhanceAndWrite returns warning when file does not exist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-local-"));
    try {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "enhanced" }) },
        timing: makeTiming(),
      });

      const reply = await enhanceAndWrite({ soulPath: path.join(tmpDir, "nonexistent.md") }, engine);
      assert.ok(reply.includes("no persona to enhance"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("enhanceAndWrite returns warning when LLM returns null", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-local-"));
    const soulPath = path.join(tmpDir, "SOUL.md");
    fs.writeFileSync(soulPath, REAL);

    try {
      const engine = createLocalEngine({
        cfg: {},
        llm: {
          complete: async () => { throw new Error("LLM down"); },
        },
        timing: makeTiming(),
      });

      const reply = await enhanceAndWrite({ soulPath }, engine);
      assert.ok(reply.includes("Couldn\u2019t reach"));
      assert.equal(fs.readFileSync(soulPath, "utf8"), REAL);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("enhanceAndWrite returns warning when engine returns null (no llm)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-local-"));
    const soulPath = path.join(tmpDir, "SOUL.md");
    fs.writeFileSync(soulPath, REAL);

    try {
      const engine = createLocalEngine({
        cfg: {},
        llm: null,
        timing: makeTiming(),
      });

      const reply = await enhanceAndWrite({ soulPath }, engine);
      assert.ok(reply.includes("Couldn\u2019t reach"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("maybeAutoEnhance does nothing when disabled", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-local-"));
    const soulPath = path.join(tmpDir, "SOUL.md");
    const markerPath = path.join(tmpDir, ".soul_auto_enhanced");

    try {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "test" }) },
        timing: makeTiming(),
      });

      maybeAutoEnhance({ soulPath, soulAutoEnhance: false }, engine);
      assert.ok(!fs.existsSync(soulPath));
      assert.ok(!fs.existsSync(markerPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("maybeAutoEnhance does nothing when marker exists", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-local-"));
    const markerPath = path.join(tmpDir, ".soul_auto_enhanced");
    const soulPath = path.join(tmpDir, "SOUL.md");
    fs.writeFileSync(markerPath, "");

    try {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "test" }) },
        timing: makeTiming(),
      });

      maybeAutoEnhance({ soulPath, soulAutoEnhance: true }, engine);
      assert.ok(!fs.existsSync(soulPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
