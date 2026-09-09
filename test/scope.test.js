import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseSessionKey,
  parseScope,
  agentIdFromSessionKey,
  isChatSession,
  isGroupSessionKey,
  isDmSessionKey,
  channelAndRestFromSessionKey,
} from "../lib/scope.js";

const DM_KEY = "agent:hori-wa:whatsapp:direct:999999999";
const GROUP_KEY = "agent:hori-wa:whatsapp:group:1203999999999@g.us";
const HEARTBEAT_KEY = "agent:hori-wa:whatsapp:heartbeat:foo";
const TTS_KEY = "agent:hori-wa:whatsapp:group:x@y";

describe("scope", () => {
  describe("parseSessionKey", () => {
    it("parses agentId and raw rest", () => {
      const p = parseSessionKey(DM_KEY);
      assert.deepEqual(p, {
        agentId: "hori-wa",
        rest: "hori-wa:whatsapp:direct:999999999",
        raw: DM_KEY,
      });
    });

    it("returns null for non-agent keys and non-strings", () => {
      assert.equal(parseSessionKey("no-agent-prefix"), null);
      assert.equal(parseSessionKey(""), null);
      assert.equal(parseSessionKey(null), null);
      assert.equal(parseSessionKey(42), null);
    });
  });

  describe("parseScope", () => {
    it("parses channel, kind and rest", () => {
      const p = parseScope(DM_KEY);
      assert.deepEqual(p, {
        agentId: "hori-wa",
        channel: "whatsapp",
        kind: "direct",
        rest: "999999999",
      });
    });

    it("parses group key with @g.us rest", () => {
      const p = parseScope(GROUP_KEY);
      assert.equal(p.channel, "whatsapp");
      assert.equal(p.kind, "group");
      assert.equal(p.rest, "1203999999999@g.us");
    });

    it("handles two-segment key without channel/kind/rest", () => {
      const p = parseScope("agent:hori-wa");
      assert.deepEqual(p, {
        agentId: "hori-wa",
        channel: null,
        kind: null,
        rest: null,
      });
    });

    it("returns null for non-agent keys", () => {
      assert.equal(parseScope("nope"), null);
      assert.equal(parseScope(""), null);
      assert.equal(parseScope(null), null);
    });
  });

  describe("agentIdFromSessionKey", () => {
    it("extracts agentId", () => {
      assert.equal(agentIdFromSessionKey(DM_KEY), "hori-wa");
      assert.equal(agentIdFromSessionKey("agent:x:telegram:direct:1"), "x");
    });

    it("returns null for invalid keys", () => {
      assert.equal(agentIdFromSessionKey("nope"), null);
      assert.equal(agentIdFromSessionKey(""), null);
      assert.equal(agentIdFromSessionKey(null), null);
    });
  });

  describe("isChatSession", () => {
    it("true for chat channels", () => {
      assert.equal(isChatSession(DM_KEY), true);
      assert.equal(isChatSession(GROUP_KEY), true);
    });

    it("false for heartbeat and non-chat", () => {
      assert.equal(isChatSession(HEARTBEAT_KEY), false);
      assert.equal(isChatSession("nope"), false);
    });
  });

  describe("isGroupSessionKey", () => {
    it("true only for group keys", () => {
      assert.equal(isGroupSessionKey(GROUP_KEY), true);
      assert.equal(isGroupSessionKey(DM_KEY), false);
      assert.equal(isGroupSessionKey("nope"), false);
    });
  });

  describe("isDmSessionKey", () => {
    it("true for direct chat, false for group/heartbeat/non-chat", () => {
      assert.equal(isDmSessionKey(DM_KEY), true);
      assert.equal(isDmSessionKey(GROUP_KEY), false);
      assert.equal(isDmSessionKey(HEARTBEAT_KEY), false);
      assert.equal(isDmSessionKey("nope"), false);
    });
  });

  describe("channelAndRestFromSessionKey", () => {
    it("returns everything after agent:<agentId>: unchanged", () => {
      assert.equal(channelAndRestFromSessionKey(TTS_KEY), "whatsapp:group:x@y");
      assert.equal(channelAndRestFromSessionKey(DM_KEY), "whatsapp:direct:999999999");
    });

    it("returns null for non-agent keys", () => {
      assert.equal(channelAndRestFromSessionKey("nope"), null);
      assert.equal(channelAndRestFromSessionKey(""), null);
      assert.equal(channelAndRestFromSessionKey(null), null);
    });
  });
});
