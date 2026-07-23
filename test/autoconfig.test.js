import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planConfigChanges, formatReport } from "../lib/autoconfig.js";

describe("autoconfig", () => {
  describe("planConfigChanges", () => {
    it("emits scoped paths for targetGroups", () => {
      const cfg = {
        targetGroups: [
          { channel: "telegram", chatId: "-100123" },
          { channel: "discord", chatId: "456" },
        ],
      };
      const plan = planConfigChanges(cfg, {});
      assert.ok(plan.changes.length > 0);
      for (const c of plan.changes) {
        assert.ok(c.path.startsWith("channels."), `path ${c.path} is not scoped`);
        assert.ok(!c.path.startsWith("channels.") === false);
      }
    });

    it("does not emit global keys", () => {
      const cfg = {
        targetGroups: [
          { channel: "telegram", chatId: "-100123" },
        ],
      };
      const plan = planConfigChanges(cfg, {});
      for (const c of plan.changes) {
        assert.ok(c.path.startsWith("channels."), `path ${c.path} is scoped`);
        assert.ok(!c.path.startsWith("openclaw") && !c.path.startsWith("agent.") && !c.path.startsWith("plugins."));
      }
    });

    it("is idempotent: second run produces zero changes", () => {
      const cfg = {
        targetGroups: [
          { channel: "telegram", chatId: "-100123" },
        ],
      };
      const alreadyApplied = {
        channels: {
          telegram: {
            groups: {
              "-100123": { requireMention: false },
            },
            streaming: "off",
          },
        },
      };
      const plan = planConfigChanges(cfg, alreadyApplied);
      const streamingChanges = plan.changes.filter((c) => c.path.includes("streaming"));
      const requireMentionChanges = plan.changes.filter((c) => c.path.includes("requireMention"));
      assert.equal(streamingChanges.length, 0);
      assert.equal(requireMentionChanges.length, 0);
    });

    it("warns when hooks.allowConversationAccess is missing", () => {
      const cfg = { targetGroups: [{ channel: "telegram", chatId: "-100" }] };
      const plan = planConfigChanges(cfg, {});
      assert.ok(plan.warnings.some((w) => w.includes("allowConversationAccess")));
    });

    it("includes Telegram privacy mode reminder", () => {
      const cfg = { targetGroups: [{ channel: "telegram", chatId: "-100" }] };
      const plan = planConfigChanges(cfg, {});
      assert.ok(plan.warnings.some((w) => w.includes("Telegram") && w.includes("BotFather")));
    });

    it("warns when typingMode is unusual", () => {
      const cfg = {
        targetGroups: [{ channel: "telegram", chatId: "-100" }],
        gateway: { typingMode: "slow" },
      };
      const plan = planConfigChanges(cfg, {});
      assert.ok(plan.warnings.some((w) => w.includes("typingMode")));
    });

    it("no typingMode warning for 'speed'", () => {
      const cfg = {
        targetGroups: [{ channel: "telegram", chatId: "-100" }],
        gateway: { typingMode: "speed" },
      };
      const plan = planConfigChanges(cfg, {});
      assert.ok(!plan.warnings.some((w) => w.includes("typingMode")));
    });

    it("emits both requireMention and streaming changes", () => {
      const cfg = {
        targetGroups: [{ channel: "telegram", chatId: "-100123" }],
      };
      const plan = planConfigChanges(cfg, {});
      const paths = plan.changes.map((c) => c.path);
      assert.ok(paths.some((p) => p.includes("requireMention")), "no requireMention change");
      assert.ok(paths.some((p) => p.includes("streaming")), "no streaming change");
    });
  });

  describe("formatReport", () => {
    it("formats changes and warnings", () => {
      const plan = {
        changes: [
          { path: 'channels.telegram.groups."-100".requireMention', from: "true", to: "false", why: "test" },
        ],
        warnings: ["Test warning"],
      };
      const report = formatReport(plan);
      assert.ok(report.includes("requireMention"));
      assert.ok(report.includes("Test warning"));
    });

    it("reports no changes when list is empty", () => {
      const report = formatReport({ changes: [], warnings: [] });
      assert.ok(report.includes("no changes needed"));
    });
  });
});
