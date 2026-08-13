import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planConfigChanges, formatReport } from "../lib/autoconfig.js";

describe("autoconfig", () => {
  describe("planConfigChanges", () => {
    it("autoconfig no longer emits channel changes (targetGroups/gateway removed)", () => {
      const cfg = {
        targetGroups: [
          { channel: "telegram", chatId: "-100123" },
          { channel: "discord", chatId: "456" },
        ],
        gateway: { typingMode: "slow" },
      };
      const plan = planConfigChanges(cfg, {});
      assert.equal(plan.changes.length, 0);
    });

    it("warns when hooks.allowConversationAccess is missing", () => {
      const plan = planConfigChanges({}, {});
      assert.ok(plan.warnings.some((w) => w.includes("allowConversationAccess")));
    });

    it("does not warn when hooks.allowConversationAccess is set", () => {
      const plan = planConfigChanges({}, { hooks: { allowConversationAccess: true } });
      assert.ok(!plan.warnings.some((w) => w.includes("allowConversationAccess")));
    });

    it("includes Telegram privacy mode reminder", () => {
      const plan = planConfigChanges({}, {});
      assert.ok(plan.warnings.some((w) => w.includes("Telegram") && w.includes("BotFather")));
    });

    it("no dead-model warnings (decide.model/humanize.model removed)", () => {
      const plan = planConfigChanges({ decide: { model: "gpt-4o" }, humanize: { model: "gpt-4o" } }, {});
      assert.ok(!plan.warnings.some((w) => w.includes("model") && w.includes("allowModelOverride")));
      assert.ok(!plan.warnings.some((w) => w.includes("typingMode")));
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
