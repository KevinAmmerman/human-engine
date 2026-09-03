import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { warnStartupConfig } from "../lib/autoconfig.js";

function collect() {
  const warned = [];
  const log = {
    info() {},
    warn(msg) { warned.push(String(msg)); },
    debug() {},
  };
  return { warned, log };
}

describe("autoconfig", () => {
  describe("warnStartupConfig", () => {
    it("warns about no API key and Telegram reminder always", () => {
      const { warned, log } = collect();
      warnStartupConfig({}, {}, log);
      assert.ok(warned.some((w) => w.includes("no API key needed")));
      assert.ok(warned.some((w) => w.includes("BotFather")));
    });

    it("warns when hooks.allowConversationAccess is missing", () => {
      const { warned, log } = collect();
      warnStartupConfig({}, {}, log);
      assert.ok(warned.some((w) => w.includes("allowConversationAccess")));
    });

    it("does not warn when hooks.allowConversationAccess is set", () => {
      const { warned, log } = collect();
      warnStartupConfig({}, { hooks: { allowConversationAccess: true } }, log);
      assert.ok(!warned.some((w) => w.includes("allowConversationAccess")));
    });

    it("does not throw on missing host config", () => {
      const { log } = collect();
      assert.doesNotThrow(() => warnStartupConfig({}, undefined, log));
    });

    it("autoconfig opt-in is warnings-only advisory: no channel changes, no dead-model keys", () => {
      const { warned, log } = collect();
      warnStartupConfig({ decide: { model: "gpt-4o" }, humanize: { model: "gpt-4o" } }, { hooks: { allowConversationAccess: true } }, log);
      assert.ok(!warned.some((w) => w.includes("model") && w.includes("allowModelOverride")));
      assert.ok(!warned.some((w) => w.includes("typingMode")));
    });
  });
});
