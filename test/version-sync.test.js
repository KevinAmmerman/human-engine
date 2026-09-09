import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("version sync: package.json, plugin manifest and changelog head agree", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const head = changelog.match(/^## (\d+\.\d+\.\d+)/m)?.[1];

  assert.ok(head, "CHANGELOG head must start with a '## x.y.z' version header");
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.version, head);
});
