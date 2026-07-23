import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toServiceMessages, isCommand } from "../lib/messages.js";

describe("messages", () => {
  describe("toServiceMessages", () => {
    it("converts text event to service message", () => {
      const result = toServiceMessages([{ text: "Hello", senderName: "Alice" }]);
      assert.equal(result.length, 1);
      assert.equal(result[0].sender, "Alice");
      assert.equal(result[0].content, "Hello");
      assert.equal(result[0].has_media, undefined);
    });

    it("drops empty text without media", () => {
      const result = toServiceMessages([{ text: "", senderName: "Bob" }]);
      assert.equal(result.length, 0);
    });

    it("keeps media event with empty text using placeholder", () => {
      const result = toServiceMessages([{ text: "", senderName: "Charlie", hasMedia: true, mediaType: "photo" }]);
      assert.equal(result.length, 1);
      assert.equal(result[0].content, "[image]");
      assert.equal(result[0].has_media, true);
    });

    it("uses [video] placeholder for video", () => {
      const result = toServiceMessages([{ text: "", senderName: "D", hasMedia: true, mediaType: "video" }]);
      assert.equal(result[0].content, "[video]");
    });

    it("uses [voice message] placeholder for voice", () => {
      const result = toServiceMessages([{ text: "", senderName: "D", hasMedia: true, mediaType: "voice" }]);
      assert.equal(result[0].content, "[voice message]");
    });

    it("uses [audio] placeholder for audio", () => {
      const result = toServiceMessages([{ text: "", senderName: "D", hasMedia: true, mediaType: "audio" }]);
      assert.equal(result[0].content, "[audio]");
    });

    it("uses [document] placeholder for document", () => {
      const result = toServiceMessages([{ text: "", senderName: "D", hasMedia: true, mediaType: "document" }]);
      assert.equal(result[0].content, "[document]");
    });

    it("uses [sticker] placeholder for sticker", () => {
      const result = toServiceMessages([{ text: "", senderName: "D", hasMedia: true, mediaType: "sticker" }]);
      assert.equal(result[0].content, "[sticker]");
    });

    it("uses [media] fallback for unknown media type", () => {
      const result = toServiceMessages([{ text: "", senderName: "E", hasMedia: true, mediaType: "unknown" }]);
      assert.equal(result[0].content, "[media]");
    });

    it("captioned media keeps caption and has_media flag", () => {
      const result = toServiceMessages([{ text: "look!", senderName: "G", hasMedia: true, mediaType: "photo" }]);
      assert.equal(result.length, 1);
      assert.equal(result[0].content, "look!");
      assert.equal(result[0].has_media, true);
    });

    it("text-only message has no has_media key", () => {
      const result = toServiceMessages([{ text: "hi", senderName: "H" }]);
      assert.equal(result.length, 1);
      assert.equal(result[0].has_media, undefined);
      assert.ok(!("has_media" in result[0]));
    });

    it("replaces Discord placeholder sentence when media attached", () => {
      const result = toServiceMessages([{
        text: "(The user sent a message with no text content)",
        senderName: "F",
        hasMedia: true,
      }]);
      assert.equal(result[0].content, "[media]");
      assert.equal(result[0].has_media, true);
    });

    it("keeps Discord placeholder sentence when no media", () => {
      const result = toServiceMessages([{
        text: "(The user sent a message with no text content)",
        senderName: "F",
      }]);
      assert.equal(result.length, 1);
      assert.equal(result[0].content, "(The user sent a message with no text content)");
      assert.equal(result[0].has_media, undefined);
    });

    it("replaces <@id> with @you for self mention", () => {
      const result = toServiceMessages([{
        text: "Hello <@U123>",
        senderName: "Alice",
        mentions: [{ id: "U123", displayName: "Bot", isSelf: true }],
      }]);
      assert.equal(result[0].content, "Hello @you");
    });

    it("replaces <@id> with @DisplayName for other mention", () => {
      const result = toServiceMessages([{
        text: "<@U456> hi",
        senderName: "Alice",
        mentions: [{ id: "U456", displayName: "Bob", isSelf: false }],
      }]);
      assert.equal(result[0].content, "@Bob hi");
    });

    it("replaces <@!id> (nickname format) mentions", () => {
      const result = toServiceMessages([{
        text: "<@!U789> hello",
        senderName: "Alice",
        mentions: [{ id: "U789", displayName: "Charlie", isSelf: false }],
      }]);
      assert.equal(result[0].content, "@Charlie hello");
    });

    it("uses id as fallback when displayName missing", () => {
      const result = toServiceMessages([{
        text: "<@U999> test",
        senderName: "A",
        mentions: [{ id: "U999", displayName: "", isSelf: false }],
      }]);
      assert.equal(result[0].content, "@U999 test");
    });

    it("caps sender to 255 chars", () => {
      const result = toServiceMessages([{ text: "hi", senderName: "A".repeat(300) }]);
      assert.equal(result[0].sender.length, 255);
    });

    it("caps content to 4000 chars", () => {
      const result = toServiceMessages([{ text: "x".repeat(5000), senderName: "A" }]);
      assert.equal(result[0].content.length, 4000);
    });

    it("keeps newest 20 messages", () => {
      const events = [];
      for (let i = 0; i < 30; i++) {
        events.push({ text: `msg ${i}`, senderName: `User${i}` });
      }
      const result = toServiceMessages(events);
      assert.equal(result.length, 20);
      assert.equal(result[0].sender, "User10");
      assert.equal(result[19].sender, "User29");
    });

    it("uses Unknown as default sender", () => {
      const result = toServiceMessages([{ text: "hi" }]);
      assert.equal(result[0].sender, "Unknown");
    });
  });

  describe("isCommand", () => {
    it("returns true for slash-command", () => {
      assert.equal(isCommand("/new"), true);
    });
    it("returns false for normal text", () => {
      assert.equal(isCommand("hello"), false);
    });
    it("returns true for leading-space command", () => {
      assert.equal(isCommand("  /stop"), true);
    });
    it("returns false for empty string", () => {
      assert.equal(isCommand(""), false);
    });
  });
});
