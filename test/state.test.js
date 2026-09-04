import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { capMap, pushObserved, observedBySession, pushTranscriptPeek, transcriptPeekBySession, getTranscriptPeek, peekMetaBySession } from "../lib/state.js";

describe("state", () => {
  beforeEach(() => {
    observedBySession.clear();
    transcriptPeekBySession.clear();
    peekMetaBySession.clear();
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

    it("aligns ts meta with peek lines (speaker/text/ts)", () => {
      pushTranscriptPeek("tp-meta", "[Nico] a", undefined, 1000);
      pushTranscriptPeek("tp-meta", "[Ada] b", undefined, 2000);
      pushTranscriptPeek("tp-meta", "[Hori] c", undefined, 3000);
      const out = getTranscriptPeek("tp-meta", 10);
      assert.equal(out.length, 3);
      assert.deepEqual(out[0], { speaker: "Nico", text: "a", ts: 1000 });
      assert.deepEqual(out[1], { speaker: "Ada", text: "b", ts: 2000 });
      assert.deepEqual(out[2], { speaker: "Hori", text: "c", ts: 3000 });
    });

    it("keeps ts alignment after overflow cap", () => {
      for (let i = 0; i < 60; i++) pushTranscriptPeek("tp-overflow", `[U] m${i}`, 50, 1000 + i);
      const out = getTranscriptPeek("tp-overflow", 50);
      assert.equal(out.length, 50);
      assert.deepEqual(out[0], { speaker: "U", text: "m10", ts: 1010 });
      assert.deepEqual(out[49], { speaker: "U", text: "m59", ts: 1059 });
    });

    it("missing ts yields undefined (omitted)", () => {
      pushTranscriptPeek("tp-nots", "[Nico] a");
      pushTranscriptPeek("tp-nots", "[Ada] b", undefined, 500);
      const out = getTranscriptPeek("tp-nots", 10);
      assert.deepEqual(out[0], { speaker: "Nico", text: "a" });
      assert.deepEqual(out[1], { speaker: "Ada", text: "b", ts: 500 });
    });
  });

  describe("own-line persist consistency (plan 517)", () => {
    it("own peek line and observed-store row share speaker + text so the merge needs no special casing", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const { createObservedStore } = await import("../lib/observed-store.js");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-own-line-"));
      try {
        const agentName = "OpenClaw";
        const text = "Klare Antwort: nasser Fels ist ein No-Go";
        pushTranscriptPeek("tp-own-517", `[${agentName}] ${text}`);
        const peekEntry = getTranscriptPeek("tp-own-517", 1)[0];
        const store = createObservedStore({ stateDir: tmpDir, log: { info() {}, warn() {}, debug() {} } });
        store.appendObserved("tp-own-517", { speaker: agentName, text, ts: Date.now() });
        const storeEntry = store.readObserved("tp-own-517", 1)[0];
        assert.equal(peekEntry.speaker, storeEntry.speaker, "peek speaker matches persisted speaker");
        assert.equal(peekEntry.text, storeEntry.text, "peek text matches persisted text");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
