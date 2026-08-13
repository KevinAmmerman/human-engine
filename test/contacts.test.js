import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseContacts, loadContacts, resolveContactName, findAgentContactIds } from "../lib/contacts.js";

const SAMPLE = `# Kletter-Gruppe Kontakte
| @lid | Telefonnummer | Name | Notizen |
|------|--------------|------|---------|
| 81000000000004 | +4915000000001 | Ada Example | Admin |
| 81000000000001 | +4915000000002 | AgentBot | Bot |
| 81000000000002 | +4915000000004 | Test Person | |
| 81000000000003 | +4915000000005 | Test Person B | |
`;

describe("contacts", () => {
  it("parseContacts maps lid and phone to name", () => {
    const map = parseContacts(SAMPLE);
    assert.equal(map.get("81000000000004"), "Ada Example");
    assert.equal(resolveContactName(map, "+4915000000001"), "Ada Example");
    assert.equal(resolveContactName(map, "+4915000000004"), "Test Person");
    assert.equal(resolveContactName(map, "+4915000000005"), "Test Person B");
  });

  it("parseContacts skips headers and separators", () => {
    const map = parseContacts(SAMPLE);
    assert.equal(map.get("lid"), undefined);
    assert.equal(map.get("Telefonnummer"), undefined);
    assert.equal(map.size, 8);
  });

  it("parseContacts handles empty input", () => {
    assert.equal(parseContacts("").size, 0);
    assert.equal(parseContacts(null).size, 0);
  });

  it("resolveContactName resolves via phone or lid", () => {
    const map = parseContacts(SAMPLE);
    assert.equal(resolveContactName(map, "+4915000000001"), "Ada Example");
    assert.equal(resolveContactName(map, "81000000000002"), "Test Person");
    assert.equal(resolveContactName(map, undefined, "+4915000000005"), "Test Person B");
    assert.equal(resolveContactName(map, "+4900000"), null);
    assert.equal(resolveContactName(null, "+4915000000001"), null);
  });

  it("normalizeId digit-normalizes lid/phone variants so @lid and @c.us suffixes match bare ids", () => {
    const map = parseContacts(SAMPLE);
    assert.equal(map.get("81000000000004"), "Ada Example", "bare lid key stored as digits");
    assert.equal(resolveContactName(map, "81000000000004@lid"), "Ada Example", "@lid suffix resolves to same key");
    assert.equal(resolveContactName(map, "@81000000000004@lid"), "Ada Example", "leading @ + @lid suffix resolve to same key");
    assert.equal(resolveContactName(map, "+4915000000001"), "Ada Example", "phone with + stored as digits");
    assert.equal(resolveContactName(map, "4915000000001@c.us"), "Ada Example", "@c.us suffix resolves to same key");
    assert.equal(resolveContactName(map, "+49 1500 0000001"), "Ada Example", "spaces and hyphens stripped");
    assert.equal(resolveContactName(map, "81000000000004@lid"), "Ada Example");
    assert.equal(resolveContactName(map, "4915000000001@c.us"), "Ada Example");
  });

  it("loadContacts caches by mtime and tolerates missing file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "contacts-"));
    const file = path.join(tmpDir, "contacts.md");
    fs.writeFileSync(file, SAMPLE);
    const map = loadContacts(file);
    assert.equal(resolveContactName(map, "+4915000000001"), "Ada Example");
    assert.equal(loadContacts(path.join(tmpDir, "missing.md")), null);
    assert.equal(loadContacts(""), null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("findAgentContactIds matches the agent's own lid by name prefix", () => {
    const map = parseContacts(SAMPLE);
    const ids = findAgentContactIds(map, "AgentBot");
    assert.equal(ids.has("81000000000001"), true, "agent's lid should be in the set");
  });

  it("findAgentContactIds ignores other members", () => {
    const map = parseContacts(SAMPLE);
    const ids = findAgentContactIds(map, "AgentBot");
    assert.equal(ids.has("81000000000004"), false, "Ada Example's lid must not be in the set");
    assert.equal(ids.has("+4915000000001"), false, "Ada Example's phone must not be in the set");
    assert.equal(ids.has("81000000000002"), false, "Test Person's lid must not be in the set");
  });

  it("findAgentContactIds is safe for empty map or missing agent name", () => {
    assert.equal(findAgentContactIds(new Map(), "Hori").size, 0);
    assert.equal(findAgentContactIds(null, "Hori").size, 0);
    assert.equal(findAgentContactIds(parseContacts(SAMPLE), null).size, 0);
  });
});
