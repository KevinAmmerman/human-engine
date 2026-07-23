import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLocalEngine, getState } from "../lib/local-engine.js";

const VALID_LLM_RESPONSE = JSON.stringify({
  summary: "Casual German tech group",
  register: { formality: 3, warmth: 6, casing: "lowercase" },
  style: { length: "short", formatting: "clean", emoji: "few" },
  lexicon: ["ja genau", "halt", "ne"],
  banned_phrases: ["friendly reminder"],
  humor: "dry",
  norms: ["direct replies", "react first"],
  in_jokes: ["the coffee machine"],
});

function makeTiming() {
  return {
    scheduleForBubbles(bubbles, ctx, timingCfg) {
      return bubbles.map((b, i) => ({ content: b.content, position: i, delayMs: (i + 1) * 10 }));
    },
  };
}

function transcriptFrom(lines) {
  return lines.map((l, i) => {
    const m = l.match(/^\[([^\]]+)\]\s*(.*)$/);
    return { id: String(i), speaker: m ? m[1] : "User", text: m ? m[2] : l };
  });
}

describe("voice-card-local", () => {
  let tmpDir;
  let stateDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-local-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    getState().epochs.clear();
  });

  it("extractVoiceCard returns prompt_block and profile on valid LLM output", async () => {
    const engine = createLocalEngine({
      cfg: {},
      llm: {
        complete: async () => ({ text: VALID_LLM_RESPONSE }),
      },
      timing: makeTiming(),
    });

    const transcript = transcriptFrom([
      "[Alice] moin",
      "[Bob] ja genau",
      "[Carol] halt mal",
    ]);

    const result = await engine.extractVoiceCard({ transcript });
    assert.ok(result !== null);
    assert.ok(typeof result.prompt_block === "string");
    assert.ok(result.prompt_block.includes("Casual German tech group"));
    assert.ok(result.prompt_block.includes("lowercase"));
    assert.ok(result.profile.summary === "Casual German tech group");
  });

  it("extractVoiceCard returns null on empty transcript", async () => {
    const engine = createLocalEngine({
      cfg: {},
      llm: { complete: async () => ({ text: VALID_LLM_RESPONSE }) },
      timing: makeTiming(),
    });

    const result = await engine.extractVoiceCard({ transcript: [] });
    assert.equal(result, null);
  });

  it("extractVoiceCard returns null on null llm", async () => {
    const engine = createLocalEngine({
      cfg: {},
      llm: null,
      timing: makeTiming(),
    });

    const transcript = transcriptFrom(["[A] hi"]);
    const result = await engine.extractVoiceCard({ transcript });
    assert.equal(result, null);
  });

  it("extractVoiceCard returns null on garbage JSON", async () => {
    const engine = createLocalEngine({
      cfg: {},
      llm: {
        complete: async () => ({ text: "not valid json at all" }),
      },
      timing: makeTiming(),
    });

    const transcript = transcriptFrom(["[A] hi"]);
    const result = await engine.extractVoiceCard({ transcript });
    assert.equal(result, null);
  });

  it("extractVoiceCard returns null on incomplete JSON (missing summary)", async () => {
    const engine = createLocalEngine({
      cfg: {},
      llm: {
        complete: async () => ({ text: '{"register": {"formality": 5}}' }),
      },
      timing: makeTiming(),
    });

    const transcript = transcriptFrom(["[A] hi"]);
    const result = await engine.extractVoiceCard({ transcript });
    assert.equal(result, null);
  });

  it("extractVoiceCard recovers valid JSON from noisy output", async () => {
    const engine = createLocalEngine({
      cfg: {},
      llm: {
        complete: async () => ({
          text: "Here's the analysis:\n\n" + VALID_LLM_RESPONSE + "\n\nHope this helps!",
        }),
      },
      timing: makeTiming(),
    });

    const transcript = transcriptFrom(["[A] moin", "[B] ja"]);
    const result = await engine.extractVoiceCard({ transcript });
    assert.ok(result !== null);
    assert.ok(result.prompt_block.includes("Casual German tech group"));
  });

  it("extractVoiceCard handles LLM error gracefully", async () => {
    const engine = createLocalEngine({
      cfg: {},
      llm: {
        complete: async () => { throw new Error("LLM unavailable"); },
      },
      timing: makeTiming(),
    });

    const transcript = transcriptFrom(["[A] hi"]);
    const result = await engine.extractVoiceCard({ transcript });
    assert.equal(result, null);
  });

  it("createVoiceCard caches the prompt_block from extractVoiceCard", async () => {
    let callCount = 0;
    const engine = createLocalEngine({
      cfg: {},
      llm: {
        complete: async () => {
          callCount++;
          return { text: VALID_LLM_RESPONSE };
        },
      },
      timing: makeTiming(),
    });

    const vc = await import("../lib/voice-card.js");
    Object.keys(vc.cache).forEach((k) => delete vc.cache[k]);
    vc.refreshing.clear();
    Object.keys(vc.counter).forEach((k) => delete vc.counter[k]);

    const { onBeforePromptBuild } = vc.createVoiceCard({
      cfg: { socialLearning: {} },
      engine,
      stateDir,
      log: { info() {} },
    });

    const event = { messages: [{ role: "user", content: "[A] moin" }] };
    const ctx = { sessionKey: "sk-test" };

    onBeforePromptBuild(event, ctx);

    await new Promise((r) => setTimeout(r, 50));

    const result = onBeforePromptBuild(event, ctx);
    assert.ok(result !== undefined);
    assert.ok(result.appendSystemContext !== undefined);
    assert.ok(result.appendSystemContext.includes("Casual German tech group"));
  });
});
