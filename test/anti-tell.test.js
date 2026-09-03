import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANTI_TELL_BLOCK, detectTells, stripMetaCommentary } from "../lib/anti-tell.js";

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

  describe("stripMetaCommentary", () => {
    const INCIDENT = [
      'Nico claims I\'m "his assistant." Light banter after my roast. He\'s',
      "asserting ownership/role in a playful way. I should respond with",
      "personality - not capitulate … Keep it one sharp clean line. Not",
      "defensive, just deadpan. … Warm underneath.Per Assistenten-Definition",
      "müsste ich dir dann auch …",
    ].join("\n");
    const GERMAN_REPLY = "Per Assistenten-Definition\nmüsste ich dir dann auch …";

    it("strips the verbatim incident text down to the German reply (inline seam)", () => {
      const result = stripMetaCommentary(INCIDENT, ["Nico", "Ada"]);
      assert.equal(result.stripped, true);
      assert.equal(result.text, GERMAN_REPLY);
    });

    it("strips the incident even without member names (narrator phrases only)", () => {
      const result = stripMetaCommentary(INCIDENT, []);
      assert.equal(result.stripped, true);
      assert.equal(result.text, GERMAN_REPLY);
    });

    it("strips a paragraph-joined commentary/reply variant", () => {
      const text = 'Nico claims I\'m "his assistant." Light banter after my roast.\n\nPer Assistenten-Definition müsste ich dir dann auch helfen.';
      const result = stripMetaCommentary(text, ["Nico"]);
      assert.equal(result.stripped, true);
      assert.equal(result.text, "Per Assistenten-Definition müsste ich dir dann auch helfen.");
    });

    it("strips a name+English-verb meta sentence with a German reply", () => {
      const text = "Nico claims the climb is too hard. Wir klettern trotzdem morgen.";
      const result = stripMetaCommentary(text, ["Nico"]);
      assert.equal(result.stripped, true);
      assert.equal(result.text, "Wir klettern trotzdem morgen.");
    });

    it("keeps a German reply starting with Yuki after an inline seam", () => {
      const text = "Nico claims the climb is too hard. Yuki steigt trotzdem morgen auf.";
      const result = stripMetaCommentary(text, ["Nico"]);
      assert.equal(result.stripped, true);
      assert.equal(result.text, "Yuki steigt trotzdem morgen auf.");
    });

    it("leaves a normal German reply mentioning a member unchanged", () => {
      const text = "Nico, ich schau morgen";
      const result = stripMetaCommentary(text, ["Nico"]);
      assert.equal(result.stripped, false);
      assert.equal(result.text, text);
    });

    it("leaves a German reply quoting English text with a name unchanged", () => {
      const text = 'Haha, Nico meinte "I think the route is doable" und ich bin dabei.';
      const result = stripMetaCommentary(text, ["Nico"]);
      assert.equal(result.stripped, false);
      assert.equal(result.text, text);
    });

    it("fails open (unchanged) when no clean split point exists", () => {
      const text = 'Nico joked "I should just go" aber das war nur Spaß.';
      const result = stripMetaCommentary(text, ["Nico"]);
      assert.equal(result.stripped, false);
      assert.equal(result.text, text);
    });

    describe("commentary flag (plan 347)", () => {
      const INCIDENT_PURE = [
        'Nico is playfully blessing/worshipping me here. He\'s clearly joking,',
        "playing into the bit after the last exchange. I should match the mood",
        "with a single light, witty one-liner. Keep it short and warm, one clean",
        "line, nothing defensive.",
      ].join(" ");

      it("classifies the pure-commentary incident as commentary:true, stripped:false", () => {
        const result = stripMetaCommentary(INCIDENT_PURE, ["Nico"]);
        assert.equal(result.commentary, true);
        assert.equal(result.stripped, false);
        assert.equal(result.text, INCIDENT_PURE);
      });

      it("flags commentary even without member names (narrator phrases)", () => {
        const result = stripMetaCommentary(INCIDENT_PURE, []);
        assert.equal(result.commentary, true);
        assert.equal(result.stripped, false);
      });

      it("leaves a normal German reply as commentary:false", () => {
        const text = "Per Assistenten-Definition müsste ich dir dann auch helfen.";
        const result = stripMetaCommentary(text, ["Nico"]);
        assert.equal(result.commentary, false);
        assert.equal(result.stripped, false);
      });

      it("reports the 345 mixed case as stripped:true, commentary:true", () => {
        const result = stripMetaCommentary(INCIDENT, ["Nico", "Ada"]);
        assert.equal(result.stripped, true);
        assert.equal(result.commentary, true);
      });

      it("reports a German reply quoting English text as commentary:false", () => {
        const text = 'Haha, Nico meinte "I think the route is doable" und ich bin dabei.';
        const result = stripMetaCommentary(text, ["Nico"]);
        assert.equal(result.commentary, false);
      });

      it("exposes strong >= 1 for a short narrator-phrase commentary (plan 499)", () => {
        const result = stripMetaCommentary("I should respond. ok.", ["Nico"]);
        assert.equal(result.commentary, true);
        assert.ok(result.strong >= 1);
      });

      it("reports a short member-name commentary as commentary:true but strong:0 (plan 499)", () => {
        const result = stripMetaCommentary("ja genau lol", ["Nico"]);
        assert.equal(result.commentary, false);
        assert.equal(result.strong, 0);
      });

      it("reports a plain short German reply as commentary:false, strong:0 (plan 499)", () => {
        const result = stripMetaCommentary("Alles klar, bis morgen.", ["Nico"]);
        assert.equal(result.commentary, false);
        assert.equal(result.strong, 0);
      });
    });

    it("returns unchanged for empty or non-string input", () => {
      assert.deepEqual(stripMetaCommentary("", ["Nico"]), { text: "", stripped: false, commentary: false });
      assert.deepEqual(stripMetaCommentary(null, ["Nico"]), { text: null, stripped: false, commentary: false });
    });
  });
});
