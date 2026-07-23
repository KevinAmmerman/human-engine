import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectTells } from "../lib/anti-tell.js";

const SPLIT_FIXTURES = [
  `{"messages": ["lol nice", "yeah i agree with that"]}`,
  `{"messages": ["hmm idk", "maybe we should ask someone else"]}`,
  `{"messages": ["ja genau", "das hab ich auch gedacht"]}`,
  `{"messages": ["oh wait", "nvm found it"]}`,
  `{"messages": ["cool", "when do we start?"]}`,
  `{"messages": ["😂", "that's actually hilarious"]}`,
  `{"messages": ["i think so too", "based on what you said earlier"]}`,
  `{"messages": ["nice one!", "seriously though what's the plan"]}`,
  `{"messages": ["tbh idk", "let me check"]}`,
  `{"messages": ["oh interesting", "i didn't know that"]}`,
  `{"messages": ["fair point", "but what about the other thing?"]}`,
  `{"messages": ["yep", "already done"]}`,
  `{"messages": ["wow that's wild", "how did that happen?"]}`,
  `{"messages": ["gute frage", "lass mich kurz nachdenken"]}`,
  `{"messages": ["sorry missed that", "can you repeat?"]}`,
  `{"messages": ["lol", "fr though that's a good idea"]}`,
  `{"messages": ["hold on", "getting the link now"]}`,
  `{"messages": ["omg yes", "i was just thinking the same thing"]}`,
  `{"messages": ["right?", "exactly my point"]}`,
  `{"messages": ["wait really?", "i had no idea"]}`,
  `{"messages": ["fair enough", "let's go with that then"]}`,
  `{"messages": ["not sure tbh", "what do you all think?"]}`,
  `{"messages": ["lol true", "can't argue with that"]}`,
  `{"messages": ["hey sorry was afk", "what did i miss?"]}`,
  `{"messages": ["good point", "i hadn't considered that"]}`,
];

describe("tell-detector", () => {
  describe("unit — each banned item detected", () => {
    it("detects em-dash", () => {
      const tells = detectTells("This is\u2014wait\u2014nevermind.");
      assert.ok(tells.includes("em-dash"));
    });

    it("detects bullet list", () => {
      const tells = detectTells("- item one\n- item two");
      assert.ok(tells.includes("list"));
    });

    it("detects numbered list", () => {
      const tells = detectTells("1. first\n2. second");
      assert.ok(tells.includes("list"));
    });

    it("detects bold markdown", () => {
      const tells = detectTells("This is **bold** text");
      assert.ok(tells.includes("bold-markdown"));
    });

    it("detects header", () => {
      const tells = detectTells("## Section title");
      assert.ok(tells.includes("header"));
    });

    it("detects delve", () => {
      const tells = detectTells("Let me delve deeper into this.");
      assert.ok(tells.includes("banned-word:delve"));
    });

    it("detects tapestry", () => {
      const tells = detectTells("A rich tapestry of ideas.");
      assert.ok(tells.includes("banned-word:tapestry"));
    });

    it("detects furthermore", () => {
      const tells = detectTells("Furthermore, we need to act.");
      assert.ok(tells.includes("banned-word:furthermore"));
    });

    it("detects navigate", () => {
      const tells = detectTells("Let's navigate this situation.");
      assert.ok(tells.includes("banned-word:navigate"));
    });

    it("detects landscape", () => {
      const tells = detectTells("The competitive landscape is changing.");
      assert.ok(tells.includes("banned-word:landscape"));
    });

    it("detects realm", () => {
      const tells = detectTells("In the realm of possibilities.");
      assert.ok(tells.includes("banned-word:realm"));
    });

    it("detects paramount", () => {
      const tells = detectTells("It is paramount that we act now.");
      assert.ok(tells.includes("banned-word:paramount"));
    });

    it("detects meticulous", () => {
      const tells = detectTells("A meticulous analysis was done.");
      assert.ok(tells.includes("banned-word:meticulous"));
    });

    it("detects underscore", () => {
      const tells = detectTells("I underscore the importance of this.");
      assert.ok(tells.includes("banned-word:underscore"));
    });

    it("detects leverage", () => {
      const tells = detectTells("We should leverage our resources.");
      assert.ok(tells.includes("banned-word:leverage"));
    });

    it("detects utilize", () => {
      const tells = detectTells("Let's utilize this opportunity.");
      assert.ok(tells.includes("banned-word:utilize"));
    });

    it("detects facilitate", () => {
      const tells = detectTells("This will facilitate the process.");
      assert.ok(tells.includes("banned-word:facilitate"));
    });

    it("detects showcase", () => {
      const tells = detectTells("Let me showcase the results.");
      assert.ok(tells.includes("banned-word:showcase"));
    });

    it("detects 'its not X its Y' pattern", () => {
      const tells = detectTells("It's not about the money, it's about respect.");
      assert.ok(tells.includes("its-not-its"));
    });

    it("detects 'Not only... but also'", () => {
      const tells = detectTells("Not only does it work, but also it's fast.");
      assert.ok(tells.includes("not-only-but-also"));
    });

    it("detects summary closing", () => {
      const tells = detectTells("In conclusion, this is a great idea.");
      assert.ok(tells.includes("summary-closing"));
    });

    it("detects To summarize", () => {
      const tells = detectTells("To summarize, here are the key points.");
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

    it("detects 'How can I help you?'", () => {
      const tells = detectTells("How can I help you?");
      assert.ok(tells.includes("customer-service"));
    });

    it("passes clean casual English", () => {
      const tells = detectTells("hey what's up? i was thinking we could grab lunch later");
      assert.equal(tells.length, 0);
    });

    it("passes clean casual German", () => {
      const tells = detectTells("ja genau das hab ich auch gedacht lol");
      assert.equal(tells.length, 0);
    });
  });

  describe("integration — zero tells across split fixtures", () => {
    for (let i = 0; i < SPLIT_FIXTURES.length; i++) {
      const fixture = SPLIT_FIXTURES[i];
      const preview = fixture.replace(/\n/g, " ").slice(0, 40);
      it("fixture " + (i + 1) + ": zero tells in split fixture output", () => {
        const tells = detectTells(fixture);
        assert.equal(tells.length, 0, `unexpected tells ${JSON.stringify(tells)} in fixture ${i + 1}`);
      });
    }
  });
});
