import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeStyleStats, styleConstraintText } from "../lib/style-stats.js";

describe("style-stats", () => {
  describe("computeStyleStats", () => {
    it("returns zeros for empty input", () => {
      const s = computeStyleStats([]);
      assert.equal(s.avgLen, 0);
      assert.equal(s.capsRate, 0);
      assert.equal(s.emojiRate, 0);
      assert.equal(s.contractionRate, 0);
    });

    it("returns zeros for null/undefined", () => {
      assert.equal(computeStyleStats(null).avgLen, 0);
      assert.equal(computeStyleStats(undefined).avgLen, 0);
    });

    it("computes avgLen correctly", () => {
      const lines = ["[A] hello world", "[B] hi"];
      const s = computeStyleStats(lines);
      assert.equal(s.avgLen, 7);
    });

    it("detects caps usage", () => {
      const lines = ["[A] Hello World", "[B] hi there"];
      const s = computeStyleStats(lines);
      assert.equal(s.capsRate, 0.5);
    });

    it("detects emoji usage", () => {
      const lines = ["[A] hello \ud83d\ude00", "[B] hi"];
      const s = computeStyleStats(lines);
      assert.equal(s.emojiRate, 0.5);
    });

    it("detects contraction usage", () => {
      const lines = ["[A] I don't know", "[B] it's fine", "[C] nope"];
      const s = computeStyleStats(lines);
      assert.equal(s.contractionRate, 2 / 3);
    });

    it("detects exclamation usage", () => {
      const lines = ["[A] wow!", "[B] nice!", "[C] ok"];
      const s = computeStyleStats(lines);
      assert.equal(s.exclaimRate, 2 / 3);
    });

    it("strips author prefix for text metrics", () => {
      const lines = [
        "[Alice] short",
        "[Bob] also short text here",
      ];
      const s = computeStyleStats(lines);
      assert.equal(s.avgLen, 13);
    });

    it("handles single line", () => {
      const s = computeStyleStats(["[User] Hello!"]);
      assert.equal(s.avgLen, 6);
      assert.equal(s.capsRate, 1);
      assert.equal(s.exclaimRate, 1);
    });
  });

  describe("styleConstraintText", () => {
    it("returns empty for null/undefined stats", () => {
      assert.equal(styleConstraintText(null), "");
      assert.equal(styleConstraintText(undefined), "");
    });

    it("returns empty for zero avgLen", () => {
      assert.equal(styleConstraintText({ avgLen: 0, capsRate: 0, emojiRate: 0, contractionRate: 0 }), "");
    });

    it("produces short description", () => {
      const result = styleConstraintText({ avgLen: 20, capsRate: 0.2, emojiRate: 0.05, contractionRate: 0.4 });
      assert.ok(result.includes("short"));
      assert.ok(result.includes("~20"));
      assert.ok(result.includes("mostly lowercase"));
      assert.ok(result.includes("rarely uses emoji"));
      assert.ok(result.includes("heavy contractions"));
    });

    it("produces long capitalized description", () => {
      const result = styleConstraintText({ avgLen: 120, capsRate: 0.8, emojiRate: 0.6, contractionRate: 0.1 });
      assert.ok(result.includes("long"));
      assert.ok(result.includes("~120"));
      assert.ok(result.includes("mostly capitalized"));
      assert.ok(result.includes("uses many emoji"));
      assert.ok(!result.includes("heavy contractions"));
    });

    it("produces medium description", () => {
      const result = styleConstraintText({ avgLen: 50, capsRate: 0.5, emojiRate: 0.2, contractionRate: 0.2 });
      assert.ok(result.includes("medium length"));
    });

    it("returns a compact single line", () => {
      const result = styleConstraintText({ avgLen: 30, capsRate: 0.5, emojiRate: 0.3, contractionRate: 0.2 });
      assert.ok(result.startsWith("This group writes"));
      assert.ok(result.endsWith("."));
    });
  });
});
