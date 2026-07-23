import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANTI_TELL_BLOCK, detectTells } from "../lib/anti-tell.js";

describe("anti-tell", () => {
  describe("ANTI_TELL_BLOCK", () => {
    it("includes banned items", () => {
      assert.ok(ANTI_TELL_BLOCK.includes("Em-dash"));
      assert.ok(ANTI_TELL_BLOCK.includes("delve"));
      assert.ok(ANTI_TELL_BLOCK.includes("tapestry"));
      assert.ok(ANTI_TELL_BLOCK.includes("How can I help you"));
      assert.ok(ANTI_TELL_BLOCK.includes("Rule-of-three"));
    });

    it("includes encouraged items", () => {
      assert.ok(ANTI_TELL_BLOCK.includes("contractions"));
      assert.ok(ANTI_TELL_BLOCK.includes("fragments"));
      assert.ok(ANTI_TELL_BLOCK.includes("Echo vocabulary"));
    });
  });

  describe("detectTells", () => {
    it("detects em-dash", () => {
      const tells = detectTells("This is\u2014as I said\u2014important.");
      assert.ok(tells.includes("em-dash"));
    });

    it("detects bullet lists", () => {
      const tells = detectTells("- item one\n- item two");
      assert.ok(tells.includes("list"));
    });

    it("detects numbered lists", () => {
      const tells = detectTells("1. first\n2. second");
      assert.ok(tells.includes("list"));
    });

    it("detects bold markdown", () => {
      const tells = detectTells("This is **bold** text");
      assert.ok(tells.includes("bold-markdown"));
    });

    it("detects headers", () => {
      const tells = detectTells("## Section title");
      assert.ok(tells.includes("header"));
    });

    it("detects banned words", () => {
      const tells = detectTells("We should leverage our capabilities to delve deeper.");
      assert.ok(tells.includes("banned-word:leverage"));
      assert.ok(tells.includes("banned-word:delve"));
    });

    it("detects 'It's not X, it's Y' pattern", () => {
      const tells = detectTells("It's not about the money, it's about respect.");
      assert.ok(tells.includes("its-not-its"));
    });

    it("detects 'Not only... but also' pattern", () => {
      const tells = detectTells("Not only does it work, but also it's fast.");
      assert.ok(tells.includes("not-only-but-also"));
    });

    it("detects summary closing", () => {
      const tells = detectTells("In conclusion, this is a great idea.");
      assert.ok(tells.includes("summary-closing"));
    });

    it("detects enumeration words", () => {
      const tells = detectTells("Firstly, we need to plan. Secondly, execute.");
      assert.ok(tells.includes("enumeration"));
    });

    it("detects 'Certainly!'", () => {
      const tells = detectTells("Certainly! I can help with that.");
      assert.ok(tells.includes("certainly-exclamation"));
    });

    it("detects customer service phrase", () => {
      const tells = detectTells("How can I help you?");
      assert.ok(tells.includes("customer-service"));
    });

    it("passes clean casual English text", () => {
      const tells = detectTells("hey what's up? i was thinking we could grab lunch later");
      assert.equal(tells.length, 0);
    });

    it("passes clean casual German text", () => {
      const tells = detectTells("ja genau das hab ich auch gedacht lol");
      assert.equal(tells.length, 0);
    });

    it("detects multiple tells", () => {
      const tells = detectTells("- delve into\n- leverage\nIn conclusion, this is important.");
      assert.ok(tells.includes("list"));
      assert.ok(tells.includes("banned-word:delve"));
      assert.ok(tells.includes("banned-word:leverage"));
      assert.ok(tells.includes("summary-closing"));
    });
  });
});
