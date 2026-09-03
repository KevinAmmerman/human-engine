import assert from "node:assert/strict";
import { describe, it, beforeEach, mock } from "node:test";
import { createLocalEngine, getState, hasHardTrigger } from "../lib/local-engine.js";
import { findAgentContactIds } from "../lib/contacts.js";

function makeTiming() {
  return {
    scheduleForBubbles(bubbles, ctx, timingCfg) {
      return bubbles.map((b, i) => ({
        content: b.content,
        position: i,
        delayMs: (i + 1) * 10,
      }));
    },
  };
}

describe("local-engine", () => {
  beforeEach(() => {
    getState().epochs.clear();
  });

  describe("decide — short circuits", () => {
    it("DM always speaks with zero LLM calls", async () => {
      let llmCalled = false;
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { llmCalled = true; return { text: "STAY_SILENT" }; } },
        timing: makeTiming(),
      });
      const res = await engine.decide({ sessionKey: "s1", isDM: true });
      assert.deepEqual(res.decision, "speak");
      assert.ok(res.epoch > 0);
      assert.equal(llmCalled, false);
    });

    it("DM + media always speaks with zero LLM calls", async () => {
      let llmCalled = false;
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { llmCalled = true; return { text: "STAY_SILENT" }; } },
        timing: makeTiming(),
      });
      const res = await engine.decide({ sessionKey: "s2", isDM: true, hasMedia: true });
      assert.deepEqual(res.decision, "speak");
      assert.equal(llmCalled, false);
    });

    it("group + media NO LONGER auto-speaks (falls to LLM decide)", async () => {
      let llmCalled = false;
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { llmCalled = true; return { text: "STAY_SILENT" }; } },
        timing: makeTiming(),
      });
      const res = await engine.decide({ sessionKey: "s2b", isDM: false, hasMedia: true });
      assert.equal(llmCalled, true, "group media should reach the LLM decide");
      assert.equal(res.decision, "stay_silent");
      assert.equal(res.path, "llm");
    });

    it("hard trigger (agent name) speaks with zero LLM calls", async () => {
      let llmCalled = false;
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { llmCalled = true; return { text: "STAY_SILENT" }; } },
        timing: makeTiming(),
      });
      const res = await engine.decide({
        sessionKey: "s3",
        prompt: "OpenClaw, what do you think?",
        agentName: "OpenClaw",
      });
      assert.deepEqual(res.decision, "speak");
      assert.equal(llmCalled, false);
    });

    it("question to another member goes to LLM (no short-circuit)", async () => {
      let llmCalled = false;
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { llmCalled = true; return { text: "STAY_SILENT" }; } },
        timing: makeTiming(),
      });
      const res = await engine.decide({
        sessionKey: "s4",
        messages: [{ text: "Bob, what do you think?" }],
        agentName: "OpenClaw",
      });
      assert.equal(llmCalled, true);
      assert.deepEqual(res.decision, "stay_silent");
    });
  });

  describe("decide — hard trigger semantics", () => {
    it("lid @mention mapped to the agent triggers with zero LLM calls", async () => {
      let llmCalled = false;
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { llmCalled = true; return { text: "STAY_SILENT" }; } },
        timing: makeTiming(),
      });
      const res = await engine.decide({
        sessionKey: "s20",
        prompt: "@81000000000001 wie lang brauchen wir zum einstieg?",
        agentName: "Hori",
        agentContactIds: new Set(["81000000000001"]),
      });
      assert.deepEqual(res.decision, "speak");
      assert.equal(res.path, "hard");
      assert.equal(llmCalled, false);
    });

    it("URL with agent name in hostname does NOT hard-trigger", async () => {
      let llmCalled = false;
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { llmCalled = true; return { text: "STAY_SILENT" }; } },
        timing: makeTiming(),
      });
      const res = await engine.decide({
        sessionKey: "s21",
        prompt: "route plan on https://openclawhori.tail24194c.ts.net/route",
        agentName: "Hori",
      });
      assert.equal(llmCalled, true, "URL false-positive must not short-circuit");
      assert.deepEqual(res.decision, "stay_silent");
    });

    it("mid-word name substring does NOT hard-trigger", async () => {
      assert.equal(hasHardTrigger("Der Horizont ist toll", [], "Hori"), false);
    });

    it("word-boundary name match DOES hard-trigger", async () => {
      assert.equal(hasHardTrigger("Hori, was meinst du?", [], "Hori"), true);
      assert.equal(hasHardTrigger("OpenClaw, was denkst du?", [], "OpenClaw"), true);
    });

    it("word-boundary Yuki match fires", async () => {
      assert.equal(hasHardTrigger("Yuki, was meinst du?", [], "Yuki"), true);
    });

    it("alias name fires when provided", async () => {
      assert.equal(hasHardTrigger("Hori, was meinst du?", [], "Yuki", undefined, ["Hori"]), true);
      assert.equal(hasHardTrigger("Hori, was meinst du?", [], "Yuki"), false, "without alias, Hori must not fire");
    });

    it("@digits mention fires only when agentContactIds contains those digits", async () => {
      const map = new Map([["81000000000001", "Yuki (Bot)"]]);
      const ids = findAgentContactIds(map, "Yuki");
      assert.equal(ids.has("81000000000001"), true);
      assert.equal(hasHardTrigger("@81000000000001 hallo", [], "Yuki", ids), true);
      assert.equal(hasHardTrigger("@81000000000099 hallo", [], "Yuki", ids), false, "unmapped id must not fire");
    });

    it("lid mention with unmapped id does not trigger", async () => {
      assert.equal(hasHardTrigger("@81000000000002 hallo", [], "Hori", new Set(["81000000000001"])), false);
    });
  });

  describe("decide — reply-to-agent hard trigger", () => {
    it("replyToAgent:true speaks with zero LLM calls and path=reply", async () => {
      let llmCalled = false;
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { llmCalled = true; return { text: "STAY_SILENT" }; } },
        timing: makeTiming(),
      });
      const res = await engine.decide({
        sessionKey: "r1",
        prompt: "unrelated text",
        agentName: "OpenClaw",
        replyToAgent: true,
      });
      assert.deepEqual(res.decision, "speak");
      assert.equal(res.path, "reply");
      assert.ok(res.epoch > 0, "reply speak bumps the epoch");
      assert.equal(llmCalled, false);
    });

    it("replyToAgent false/absent leaves the LLM path unchanged", async () => {
      let llmCalled = false;
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { llmCalled = true; return { text: "STAY_SILENT" }; } },
        timing: makeTiming(),
      });
      const res = await engine.decide({
        sessionKey: "r2",
        prompt: "unrelated text",
        agentName: "OpenClaw",
        replyToAgent: false,
      });
      assert.equal(llmCalled, true);
      assert.deepEqual(res.decision, "stay_silent");

      llmCalled = false;
      const resAbsent = await engine.decide({
        sessionKey: "r3",
        prompt: "unrelated text",
        agentName: "OpenClaw",
      });
      assert.equal(llmCalled, true);
      assert.deepEqual(resAbsent.decision, "stay_silent");
    });
  });

  describe("decide — LLM path", () => {
    it("SPEAK from LLM returns speak decision", async () => {
      const engine = createLocalEngine({
        cfg: { decide: { temperature: 0.2 } },
        llm: { complete: async () => ({ text: "SPEAK" }) },
        timing: makeTiming(),
      });
      const res = await engine.decide({ sessionKey: "s5", prompt: "Hello" });
      assert.deepEqual(res.decision, "speak");
    });

    it("STAY_SILENT from LLM returns stay_silent", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "STAY_SILENT" }) },
        timing: makeTiming(),
      });
      const res = await engine.decide({ sessionKey: "s6", prompt: "Hello" });
      assert.deepEqual(res.decision, "stay_silent");
    });

    it("garbage LLM output → stay_silent", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "I'm not sure what to say here" }) },
        timing: makeTiming(),
      });
      const res = await engine.decide({ sessionKey: "s7", prompt: "Hello" });
      assert.deepEqual(res.decision, "stay_silent");
    });

    it("LLM error returns null", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { throw new Error("LLM down"); } },
        timing: makeTiming(),
      });
      const res = await engine.decide({ sessionKey: "s8", prompt: "Hello" });
      assert.equal(res, null);
    });

    it("null LLM returns null", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: null,
        timing: makeTiming(),
      });
      const res = await engine.decide({ sessionKey: "s9", prompt: "Hello" });
      assert.equal(res, null);
    });
  });

  describe("decide — path field", () => {
    it("returns path=dm for DM short-circuit", async () => {
      const engine = createLocalEngine({ cfg: {}, llm: null, timing: makeTiming() });
      const res = await engine.decide({ sessionKey: "p1", isDM: true });
      assert.equal(res.path, "dm");
    });

    it("returns path=dm for DM media short-circuit", async () => {
      const engine = createLocalEngine({ cfg: {}, llm: null, timing: makeTiming() });
      const res = await engine.decide({ sessionKey: "p2", isDM: true, hasMedia: true });
      assert.equal(res.path, "dm");
    });

    it("group media does not short-circuit to path=media", async () => {
      const engine = createLocalEngine({ cfg: {}, llm: null, timing: makeTiming() });
      const res = await engine.decide({ sessionKey: "p2g", isDM: false, hasMedia: true });
      assert.equal(res, null, "group media with no LLM yields null, not a media auto-speak");
    });

    it("returns path=hard for hard trigger", async () => {
      const engine = createLocalEngine({ cfg: {}, llm: null, timing: makeTiming() });
      const res = await engine.decide({ sessionKey: "p3", prompt: "OpenClaw?", agentName: "OpenClaw" });
      assert.equal(res.path, "hard");
    });

    it("returns path=llm when the LLM decides", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "SPEAK" }) },
        timing: makeTiming(),
      });
      const res = await engine.decide({ sessionKey: "p4", prompt: "Hello" });
      assert.equal(res.path, "llm");
    });

    it("returns null (no path) when LLM is absent", async () => {
      const engine = createLocalEngine({ cfg: {}, llm: null, timing: makeTiming() });
      const res = await engine.decide({ sessionKey: "p5", prompt: "Hello" });
      assert.equal(res, null);
    });
  });

  describe("epoch", () => {
    it("increments epoch on each speak decide", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "SPEAK" }) },
        timing: makeTiming(),
      });
      const r1 = await engine.decide({ sessionKey: "s10", prompt: "a" });
      const r2 = await engine.decide({ sessionKey: "s10", prompt: "b" });
      assert.equal(r2.epoch, r1.epoch + 1);
    });

    it("stay_silent does not bump the epoch", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "STAY_SILENT" }) },
        timing: makeTiming(),
      });
      const speak = await engine.decide({ sessionKey: "s10b", prompt: "OpenClaw?", agentName: "OpenClaw" });
      assert.equal(speak.epoch, 1);
      const silent = await engine.decide({ sessionKey: "s10b", prompt: "unrelated" });
      assert.equal(silent.decision, "stay_silent");
      assert.equal(silent.epoch, speak.epoch, "stay_silent must keep the epoch unchanged");
    });

    it("currentEpoch returns 0 for unknown session", () => {
      const engine = createLocalEngine({ cfg: {}, llm: null, timing: makeTiming() });
      assert.equal(engine.currentEpoch("nonexistent"), 0);
    });

    it("currentEpoch returns latest epoch", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "SPEAK" }) },
        timing: makeTiming(),
      });
      await engine.decide({ sessionKey: "s11", prompt: "x" });
      assert.equal(engine.currentEpoch("s11"), 1);
    });
  });

  describe("respond", () => {
    it("supersedes when epoch is stale", async () => {
      const engine = createLocalEngine({ cfg: {}, llm: null, timing: makeTiming() });
      const d1 = await engine.decide({ sessionKey: "s12", isDM: true });
      const res = await engine.respond({ sessionKey: "s12", draft: "Hi", epoch: d1.epoch });
      assert.equal(res.superseded, false);
      const d2 = await engine.decide({ sessionKey: "s12", isDM: true });
      const res2 = await engine.respond({ sessionKey: "s12", draft: "Hi", epoch: d1.epoch });
      assert.equal(res2.superseded, true);
    });

    it("returns scheduled with draft fallback when llm is null", async () => {
      const engine = createLocalEngine({ cfg: {}, llm: null, timing: makeTiming() });
      const res = await engine.respond({ sessionKey: "s13", draft: "Hello world", epoch: 0 });
      assert.equal(res.superseded, false);
      assert.ok(Array.isArray(res.scheduled));
      assert.equal(res.scheduled.length, 1);
      assert.equal(res.scheduled[0].content, "Hello world");
    });

    it("uses LLM split result when available", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: {
          complete: async () => ({ text: '{"messages": ["Bubble one", "Bubble two"]}' }),
        },
        timing: makeTiming(),
      });
      const res = await engine.respond({ sessionKey: "s14", draft: "Hello", epoch: 1 });
      assert.equal(res.superseded, false);
      assert.ok(Array.isArray(res.scheduled));
      assert.equal(res.scheduled.length, 2);
    });

    it("LLM error returns draft fallback", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { throw new Error("crash"); } },
        timing: makeTiming(),
      });
      const res = await engine.respond({ sessionKey: "s15", draft: "Fallback", epoch: 1 });
      assert.equal(res.superseded, false);
      assert.equal(res.scheduled[0].content, "Fallback");
    });

    it("invalid JSON from LLM returns draft fallback", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "not valid json at all" }) },
        timing: makeTiming(),
      });
      const res = await engine.respond({ sessionKey: "s16", draft: "Fallback json", epoch: 1 });
      assert.equal(res.superseded, false);
      assert.equal(res.scheduled[0].content, "Fallback json");
    });

    it("empty messages array from LLM returns draft fallback", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: '{"messages": []}' }) },
        timing: makeTiming(),
      });
      const res = await engine.respond({ sessionKey: "s17", draft: "Empty fallback", epoch: 1 });
      assert.equal(res.superseded, false);
      assert.equal(res.scheduled[0].content, "Empty fallback");
    });

    it("bubbles capped at maxBubbles", async () => {
      const engine = createLocalEngine({
        cfg: { humanize: { maxBubbles: 2 } },
        llm: {
          complete: async () => ({ text: '{"messages": ["a", "b", "c", "d"]}' }),
        },
        timing: makeTiming(),
      });
      const res = await engine.respond({ sessionKey: "s18", draft: "test", epoch: 1 });
      assert.equal(res.superseded, false);
      assert.ok(res.scheduled.length <= 2);
    });

    it("timing attached to scheduled result", async () => {
      const engine = createLocalEngine({
        cfg: { timing: { typingWpm: 40 } },
        llm: {
          complete: async () => ({ text: '{"messages": ["One", "Two"]}' }),
        },
        timing: makeTiming(),
      });
      const res = await engine.respond({ sessionKey: "s19", draft: "Hi", epoch: 1 });
      assert.ok(res.scheduled[0].delayMs > 0);
      assert.ok(res.scheduled[0].delayMs !== undefined);
    });
  });

  describe("regenerateReply (plan 347)", () => {
    it("returns { text } when llm produces a reply", async () => {
      let captured;
      const engine = createLocalEngine({
        cfg: {},
        llm: {
          complete: async (opts) => {
            captured = opts;
            return { text: "Der Fels ist nass, also lass uns morgen gehen." };
          },
        },
        timing: makeTiming(),
      });
      const res = await engine.regenerateReply({
        sessionKey: "s30",
        reasoning: "Nico is playfully blessing/worshipping me…",
        transcript: [{ speaker: "Nico", text: "Gepriesen seist du Hori" }],
        agentName: "Hori",
      });
      assert.deepEqual(res, { text: "Der Fels ist nass, also lass uns morgen gehen." });
      assert.equal(captured.messages[0].role, "system");
      assert.equal(captured.messages[1].role, "user");
      assert.equal(captured.purpose, "human-engine-regen");
    });

    it("returns null when no llm", async () => {
      const engine = createLocalEngine({ cfg: {}, llm: null, timing: makeTiming() });
      const res = await engine.regenerateReply({ sessionKey: "s31", reasoning: "x" });
      assert.equal(res, null);
    });

    it("returns null when llm returns empty text", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => ({ text: "   " }) },
        timing: makeTiming(),
      });
      const res = await engine.regenerateReply({ sessionKey: "s32", reasoning: "x" });
      assert.equal(res, null);
    });

    it("returns null on llm error", async () => {
      const engine = createLocalEngine({
        cfg: {},
        llm: { complete: async () => { throw new Error("LLM down"); } },
        timing: makeTiming(),
      });
      const res = await engine.regenerateReply({ sessionKey: "s33", reasoning: "x" });
      assert.equal(res, null);
    });
  });
});
