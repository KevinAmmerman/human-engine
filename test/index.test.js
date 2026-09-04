import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HUMAN_ENGINE_STATE_DIR = mkdtempSync(join(tmpdir(), "he-test-state-"));

await import("./helpers/ensure-plugin-sdk-shim.mjs");
const { transcriptEventTsMs, isNoReplyAssistantText } = await import("../index.js");

describe("readSessionTranscript helpers (index.js)", () => {
  it("no_reply filter: drops exact assistant NO_REPLY artifacts only", () => {
    assert.equal(isNoReplyAssistantText("assistant", "NO_REPLY"), true, "exact NO_REPLY assistant line dropped");
    assert.equal(isNoReplyAssistantText("assistant", "  no_reply  "), true, "case-insensitive + whitespace tolerated");
    assert.equal(isNoReplyAssistantText("assistant", "NO_REPLY, oder?"), false, "real reply text starting with NO_REPLY kept");
    assert.equal(isNoReplyAssistantText("user", "NO_REPLY"), false, "user lines never filtered");
    assert.equal(isNoReplyAssistantText("assistant", "echte antwort"), false, "normal assistant lines kept");
  });

  it("ts backfill: event timestamp in s / ms / ISO string resolves to epoch ms", () => {
    assert.equal(transcriptEventTsMs({ timestamp: 1788483745000 }), 1788483745000, "ms number passes through");
    assert.equal(transcriptEventTsMs({ timestamp: 1788483745 }), 1788483745000, "s number is scaled to ms");
    const iso = "2026-09-04T01:02:27.977Z";
    assert.equal(transcriptEventTsMs({ timestamp: iso }), Date.parse(iso), "ISO string is Date.parsed");
    assert.equal(transcriptEventTsMs({ message: { timestamp: 1788483745000 } }), 1788483745000, "message-level ms timestamp resolves");
    assert.equal(transcriptEventTsMs({}), undefined, "no timestamp → undefined");
    assert.equal(transcriptEventTsMs({ timestamp: "not a date" }), undefined, "unparseable string → undefined");
  });
});
