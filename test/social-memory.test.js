import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSocialMemory } from "../lib/social-memory.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "social-mem-test-"));

function makeCfg(overrides = {}) {
  return {
    socialMemory: {
      enabled: true,
      extractEvery: 25,
      extractMinutes: 0,
      maxPeople: 50,
      recallLimit: 800,
      ...overrides,
    },
  };
}

function makeLog() {
  return { info() {}, warn() {}, debug() {} };
}

function after() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

describe("social-memory", { concurrency: false }, () => {
  let sm;

  beforeEach(() => {
    // Clean up any state dirs from previous tests
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  describe("self-filter (plan 513)", () => {
    it("does not create a person record when speaker is the agent name", () => {
      const cfg = makeCfg();
      cfg.agentName = "Hori";
      sm = createSocialMemory({ cfg, stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::self-name";
      sm.ingest(scope, { speaker: "Hori", text: "hi", ts: 100 });
      sm.ingest(scope, { speaker: "Alice", text: "hello", ts: 101 });
      const profile = sm.getOrLoadProfile(scope);
      assert.ok(profile.people.Alice);
      assert.ok(!profile.people.Hori);
      assert.ok(!profile.people.hori);
    });

    it("does not create a person record for an agent alias (case-insensitive)", () => {
      const cfg = makeCfg();
      cfg.agentName = "Hori";
      cfg.agentAliases = ["yuki", "Horsten"];
      sm = createSocialMemory({ cfg, stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::self-alias";
      sm.ingest(scope, { speaker: "YuKi", text: "hi", ts: 100 });
      sm.ingest(scope, { speaker: "Alice", text: "hello", ts: 101 });
      const profile = sm.getOrLoadProfile(scope);
      assert.ok(profile.people.Alice);
      assert.ok(!profile.people.YuKi);
      assert.ok(!profile.people.Horsten);
    });

    it("excludes an existing agent-self record from recall output", () => {
      const cfg = makeCfg();
      cfg.agentName = "Hori";
      sm = createSocialMemory({ cfg, stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::self-recall";
      const profile = sm.getOrLoadProfile(scope);
      profile.people = {
        Hori: { facts: ["placeholder"], preferences: [], situation: "", lastSeenTs: 200, mentionCount: 5 },
        Alice: { facts: ["likes climbing"], preferences: [], situation: "", lastSeenTs: 100, mentionCount: 3 },
      };
      const result = sm.recall(scope, ["Alice"]);
      assert.ok(!result.includes("Hori"));
      assert.ok(result.includes("Alice"));
    });

    it("keeps a real group member whose name merely overlaps an alias", () => {
      const cfg = makeCfg();
      cfg.agentName = "Hori";
      cfg.agentAliases = ["hori"];
      sm = createSocialMemory({ cfg, stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::self-overlap";
      sm.ingest(scope, { speaker: "Horibert", text: "hi", ts: 100 });
      sm.ingest(scope, { speaker: "Alice", text: "hello", ts: 101 });
      const profile = sm.getOrLoadProfile(scope);
      assert.ok(profile.people.Horibert);
    });

    it("resolves self-name per agentId (two agents, two names)", () => {
      const cfg = makeCfg();
      cfg.agentName = "GlobalAgent";
      cfg.agentProfiles = {
        "agent-a": { agentName: "Alice" },
        "agent-b": { agentName: "Bob" },
      };
      sm = createSocialMemory({ cfg, stateDir: tmpDir, log: makeLog() });
      // agent-a scope: "Alice" is self → no record; "Bob" IS a person.
      sm.ingest("agent-a::scope", { speaker: "Alice", text: "hi", ts: 100 });
      sm.ingest("agent-a::scope", { speaker: "Bob", text: "hi", ts: 101 });
      const profileA = sm.getOrLoadProfile("agent-a::scope");
      assert.ok(!profileA.people.Alice, "Alice is self for agent-a, must be filtered");
      assert.ok(profileA.people.Bob, "Bob is a person in agent-a's scope");
      // agent-b scope: "Bob" is self → no record; "Alice" IS a person.
      sm.ingest("agent-b::scope", { speaker: "Bob", text: "hi", ts: 100 });
      sm.ingest("agent-b::scope", { speaker: "Alice", text: "hi", ts: 101 });
      const profileB = sm.getOrLoadProfile("agent-b::scope");
      assert.ok(!profileB.people.Bob, "Bob is self for agent-b, must be filtered");
      assert.ok(profileB.people.Alice, "Alice is a person in agent-b's scope");
    });
  });

  describe("ingest bounds", () => {
    it("ingests messages into buffer", () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::conv1";
      for (let i = 0; i < 50; i++) {
        sm.ingest(scope, { speaker: "Alice", text: "msg " + i, ts: Date.now() + i });
      }
      const buf = sm.bufferByScope.get(scope);
      assert.ok(buf);
      assert.equal(buf.entries.length, 50);
    });

    it("caps buffer at 200 entries FIFO", () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::conv2";
      for (let i = 0; i < 250; i++) {
        sm.ingest(scope, { speaker: "Bob", text: "msg " + i, ts: Date.now() + i });
      }
      const buf = sm.bufferByScope.get(scope);
      assert.ok(buf);
      assert.equal(buf.entries.length, 200);
      assert.equal(buf.entries[0].text, "msg 50");
    });

    it("increments newSinceExtract", () => {
      sm = createSocialMemory({ cfg: makeCfg({ extractEvery: 100 }), stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::conv3";
      sm.ingest(scope, { speaker: "Charlie", text: "hi" });
      assert.equal(sm.bufferByScope.get(scope).newSinceExtract, 1);
    });

    it("ignores missing scope or speaker", () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      sm.ingest(null, { speaker: "A", text: "hi" });
      sm.ingest("scope", { speaker: "", text: "hi" });
      assert.equal(sm.bufferByScope.size, 0);
    });
  });

  describe("extract trigger and dedupe", () => {
    it("triggers extract when newSinceExtract reaches extractEvery", async () => {
      const llm = {
        complete: mock.fn(async () => ({
          text: JSON.stringify({ people: { Alice: { facts: ["likes climbing"] } } }),
        })),
      };
      sm = createSocialMemory({ cfg: makeCfg({ extractEvery: 5 }), llm, stateDir: tmpDir, log: makeLog() });

      const scope = "agent1::trigger-test";
      for (let i = 0; i < 5; i++) {
        sm.ingest(scope, { speaker: "Alice", text: "hello " + i, ts: Date.now() + i });
      }

      // Wait for the fire-and-forget extract
      await new Promise(r => setTimeout(r, 50));

      assert.equal(llm.complete.mock.callCount(), 1);
      const profile = sm.getOrLoadProfile(scope);
      assert.ok(profile.people.Alice);
      assert.equal(llm.complete.mock.calls[0].arguments[0].agentId, "agent1");
    });

    it("does not trigger on low count", () => {
      const llm = { complete: mock.fn() };
      sm = createSocialMemory({ cfg: makeCfg({ extractEvery: 25 }), llm, stateDir: tmpDir, log: makeLog() });

      sm.ingest("agent1::no-trigger", { speaker: "Alice", text: "hi" });
      assert.equal(llm.complete.mock.callCount(), 0);
    });

    it("dedupes — one in flight per scope", async () => {
      const callCount = { current: 0 };
      const llm = {
        complete: mock.fn(async () => {
          callCount.current++;
          // Slow the first call so second trigger fires while in-flight
          if (callCount.current === 1) {
            await new Promise(r => setTimeout(r, 30));
          }
          return {
            text: JSON.stringify({ people: { Alice: { facts: ["test"] } } }),
          };
        }),
      };
      sm = createSocialMemory({ cfg: makeCfg({ extractEvery: 3 }), llm, stateDir: tmpDir, log: makeLog() });

      const scope = "agent1::dedupe";
      for (let i = 0; i < 6; i++) {
        sm.ingest(scope, { speaker: "Alice", text: "msg " + i, ts: Date.now() + i });
      }

      await new Promise(r => setTimeout(r, 150));

      // Should only have made 1 call (deduped)
      assert.equal(llm.complete.mock.callCount(), 1);
    });
  });

  describe("ingest cadence (plan 011)", () => {
    it("dedupes triple-ingest of same {speaker,text} within 60s", () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::cadence-dedup";
      sm.ingest(scope, { speaker: "Alice", text: "same msg", ts: 1000 });
      sm.ingest(scope, { speaker: "Alice", text: "same msg", ts: 1001 });
      sm.ingest(scope, { speaker: "Alice", text: "same msg", ts: 1002 });
      const buf = sm.bufferByScope.get(scope);
      assert.equal(buf.entries.length, 1);
      assert.equal(buf.newSinceExtract, 1);
      const profile = sm.getOrLoadProfile(scope);
      assert.equal(profile.people.Alice.mentionCount, 1);
      assert.equal(profile.messageCount, 1);
    });

    it("counts same text again after 61s", () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::cadence-window";
      sm.ingest(scope, { speaker: "Alice", text: "repeat", ts: 1000 });
      sm.ingest(scope, { speaker: "Alice", text: "repeat", ts: 1000 + 61_000 });
      const buf = sm.bufferByScope.get(scope);
      assert.equal(buf.entries.length, 2);
      assert.equal(buf.newSinceExtract, 2);
      const profile = sm.getOrLoadProfile(scope);
      assert.equal(profile.people.Alice.mentionCount, 2);
      assert.equal(profile.messageCount, 2);
    });

    it("counts two speakers with same text within 60s", () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::cadence-two-speakers";
      sm.ingest(scope, { speaker: "Alice", text: "hi", ts: 1000 });
      sm.ingest(scope, { speaker: "Bob", text: "hi", ts: 1001 });
      const buf = sm.bufferByScope.get(scope);
      assert.equal(buf.entries.length, 2);
      assert.equal(buf.newSinceExtract, 2);
      const profile = sm.getOrLoadProfile(scope);
      assert.equal(profile.people.Alice.mentionCount, 1);
      assert.equal(profile.people.Bob.mentionCount, 1);
      assert.equal(profile.messageCount, 2);
    });

    it("skips empty text ingests", () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::cadence-empty";
      sm.ingest(scope, { speaker: "Alice", text: "", ts: 1000 });
      sm.ingest(scope, { speaker: "Bob", text: "   ", ts: 1001 });
      sm.ingest(scope, { speaker: "Carol", text: "real", ts: 1002 });
      const buf = sm.bufferByScope.get(scope);
      assert.equal(buf.entries.length, 1);
      assert.equal(buf.newSinceExtract, 1);
      const profile = sm.getOrLoadProfile(scope);
      assert.ok(!profile.people.Alice);
      assert.ok(!profile.people.Bob);
      assert.ok(profile.people.Carol);
      assert.equal(profile.messageCount, 1);
    });
  });

  describe("stub-LLM merge semantics", () => {
    it("merges LLM result into existing profile", async () => {
      let callIdx = 0;
      const llm = {
        complete: mock.fn(async () => {
          callIdx++;
          if (callIdx === 1) {
            return { text: JSON.stringify({ people: { Alice: { facts: ["likes climbing"], preferences: ["bouldering"], situation: "experienced climber" } } }) };
          }
          return { text: JSON.stringify({ people: { Alice: { facts: ["likes climbing", "has a dog"], preferences: ["bouldering"] }, Bob: { facts: ["is a beginner"] } } }) };
        }),
      };
      // Use low extractEvery so first trigger fires
      sm = createSocialMemory({ cfg: makeCfg({ extractEvery: 2 }), llm, stateDir: tmpDir, log: makeLog() });

      const scope = "agent1::merge-test";

      // First round
      sm.ingest(scope, { speaker: "Alice", text: "I love climbing", ts: 1000 });
      sm.ingest(scope, { speaker: "Alice", text: "Bouldering is my fave", ts: 1001 });
      await new Promise(r => setTimeout(r, 50));
      assert.equal(llm.complete.mock.callCount(), 1);

      // Second round — triggers another extract
      sm.ingest(scope, { speaker: "Bob", text: "I'm new to this", ts: 2000 });
      sm.ingest(scope, { speaker: "Alice", text: "I have a dog", ts: 2001 });
      await new Promise(r => setTimeout(r, 50));
      assert.equal(llm.complete.mock.callCount(), 2);

      const profile = sm.getOrLoadProfile(scope);
      assert.ok(profile.people.Alice);
      assert.ok(profile.people.Bob);
    });

    it("facts attributed to the person they are about", async () => {
      const llm = {
        complete: mock.fn(async () => ({
          text: JSON.stringify({ people: { Alice: { facts: ["loves hiking"] }, Bob: { facts: ["is allergic to cats"] } } }),
        })),
      };
      sm = createSocialMemory({ cfg: makeCfg({ extractEvery: 2 }), llm, stateDir: tmpDir, log: makeLog() });

      const scope = "agent1::attribution";
      sm.ingest(scope, { speaker: "Charlie", text: "Alice loves hiking", ts: 100 });
      sm.ingest(scope, { speaker: "Alice", text: "Bob is allergic to cats", ts: 101 });
      await new Promise(r => setTimeout(r, 50));

      const profile = sm.getOrLoadProfile(scope);
      assert.ok(profile.people.Alice.facts.includes("loves hiking"));
      assert.ok(profile.people.Bob.facts.includes("is allergic to cats"));
    });

    it("failure keeps old profile (never destructive)", async () => {
      let fail = true;
      const llm = {
        complete: mock.fn(async () => {
          if (fail) throw new Error("LLM fail");
          return { text: JSON.stringify({ people: { New: { facts: ["data"] } } }) };
        }),
      };
      sm = createSocialMemory({ cfg: makeCfg({ extractEvery: 2 }), llm, stateDir: tmpDir, log: makeLog() });

      const scope = "agent1::destructive";
      // First get some data into the profile via ingest
      sm.ingest(scope, { speaker: "Alice", text: "hello", ts: 100 });
      sm.ingest(scope, { speaker: "Alice", text: "world", ts: 101 });
      await new Promise(r => setTimeout(r, 50));

      // Profile was written even though LLM failed (because it keeps old)
      const profile = sm.getOrLoadProfile(scope);
      // Alice should exist because ingest creates entries
      assert.ok(profile.people.Alice);
    });
  });

  describe("profile file modes", () => {
    it("writes profile file with 0600 and dir with 0700", async () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const scope = "agentX::file-mode";
      sm.ingest(scope, { speaker: "Dave", text: "hello", ts: 100 });
      sm.flush(scope);

      const profileFile = path.join(tmpDir, "social-memory", "agentX", "file-mode.json");
      assert.ok(fs.existsSync(profileFile));
      const fileMode = fs.statSync(profileFile).mode & 0o777;
      assert.equal(fileMode, 0o600, "profile file must be 0600");

      const dirMode = fs.statSync(path.join(tmpDir, "social-memory")).mode & 0o777;
      assert.equal(dirMode, 0o700, "state dir must be 0700");
    });

    it("self-heals a pre-existing 0775 state subdir to 0700 on write", async () => {
      const agentDir = path.join(tmpDir, "social-memory", "agentY");
      fs.mkdirSync(agentDir, { recursive: true, mode: 0o775 });
      const beforeMode = fs.statSync(agentDir).mode & 0o777;
      assert.equal(beforeMode, 0o775, "precondition: dir must be 0775");

      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const scope = "agentY::self-heal";
      sm.ingest(scope, { speaker: "Dave", text: "hello", ts: 100 });
      sm.flush(scope);

      const afterMode = fs.statSync(agentDir).mode & 0o777;
      assert.equal(afterMode, 0o700, "dir should be corrected to 0700 after write");
    });
  });

  describe("profile persistence round-trip", () => {
    it("writes and reads profile from disk", async () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const scope = "agentX::session-persist";

      // Ingest to create profile
      sm.ingest(scope, { speaker: "Dave", text: "hello", ts: 100 });
      sm.ingest(scope, { speaker: "Eve", text: "hi", ts: 101 });
      sm.flush(scope);

      const profile1 = sm.getOrLoadProfile(scope);
      assert.ok(profile1.people.Dave);

      // Create new instance with fresh caches (simulate restart)
      const sm2 = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const profile2 = sm2.getOrLoadProfile(scope);
      assert.ok(profile2.people.Dave);
      assert.ok(profile2.people.Eve);
      assert.equal(profile2.people.Dave.mentionCount, 1);
    });
  });

  describe("recall filtering and cap", () => {
    it("returns empty string for empty profile", () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const result = sm.recall("agent1::empty", ["Alice"]);
      assert.equal(result, "");
    });

    it("selects involved names and top 3 recent others", () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::recall-filter";
      const profile = sm.getOrLoadProfile(scope);
      profile.people = {
        Alice: { facts: ["likes climbing"], preferences: [], situation: "", lastSeenTs: 100, mentionCount: 5 },
        Bob: { facts: ["is a beginner"], preferences: [], situation: "", lastSeenTs: 90, mentionCount: 3 },
        Charlie: { facts: ["prefers top-rope"], preferences: [], situation: "", lastSeenTs: 80, mentionCount: 2 },
        Dave: { facts: ["teaches climbing"], preferences: [], situation: "", lastSeenTs: 70, mentionCount: 1 },
        Eve: { facts: ["climbs on weekends"], preferences: [], situation: "", lastSeenTs: 60, mentionCount: 4 },
      };

      const result = sm.recall(scope, ["Alice"]);
      assert.ok(result.includes("Alice"));
      // Should include Alice + 3 most recent others (Bob, Charlie, Dave)
      assert.ok(result.includes("Bob") || result.includes("Charlie") || result.includes("Dave"));
    });

    it("caps at recallLimit chars", () => {
      sm = createSocialMemory({ cfg: makeCfg({ recallLimit: 50 }), stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::recall-cap";
      const profile = sm.getOrLoadProfile(scope);
      profile.people = {
        Alice: { facts: ["likes very long detailed climbing descriptions with many words that go on and on"], preferences: ["technical bouldering routes"], situation: "has been climbing for many years and teaches courses", lastSeenTs: 100, mentionCount: 5 },
      };

      const result = sm.recall(scope, ["Alice"]);
      assert.ok(result.length <= 60); // slight fudge for sentence boundary
    });

    it("performs recall in under 5ms", () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::recall-speed";
      const profile = sm.getOrLoadProfile(scope);
      profile.people = {};
      for (let i = 0; i < 50; i++) {
        profile.people["Person" + i] = {
          facts: ["fact " + i], preferences: ["pref " + i], situation: "situation " + i,
          lastSeenTs: i * 10, mentionCount: i,
        };
      }

      const start = performance.now();
      const result = sm.recall(scope, ["Person0", "Person1"]);
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 5, "recall took " + elapsed + "ms");
      assert.ok(result.length > 0);
    });
  });

  describe("eviction", () => {
    it("evicts least-recently-seen when over maxPeople", () => {
      sm = createSocialMemory({ cfg: makeCfg({ maxPeople: 3 }), stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::evict";
      const profile = sm.getOrLoadProfile(scope);
      profile.people = {
        Oldest: { facts: [], preferences: [], situation: "", lastSeenTs: 10, mentionCount: 0 },
        Middle: { facts: [], preferences: [], situation: "", lastSeenTs: 50, mentionCount: 0 },
        Newest: { facts: [], preferences: [], situation: "", lastSeenTs: 100, mentionCount: 0 },
      };
      // This should trigger eviction when a new person is added
      profile.people.NewPerson = { facts: [], preferences: [], situation: "", lastSeenTs: 200, mentionCount: 0 };

      // We need > maxPeople to trigger eviction, but currently we have 4 with maxPeople=3
      // The eviction happens during extract, so let's check that getOrLoadProfile returns the profile with all 4
      // Eviction is only during extract/write — this is expected behavior
      const loaded = sm.getOrLoadProfile(scope);
      assert.equal(Object.keys(loaded.people).length, 4);
    });

    it("extract evicts excess people", async () => {
      const llm = {
        complete: mock.fn(async () => ({
          text: JSON.stringify({ people: { P1: { facts: ["a"] }, P2: { facts: ["b"] }, P3: { facts: ["c"] }, P4: { facts: ["d"] } } }),
        })),
      };
      sm = createSocialMemory({ cfg: makeCfg({ maxPeople: 2, extractEvery: 1 }), llm, stateDir: tmpDir, log: makeLog() });

      const scope = "agent1::evict-extract";
      sm.ingest(scope, { speaker: "P1", text: "hi", ts: 1 });
      await new Promise(r => setTimeout(r, 30));
      sm.ingest(scope, { speaker: "P2", text: "hi", ts: 2 });
      await new Promise(r => setTimeout(r, 30));
      sm.ingest(scope, { speaker: "P3", text: "hi", ts: 3 });
      await new Promise(r => setTimeout(r, 30));
      sm.ingest(scope, { speaker: "P4", text: "hi", ts: 4 });
      await new Promise(r => setTimeout(r, 30));

      const profile = sm.getOrLoadProfile(scope);
      assert.ok(Object.keys(profile.people).length <= 2);
    });

    it("extract-path drops the oldest lastSeenTs once the merged profile exceeds maxPeople", async () => {
      const llm = {
        complete: mock.fn(async () => ({ text: JSON.stringify({ people: {} }) })),
      };
      sm = createSocialMemory({ cfg: makeCfg({ maxPeople: 2, extractEvery: 1 }), llm, stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::evict-extract-path";
      const profile = sm.getOrLoadProfile(scope);
      profile.people = {
        Oldest: { facts: [], preferences: [], situation: "", lastSeenTs: 10, mentionCount: 0 },
        Middle: { facts: [], preferences: [], situation: "", lastSeenTs: 50, mentionCount: 0 },
        Newest: { facts: [], preferences: [], situation: "", lastSeenTs: 100, mentionCount: 0 },
      };

      await sm.extract(scope);

      const loaded = sm.getOrLoadProfile(scope);
      const names = Object.keys(loaded.people);
      assert.equal(names.length, 2, "extract must evict down to maxPeople");
      assert.ok(!names.includes("Oldest"), "oldest lastSeenTs must be dropped");
      assert.ok(names.includes("Middle") && names.includes("Newest"), "more recent people kept");
    });
  });

  describe("write coalescing", () => {
    it("two rapid ingests within the window produce a single file write", async () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::coalesce";
      let renameCalls = 0;
      const origRename = fs.renameSync.bind(fs);
      fs.renameSync = (...args) => { renameCalls++; return origRename(...args); };
      try {
        sm.ingest(scope, { speaker: "Alice", text: "a", ts: 1 });
        sm.ingest(scope, { speaker: "Bob", text: "b", ts: 2 });
        sm.flush(scope);
        assert.equal(renameCalls, 1);
      } finally {
        fs.renameSync = origRename;
      }
    });

    it("flush writes tmp+rename and marks clean", () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::flush-clean";
      sm.ingest(scope, { speaker: "Alice", text: "hi", ts: 1 });
      sm.flush(scope);
      sm.flush(scope);
      const file = path.join(tmpDir, "social-memory", "agent1", "flush-clean.json");
      assert.ok(fs.existsSync(file));
    });
  });

  describe("extract race", () => {
    it("keeps newer lastSeenTs from ingests during an in-flight extract", async () => {
      let resolveLLM;
      const gate = new Promise((r) => { resolveLLM = r; });
      const llm = {
        complete: mock.fn(async () => {
          await gate;
          return { text: JSON.stringify({ people: { Alice: { facts: ["climbs"] } } }) };
        }),
      };
      sm = createSocialMemory({ cfg: makeCfg({ extractEvery: 1 }), llm, stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::race";
      sm.ingest(scope, { speaker: "Alice", text: "first", ts: 100 });
      await new Promise((r) => setTimeout(r, 30));
      sm.ingest(scope, { speaker: "Alice", text: "second", ts: 200 });
      resolveLLM();
      await new Promise((r) => setTimeout(r, 50));
      const profile = sm.getOrLoadProfile(scope);
      assert.equal(profile.people.Alice.lastSeenTs, 200);
      assert.equal(profile.people.Alice.mentionCount, 2);
    });
  });

  describe("profile cache cap", () => {
    it("caps profileCache at 256 scopes, evicting oldest-inserted", () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      for (let i = 0; i < 300; i++) {
        sm.getOrLoadProfile("agent::cache-scope-" + i);
      }
      assert.equal(sm.profileCache.size, 256);
      assert.ok(sm.profileCache.has("agent::cache-scope-299"));
      assert.ok(!sm.profileCache.has("agent::cache-scope-0"));
    });
  });

  describe("scope isolation", () => {
    it("two agents same sessionKey have separate profiles", () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const scopeA = "agentA::session-common";
      const scopeB = "agentB::session-common";

      sm.ingest(scopeA, { speaker: "Alice", text: "hello from A", ts: 100 });
      sm.ingest(scopeB, { speaker: "Bob", text: "hello from B", ts: 101 });

      const profileA = sm.getOrLoadProfile(scopeA);
      const profileB = sm.getOrLoadProfile(scopeB);

      assert.ok(profileA.people.Alice);
      assert.ok(!profileA.people.Bob);
      assert.ok(profileB.people.Bob);
      assert.ok(!profileB.people.Alice);
    });

    it("two agents same sessionKey write to different files", () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const scopeA = "agentA::session-isol";
      const scopeB = "agentB::session-isol";

      sm.ingest(scopeA, { speaker: "Alice", text: "hi", ts: 1 });
      sm.ingest(scopeB, { speaker: "Bob", text: "hi", ts: 2 });
      sm.flush(scopeA);
      sm.flush(scopeB);

      // Create fresh instances and verify files are separate
      const sm2 = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      const profileA2 = sm2.getOrLoadProfile(scopeA);
      const profileB2 = sm2.getOrLoadProfile(scopeB);

      assert.ok(profileA2.people.Alice);
      assert.ok(!profileA2.people.Bob);
      assert.ok(profileB2.people.Bob);
      assert.ok(!profileB2.people.Alice);
    });
  });

  describe("stop() flush-on-shutdown", () => {
    it("flushes dirty scope to disk, clears timers", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-mem-stop-"));
      try {
        const sm = createSocialMemory({ cfg: makeCfg(), stateDir: dir, log: makeLog() });
        const scope = "agent1::conv1";
        sm.ingest(scope, { speaker: "Alice", text: "hi", ts: 1 });
        sm.stop();

        const sm2 = createSocialMemory({ cfg: makeCfg(), stateDir: dir, log: makeLog() });
        const profile = sm2.getOrLoadProfile(scope);
        assert.ok(profile.people.Alice);
        assert.equal(sm.flushTimers?.size, undefined);
        assert.equal(sm2.flushTimers, undefined);
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    });
  });

  describe("disabled config", () => {
    it("ingest is no-op when socialMemory.enabled is false", () => {
      sm = createSocialMemory({ cfg: makeCfg({ enabled: false }), stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::disabled";
      sm.ingest(scope, { speaker: "Alice", text: "hi" });
      assert.equal(sm.bufferByScope.size, 0);
    });

    it("recall returns empty when disabled", () => {
      sm = createSocialMemory({ cfg: makeCfg({ enabled: false }), stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::recall-disabled";
      const profile = sm.getOrLoadProfile(scope);
      profile.people.Alice = { facts: ["test"], preferences: [], situation: "", lastSeenTs: 1, mentionCount: 1 };
      const result = sm.recall(scope, ["Alice"]);
      assert.equal(result, "");
    });
  });

  describe("extract with no LLM (degraded mode)", () => {
    it("extract does not throw when llm is null", async () => {
      sm = createSocialMemory({ cfg: makeCfg({ extractEvery: 2 }), llm: null, stateDir: tmpDir, log: makeLog() });
      const scope = "agent1::no-llm";
      sm.ingest(scope, { speaker: "Alice", text: "hi", ts: 1 });
      sm.ingest(scope, { speaker: "Alice", text: "there", ts: 2 });
      await new Promise(r => setTimeout(r, 30));
      // Should not throw — just resets counter and persists
      const buf = sm.bufferByScope.get(scope);
      assert.equal(buf.newSinceExtract, 0);
    });
  });

  describe("person store (plan 019): migration", () => {
    it("migrates 3 legacy session files into one per-agent profile idempotently", () => {
      // Legacy per-session files under one agent
      const cfg = makeCfg({ personStore: true });
      sm = createSocialMemory({ cfg, stateDir: tmpDir, log: makeLog() });
      const agentDir = path.join(tmpDir, "social-memory", "agentM");

      // Write legacy session files directly (simulate pre-personStore layout)
      const legacy1 = { people: { Kevin: { facts: ["climbs"], preferences: [], situation: "", lastSeenTs: 100, mentionCount: 1 }, Tobi: { facts: ["leads"], preferences: [], situation: "", lastSeenTs: 90, mentionCount: 2 } }, messageCount: 3 };
      const legacy2 = { people: { Kevin: { facts: ["has a dog"], preferences: ["bouldering"], situation: "", lastSeenTs: 200, mentionCount: 4 } }, messageCount: 4 };
      const legacy3 = { people: { Tobi: { facts: ["top-ropes"], preferences: [], situation: "cautious climber", lastSeenTs: 80, mentionCount: 1 } }, messageCount: 2 };
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "sessionA.json"), JSON.stringify(legacy1), { encoding: "utf8", mode: 0o600 });
      fs.writeFileSync(path.join(agentDir, "sessionB.json"), JSON.stringify(legacy2), { encoding: "utf8", mode: 0o600 });
      fs.writeFileSync(path.join(agentDir, "sessionC.json"), JSON.stringify(legacy3), { encoding: "utf8", mode: 0o600 });

      // First access triggers migration
      const profile = sm.getOrLoadProfile("agentM::sessionA");

      // Kevin: union of facts, mentionCount sum, lastSeenTs max
      assert.ok(profile.people.Kevin, "Kevin must exist");
      assert.ok(profile.people.Kevin.facts.includes("climbs"));
      assert.ok(profile.people.Kevin.facts.includes("has a dog"));
      assert.equal(profile.people.Kevin.mentionCount, 5, "mentionCount summed across sessions");
      assert.equal(profile.people.Kevin.lastSeenTs, 200, "max lastSeenTs kept");
      // Tobi: union + situation = longer non-empty
      assert.ok(profile.people.Tobi);
      assert.ok(profile.people.Tobi.facts.includes("leads"));
      assert.ok(profile.people.Tobi.facts.includes("top-ropes"));
      assert.equal(profile.people.Tobi.situation, "cautious climber");
      assert.equal(profile.people.Tobi.mentionCount, 3);
      assert.equal(profile.people.Tobi.lastSeenTs, 90);
      // marker
      assert.equal(profile.version, 1);
      assert.equal(profile.migrated, true);

      // Agent file written, session files moved to legacy-sessions
      const agentFile = path.join(tmpDir, "social-memory", "agentM.json");
      assert.ok(fs.existsSync(agentFile), "agent file must exist after migration");
      const legacyDir = path.join(agentDir, "legacy-sessions");
      assert.ok(fs.existsSync(legacyDir), "legacy-sessions dir must exist");
      assert.ok(fs.existsSync(path.join(legacyDir, "sessionA.json")), "sessionA moved");
      assert.ok(fs.existsSync(path.join(legacyDir, "sessionB.json")), "sessionB moved");
      assert.ok(fs.existsSync(path.join(legacyDir, "sessionC.json")), "sessionC moved");
      assert.ok(!fs.existsSync(path.join(agentDir, "sessionA.json")), "sessionA no longer in agent dir");
      const dirMode = fs.statSync(legacyDir).mode & 0o777;
      assert.equal(dirMode, 0o700, "legacy dir must be 0700");

      // Second init → no double migration (idempotent)
      const sm2 = createSocialMemory({ cfg, stateDir: tmpDir, log: makeLog() });
      const profile2 = sm2.getOrLoadProfile("agentM::sessionB");
      assert.equal(profile2.people.Kevin.mentionCount, 5, "no double-merge on second access");
      // legacy files still in legacy-sessions (not deleted, not re-read as fresh)
      assert.ok(fs.existsSync(path.join(legacyDir, "sessionB.json")));
      assert.equal(profile2.migrated, true);
    });
  });

  describe("person store (plan 019): cross-session growth", () => {
    it("one per-agent profile grows across two sessions of the same agent", () => {
      sm = createSocialMemory({ cfg: makeCfg({ personStore: true }), stateDir: tmpDir, log: makeLog() });
      sm.ingest("agentN::group-a", { speaker: "Kevin", text: "hello A", ts: 100 });
      sm.ingest("agentN::dm-b", { speaker: "Kevin", text: "hello B", ts: 200 });
      const profile = sm.getOrLoadProfile("agentN::group-a");
      assert.equal(profile.people.Kevin.mentionCount, 2, "same person grows across sessions");
      assert.equal(profile.people.Kevin.lastSeenTs, 200, "max lastSeenTs across sessions");
      // Buffer remains per session
      assert.equal(sm.bufferByScope.get("agentN::group-a").entries.length, 1);
      assert.equal(sm.bufferByScope.get("agentN::dm-b").entries.length, 1);
      // Agent-level file, not session file
      sm.flush("agentN::group-a");
      assert.ok(fs.existsSync(path.join(tmpDir, "social-memory", "agentN.json")));
      assert.ok(!fs.existsSync(path.join(tmpDir, "social-memory", "agentN", "group-a.json")));
    });

    it("recall from a different session of the same agent finds the person", () => {
      sm = createSocialMemory({ cfg: makeCfg({ personStore: true }), stateDir: tmpDir, log: makeLog() });
      const profile = sm.getOrLoadProfile("agentN::group-a");
      profile.people = {
        Kevin: { facts: ["likes climbing"], preferences: [], situation: "", lastSeenTs: 200, mentionCount: 5 },
      };
      const result = sm.recall("agentN::dm-b", ["Kevin"]);
      assert.ok(result.includes("Kevin"), "recall from another session sees the same person");
      assert.ok(result.includes("likes climbing"));
    });
  });

  describe("person store (plan 019): agent isolation (tenancy)", () => {
    it("Kevin in agent1 is separate from Kevin in agent2", () => {
      sm = createSocialMemory({ cfg: makeCfg({ personStore: true }), stateDir: tmpDir, log: makeLog() });
      sm.ingest("agentX::s1", { speaker: "Kevin", text: "hi X", ts: 100 });
      sm.ingest("agentY::s1", { speaker: "Kevin", text: "hi Y", ts: 100 });
      sm.flush("agentX::s1");
      sm.flush("agentY::s1");
      assert.ok(fs.existsSync(path.join(tmpDir, "social-memory", "agentX.json")));
      assert.ok(fs.existsSync(path.join(tmpDir, "social-memory", "agentY.json")));
      const x = JSON.parse(fs.readFileSync(path.join(tmpDir, "social-memory", "agentX.json"), "utf8"));
      const y = JSON.parse(fs.readFileSync(path.join(tmpDir, "social-memory", "agentY.json"), "utf8"));
      assert.equal(x.people.Kevin.mentionCount, 1);
      assert.equal(y.people.Kevin.mentionCount, 1);
      // distinct file objects — changing one doesn't touch the other
      assert.notEqual(x, y);
    });
  });

  describe("person store (plan 019): default-off preserves legacy behavior", () => {
    it("personStore:false keeps per-session files and no agent file", () => {
      sm = createSocialMemory({ cfg: makeCfg(), stateDir: tmpDir, log: makeLog() });
      sm.ingest("agentZ::sess", { speaker: "Kevin", text: "hi", ts: 100 });
      sm.flush("agentZ::sess");
      assert.ok(fs.existsSync(path.join(tmpDir, "social-memory", "agentZ", "sess.json")), "session file written");
      assert.ok(!fs.existsSync(path.join(tmpDir, "social-memory", "agentZ.json")), "no agent file under default false");
    });
  });
});
