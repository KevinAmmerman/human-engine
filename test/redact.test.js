import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactSessionKey } from "../lib/redact.js";

describe("redactSessionKey", () => {
  it("keeps only the last 4 digits of a long numeric run", () => {
    const out = redactSessionKey("agent:a:whatsapp:direct_4917000000001");
    assert.ok(out.includes("…0001"));
    assert.ok(!out.includes("4917000000001"));
  });

  it("leaves short numeric groups (<5 digits) untouched", () => {
    assert.equal(redactSessionKey("agent:a:whatsapp:group_1234@g.us"), "agent:a:whatsapp:group_1234@g.us");
    assert.equal(redactSessionKey("agent:a:whatsapp:direct_491"), "agent:a:whatsapp:direct_491");
  });

  it("redacts every long numeric group in the string", () => {
    const out = redactSessionKey("agent:a:whatsapp:group_120363000000001@g.us_9999999");
    assert.ok(out.includes("…0001"));
    assert.ok(out.includes("…9999"));
    assert.ok(!out.includes("120363000000001"));
    assert.ok(!out.includes("9999999"));
  });

  it("is safe for non-string input", () => {
    assert.equal(redactSessionKey(null), "");
    assert.equal(redactSessionKey(undefined), "");
    assert.equal(redactSessionKey(4917000000001), "…0001");
  });
});
