import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProactivityOutbox } from "../lib/proactivity-outbox.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "outbox-test-"));

describe("proactivity-outbox", { concurrency: false }, () => {
  beforeEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("record/lastOutbound round-trip persists", () => {
    const o = createProactivityOutbox({ stateDir: tmpDir });
    o.record("a::s", "initiative", 123);
    o.stop(); // flush
    const o2 = createProactivityOutbox({ stateDir: tmpDir });
    assert.equal(o2.lastOutbound("a::s"), 123);
  });

  it("key cap eviction keeps the most recent lastAt", () => {
    const o = createProactivityOutbox({ stateDir: tmpDir });
    for (let i = 0; i < 260; i++) {
      o.record("scope-" + i, "initiative", 1000 + i);
    }
    const state = o.__stateForTests();
    assert.ok(state.cache.size <= 256, `cache capped at 256 (got ${state.cache.size})`);
    // newest kept, oldest evicted
    assert.ok(state.cache.has("scope-259"), "newest scope retained");
    assert.equal(state.cache.has("scope-0"), false, "oldest scope evicted");
  });

  it("corrupt file is fail-open (returns 0, never throws)", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "proactivity-outbox.json"), "{not valid json");
    const o = createProactivityOutbox({ stateDir: tmpDir });
    assert.equal(o.lastOutbound("a::s"), 0, "corrupt file → 0");
    assert.doesNotThrow(() => o.record("a::s", "initiative", 5));
  });

  it("state file is written 0600", () => {
    const o = createProactivityOutbox({ stateDir: tmpDir });
    o.record("a::s", "proactive", 9);
    o.stop();
    const file = path.join(tmpDir, "proactivity-outbox.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "file mode 0600");
  });
});
