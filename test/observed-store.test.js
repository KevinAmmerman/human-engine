import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createObservedStore } from "../lib/observed-store.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "observed-store-test-"));

function makeLog() {
  const warns = [];
  return {
    info() {},
    warn(msg) { warns.push(msg); },
    debug() {},
    _warns: warns,
  };
}

function fileFor(sessionKey) {
  const safe = String(sessionKey).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(tmpDir, "observed", safe + ".jsonl");
}

describe("observed-store", { concurrency: false }, () => {
  let log;
  let store;

  beforeEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(tmpDir, { recursive: true });
    log = makeLog();
    store = createObservedStore({ stateDir: tmpDir, log });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  describe("roundtrip", () => {
    it("appends rows and reads them back in order with speaker/text/ts", () => {
      const sk = "agent:test:whatsapp:group:123@g.us";
      store.appendObserved(sk, { speaker: "Kevin", text: "erster", ts: 1000 });
      store.appendObserved(sk, { speaker: "Anna", text: "zweiter", ts: 1001 });
      store.appendObserved(sk, { speaker: "Kevin", text: "dritter", ts: 1002 });

      const rows = store.readObserved(sk, 20);
      assert.equal(rows.length, 3);
      assert.deepEqual(rows.map((r) => r.speaker), ["Kevin", "Anna", "Kevin"]);
      assert.deepEqual(rows.map((r) => r.text), ["erster", "zweiter", "dritter"]);
      assert.deepEqual(rows.map((r) => r.ts), [1000, 1001, 1002]);
    });

    it("returns newest-last ordering matching append order", () => {
      const sk = "roundtrip-order";
      for (let i = 0; i < 5; i++) store.appendObserved(sk, { speaker: "S", text: "m" + i, ts: i });
      const rows = store.readObserved(sk, 20);
      assert.equal(rows[rows.length - 1].text, "m4");
    });

    it("sanitizes sessionKey into a stable file name", () => {
      const sk = "agent:kevin:whatsapp:group:abc@g.us";
      store.appendObserved(sk, { speaker: "A", text: "hi", ts: 1 });
      assert.ok(fs.existsSync(fileFor(sk)));
    });
  });

  describe("rotation", () => {
    it("bounds the file to ~200 newest rows after 405 appends", () => {
      const sk = "rotation-session";
      for (let i = 0; i < 405; i++) store.appendObserved(sk, { speaker: "Kevin", text: "m" + i, ts: i });

      const file = fileFor(sk);
      const dataLines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      assert.ok(dataLines.length <= 205, "file should be trimmed to ~200 rows, got " + dataLines.length);
      assert.ok(dataLines.length < 405, "file must not keep all appended rows");

      const rows = store.readObserved(sk, 20);
      assert.equal(rows.length, 20);
      assert.equal(rows[0].text, "m385");
      assert.equal(rows[rows.length - 1].text, "m404");
    });

    it("keeps newest rows across a fresh instance (restart survival)", () => {
      const sk = "restart-session";
      for (let i = 0; i < 405; i++) store.appendObserved(sk, { speaker: "Kevin", text: "m" + i, ts: i });

      const fresh = createObservedStore({ stateDir: tmpDir, log: makeLog() });
      const rows = fresh.readObserved(sk, 20);
      assert.equal(rows.length, 20);
      assert.equal(rows[0].text, "m385");
    });
  });

  describe("file modes", () => {
    it("writes the jsonl with 0600 and dir with 0700", () => {
      const sk = "mode-session";
      store.appendObserved(sk, { speaker: "Kevin", text: "secret", ts: 1 });

      const file = fileFor(sk);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const dir = path.dirname(file);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    });

    it("keeps 0600 after rotation rewrite", () => {
      const sk = "mode-rotation-session";
      for (let i = 0; i < 405; i++) store.appendObserved(sk, { speaker: "Kevin", text: "m" + i, ts: i });
      assert.equal(fs.statSync(fileFor(sk)).mode & 0o777, 0o600);
    });
  });

  describe("corruption tolerance", () => {
    it("skips a corrupt last line and returns valid rows", () => {
      const sk = "corrupt-session";
      const file = fileFor(sk);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        file,
        JSON.stringify({ speaker: "Kevin", text: "gut", ts: 1 }) + "\n" +
        JSON.stringify({ speaker: "Anna", text: "auch gut", ts: 2 }) + "\n" +
        '{"speaker": "Kim", "text": "kaputt',
        { mode: 0o600 },
      );

      const rows = store.readObserved(sk, 20);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => r.text), ["gut", "auch gut"]);
      assert.ok(log._warns.length >= 1, "corrupt line should be warned about");
    });

    it("skips rows that parse but lack text", () => {
      const sk = "garbage-session";
      const file = fileFor(sk);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        file,
        JSON.stringify({ speaker: "Kevin", text: "echt" }) + "\n" +
        JSON.stringify({ speaker: "Ghost" }) + "\n" +
        '"just a string"',
        { mode: 0o600 },
      );

      const rows = store.readObserved(sk, 20);
      assert.deepEqual(rows.map((r) => r.text), ["echt"]);
    });
  });

  describe("error handling", () => {
    it("readObserved returns [] for a missing session dir", () => {
      assert.deepEqual(store.readObserved("no-such-session"), []);
    });

    it("appendObserved does not throw on bad input", () => {
      assert.doesNotThrow(() => store.appendObserved(null, { speaker: "A", text: "hi" }));
      assert.doesNotThrow(() => store.appendObserved("sk", { speaker: "A", text: "" }));
      assert.doesNotThrow(() => store.appendObserved("sk", null));
    });

    it("readObserved honors the last cap", () => {
      const sk = "cap-session";
      for (let i = 0; i < 10; i++) store.appendObserved(sk, { speaker: "S", text: "m" + i, ts: i });
      assert.equal(store.readObserved(sk, 3).length, 3);
      assert.equal(store.readObserved(sk, 3)[0].text, "m7");
    });
  });
});
