import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseContacts, loadContacts, resolveContactName } from "../lib/contacts.js";

const SAMPLE = `# Kletter-Gruppe Kontakte
| @lid | Telefonnummer | Name | Notizen |
|------|--------------|------|---------|
| 81000000000004 | +4915000000010 | Kevin | Admin |
| 81000000000001 | +4915000000013 | Hori (Bot) | Bot |
| 81000000000002 | +4915000000012 | Lukas | |
| 81000000000003 | +4915000000011 | Basti | |
`;

describe("contacts", () => {
  it("parseContacts maps lid and phone to name", () => {
    const map = parseContacts(SAMPLE);
    assert.equal(map.get("81000000000004"), "Kevin");
    assert.equal(map.get("+4915000000010"), "Kevin");
    assert.equal(map.get("+4915000000012"), "Lukas");
    assert.equal(map.get("+4915000000011"), "Basti");
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
    assert.equal(resolveContactName(map, "+4915000000010"), "Kevin");
    assert.equal(resolveContactName(map, "81000000000002"), "Lukas");
    assert.equal(resolveContactName(map, undefined, "+4915000000011"), "Basti");
    assert.equal(resolveContactName(map, "+4900000"), null);
    assert.equal(resolveContactName(null, "+4915000000010"), null);
  });

  it("loadContacts caches by mtime and tolerates missing file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "contacts-"));
    const file = path.join(tmpDir, "contacts.md");
    fs.writeFileSync(file, SAMPLE);
    const map = loadContacts(file);
    assert.equal(map.get("+4915000000010"), "Kevin");
    assert.equal(loadContacts(path.join(tmpDir, "missing.md")), null);
    assert.equal(loadContacts(""), null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
