import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { capMap, pushObserved, observedBySession, pushTranscriptPeek, transcriptPeekBySession, getTranscriptPeek } from "../lib/state.js";

describe("state", () => {
  beforeEach(() => {
    observedBySession.clear();
    transcriptPeekBySession.clear();
  });

  it("capMap does nothing when under limit", () => {
    const m = new Map();
    m.set("a", 1);
    m.set("b", 2);
    capMap(m, 10);
    assert.equal(m.size, 2);
  });

  it("capMap evicts FIFO when over limit", () => {
    const m = new Map();
    for (let i = 0; i < 10; i++) m.set(`k${i}`, i);
    capMap(m, 5);
    assert.equal(m.size, 5);
    assert.equal(m.has("k0"), false);
    assert.equal(m.has("k1"), false);
    assert.equal(m.has("k2"), false);
    assert.equal(m.has("k3"), false);
    assert.equal(m.has("k4"), false);
    assert.equal(m.has("k5"), true);
    assert.equal(m.has("k9"), true);
  });

  it("capMap evicts exactly the number over limit", () => {
    const m = new Map();
    for (let i = 0; i < 4098; i++) m.set(`k${i}`, i);
    capMap(m, 4096);
    assert.equal(m.size, 4096);
    assert.equal(m.has("k0"), false);
    assert.equal(m.has("k1"), false);
    assert.equal(m.has("k2"), true);
  });

  it("pushObserved creates array for new session", () => {
    pushObserved("test-session", "entry-1");
    assert.ok(Array.isArray(observedBySession.get("test-session")));
    assert.equal(observedBySession.get("test-session").length, 1);
  });

  it("pushObserved appends to existing array", () => {
    pushObserved("test-session-2", "a");
    pushObserved("test-session-2", "b");
    pushObserved("test-session-2", "c");
    assert.equal(observedBySession.get("test-session-2").length, 3);
    assert.deepEqual(observedBySession.get("test-session-2"), ["a", "b", "c"]);
  });

  it("pushObserved bounds at default max 100", () => {
    for (let i = 0; i < 150; i++) pushObserved("test-session-3", `entry-${i}`);
    assert.equal(observedBySession.get("test-session-3").length, 100);
    assert.equal(observedBySession.get("test-session-3")[0], "entry-50");
  });

  it("pushObserved bounds at custom max", () => {
    for (let i = 0; i < 20; i++) pushObserved("test-session-4", `x-${i}`, 10);
    assert.equal(observedBySession.get("test-session-4").length, 10);
    assert.equal(observedBySession.get("test-session-4")[0], "x-10");
  });

  it("pushObserved caps the observedBySession map at 4096 sessions", () => {
    for (let i = 0; i < 4100; i++) pushObserved(`cap-obs-${i}`, "entry");
    assert.ok(observedBySession.size <= 4096, `observedBySession.size=${observedBySession.size}`);
  });

  describe("transcriptPeekBySession", () => {
    it("pushTranscriptPeek creates array for new session", () => {
      pushTranscriptPeek("tp-session", "[User] hi");
      assert.ok(Array.isArray(transcriptPeekBySession.get("tp-session")));
      assert.equal(transcriptPeekBySession.get("tp-session").length, 1);
    });

    it("pushTranscriptPeek appends to existing array", () => {
      pushTranscriptPeek("tp-session-2", "[A] first");
      pushTranscriptPeek("tp-session-2", "[B] second");
      assert.equal(transcriptPeekBySession.get("tp-session-2").length, 2);
      assert.deepEqual(transcriptPeekBySession.get("tp-session-2"), ["[A] first", "[B] second"]);
    });

    it("pushTranscriptPeek bounds at default max 50", () => {
      for (let i = 0; i < 60; i++) pushTranscriptPeek("tp-session-3", `[User] msg ${i}`);
      assert.equal(transcriptPeekBySession.get("tp-session-3").length, 50);
      assert.equal(transcriptPeekBySession.get("tp-session-3")[0], "[User] msg 10");
    });

    it("pushTranscriptPeek caps the transcriptPeekBySession map at 4096 sessions", () => {
      for (let i = 0; i < 4100; i++) pushTranscriptPeek(`cap-tp-${i}`, "[User] hi");
      assert.ok(transcriptPeekBySession.size <= 4096, `transcriptPeekBySession.size=${transcriptPeekBySession.size}`);
    });

    it("getTranscriptPeek parses speaker and text", () => {
      pushTranscriptPeek("tp-parse", "[Nico] hey there");
      pushTranscriptPeek("tp-parse", "plain line");
      const out = getTranscriptPeek("tp-parse", 10);
      assert.deepEqual(out[0], { speaker: "Nico", text: "hey there" });
      assert.deepEqual(out[1], { speaker: "", text: "plain line" });
    });

    it("getTranscriptPeek returns last N entries", () => {
      for (let i = 0; i < 10; i++) pushTranscriptPeek("tp-last", `[U] m${i}`);
      const out = getTranscriptPeek("tp-last", 3);
      assert.equal(out.length, 3);
      assert.equal(out[0].text, "m7");
    });

    it("getTranscriptPeek returns empty array for unknown session", () => {
      assert.deepEqual(getTranscriptPeek("tp-unknown", 5), []);
    });
  });
});
