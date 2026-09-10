import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "initiative-cmd-test-"));

process.env.HUMAN_ENGINE_STATE_DIR = tmpDir;

await import("./helpers/ensure-plugin-sdk-shim.mjs");
const { default: pluginEntry } = await import("../index.js");

function makeFakeApi(opts = {}) {
  const { withLLM = false } = opts;
  const warnings = [];
  const hooks = {};
  const commands = [];
  const api = {
    pluginConfig: { enabled: true, agents: [] },
    config: {},
    runtime: { llm: withLLM ? { complete: async () => ({ text: "SPEAK" }) } : null },
    logger: { info() {}, warn(m) { warnings.push(m); }, debug() {}, error() {} },
    on(name, fn) {
      if (!hooks[name]) hooks[name] = [];
      hooks[name].push(fn);
    },
    registerCommand(def) {
      commands.push(def);
    },
  };
  return { api, hooks, warnings, commands };
}

function getInitiativeCmd() {
  const { api, commands } = makeFakeApi();
  pluginEntry.register(api);
  const cmd = commands.find((c) => c.name === "initiative");
  return { cmd, commands };
}

const SK = "agent:test-agent:whatsapp:group:123@g.us";

describe("/initiative command", () => {
  beforeEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.HUMAN_ENGINE_STATE_DIR = tmpDir;
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("requires an agent context", async () => {
    const { cmd } = getInitiativeCmd();
    const r = await cmd.handler({ sessionKey: SK, args: "list" });
    assert.ok(/requires an agent context/.test(r.text));
  });

  it("add + list in a session scope", async () => {
    const { cmd } = getInitiativeCmd();
    const ctx = { agentId: "test-agent", sessionKey: SK };

    const addRes = await cmd.handler({ ...ctx, args: "add buy milk" });
    assert.ok(/Notiert: buy milk/.test(addRes.text), addRes.text);

    const listRes = await cmd.handler({ ...ctx, args: "list" });
    assert.ok(/Offene Tasks:/.test(listRes.text));
    assert.ok(/buy milk/.test(listRes.text));
  });

  it("duplicate add reports already present", async () => {
    const { cmd } = getInitiativeCmd();
    const ctx = { agentId: "test-agent", sessionKey: SK };
    await cmd.handler({ ...ctx, args: "add buy milk" });
    const dup = await cmd.handler({ ...ctx, args: "add buy milk" });
    assert.ok(/Steht schon auf der Liste/.test(dup.text), dup.text);
  });

  it("done by index and by id-prefix", async () => {
    const { cmd } = getInitiativeCmd();
    const ctx = { agentId: "test-agent", sessionKey: SK };
    const addOne = await cmd.handler({ ...ctx, args: "add task one" });
    const addTwo = await cmd.handler({ ...ctx, args: "add task two" });

    // capture the 8-char id prefix from the confirmation text [<id8>]
    const idOne = (addOne.text.match(/\[([a-f0-9]{8})\]/) || [])[1];
    const idTwo = (addTwo.text.match(/\[([a-f0-9]{8})\]/) || [])[1];
    assert.ok(idOne && idTwo, "both tasks carry an id prefix");

    // done by index (task one = index 1)
    const byIndex = await cmd.handler({ ...ctx, args: "done 1" });
    assert.ok(/Erledigt: task one/.test(byIndex.text), byIndex.text);

    // done by id-prefix (task two)
    const byPrefix = await cmd.handler({ ...ctx, args: `done ${idTwo}` });
    assert.ok(/Erledigt: task two/.test(byPrefix.text), byPrefix.text);

    const list = await cmd.handler({ ...ctx, args: "list" });
    assert.ok(!/task one/.test(list.text), "done task one no longer listed");
    assert.ok(!/task two/.test(list.text), "done task two no longer listed");
  });

  it("forget marks expired", async () => {
    const { cmd } = getInitiativeCmd();
    const ctx = { agentId: "test-agent", sessionKey: SK };
    await cmd.handler({ ...ctx, args: "add temp task" });
    const r = await cmd.handler({ ...ctx, args: "forget 1" });
    assert.ok(/Vergessen: temp task/.test(r.text), r.text);
  });

  it("directive add + list", async () => {
    const { cmd } = getInitiativeCmd();
    const ctx = { agentId: "test-agent", sessionKey: SK };
    const add = await cmd.handler({ ...ctx, args: "directive immer grüßen" });
    assert.ok(/Direktive notiert/.test(add.text), add.text);
    const list = await cmd.handler({ ...ctx, args: "directives" });
    assert.ok(/immer grüßen/.test(list.text));
  });

  it("agent-wide list when no sessionKey", async () => {
    const { cmd } = getInitiativeCmd();
    // seed a task via the session scope
    const ctx = { agentId: "test-agent", sessionKey: SK };
    await cmd.handler({ ...ctx, args: "add group task" });
    const r = await cmd.handler({ agentId: "test-agent", args: "list" });
    assert.ok(/group task/.test(r.text), r.text);
  });

  it("no-agent-context error, and unknown subcommand shows usage", async () => {
    const { cmd } = getInitiativeCmd();
    const noAgent = await cmd.handler({ sessionKey: SK, args: "list" });
    assert.ok(/requires an agent context/.test(noAgent.text));
    const usage = await cmd.handler({ agentId: "test-agent", args: "bogus" });
    assert.ok(/Usage:/.test(usage.text), usage.text);
  });
});
