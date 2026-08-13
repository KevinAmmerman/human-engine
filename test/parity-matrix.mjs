#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MATRIX = [
  { id: 1,  behavior: "Inbound text → {sender, content}; empty text w/o media dropped",
    tags: ["messages", "converts text event", "drops empty"] },
  { id: 2,  behavior: "Media placeholders [image]/[video]/[voice message]/[audio]/[document]/[sticker]/[media] + has_media",
    tags: ["placeholder", "[image]", "[video]", "[voice message]", "[audio]", "[document]", "[sticker]", "[media]"] },
  { id: 3,  behavior: "Discord placeholder sentence → empty only w/ media",
    tags: ["Discord placeholder", "no text content"] },
  { id: 4,  behavior: "Mention annotation @you/@Name",
    tags: ["@you", "mention"] },
  { id: 5,  behavior: "Caps: sender 255, content 4000, ≤20 msgs (newest kept)",
    tags: ["caps sender", "caps content", "newest 20"] },
  { id: 6,  behavior: "Slash commands bypass gate",
    tags: ["command bypass"] },
  { id: 7,  behavior: "stay_silent → before_agent_reply {handled:true} (turn silenced before the LLM call, cheap, no leak) + observed buffered + message_sending cancels residual block text",
    tags: ["stay_silent", "handled:true silences", "observed", "onMessageSending"] },
  { id: 8,  behavior: "Observed injected next turn, drained once",
    tags: ["appendContext", "observed", "onBeforePromptBuild"] },
  { id: 9,  behavior: "DM fail-open (engine null → dispatch)",
    tags: ["DM fail-open", "fail-open"] },
  { id: 10, behavior: "Group fail-closed → before_agent_reply {handled:true} (engine null) + message_sending cancels residual block text",
    tags: ["group fail-closed", "handled:true", "onMessageSending"] },
  { id: 11, behavior: "Speak → epoch stashed per sessionKey; real reply captured at reply_payload_sending (original cancelled) and rebubbled",
    tags: ["stashes epoch", "captured reply payload", "epoch exists"] },
  { id: 12, behavior: "Newer epoch → pending bubbles cancelled (supersede)",
    tags: ["supersede", "epoch bump", "cancels remaining"] },
  { id: 13, behavior: "Split: 1–5 bubbles ≤400 chars, fallback raw draft",
    tags: ["respond", "scheduled", "draft fallback"] },
  { id: 14, behavior: "Engine error → single-bubble draft, reply never lost",
    tags: ["LLM error", "draft fallback", "reply never lost"] },
  { id: 15, behavior: "One thread/session; concurrent opens deduped",
    tags: ["increments epoch on each speak", "openThread"] },
  { id: 16, behavior: "Bubbles delivered in order at increasing delays",
    tags: ["bubbles", "increasing delays", "timing"] },
  { id: 17, behavior: "Zero network in entire plugin (fetch/WebSocket absent)",
    tags: ["no-residue", "openclaw/dist", "no references"] },
  { id: 18, behavior: "Memory label: 'What you know about the people here (from memory):'",
    tags: ["appendSystemContext", "What you know about the people here"] },
  { id: 19, behavior: "Persona = SOUL.md + voice card + anti-tell + style-stats",
    tags: ["persona", "voice card", "SOUL.md", "antiTell"] },
  { id: 20, behavior: "Voice card: refresh cadence, one in flight, disk-persisted",
    tags: ["voice-card", "cache", "extractVoiceCard"] },
  { id: 21, behavior: "/soul: seed check → enhance → .bak → write → exact strings",
    tags: ["soul", "enhance", "seed", "backup"] },
  { id: 22, behavior: "Kill-switch enabled:false → all handlers no-op, zero LLM calls",
    tags: ["kill-switch", "returns undefined", "enabled:false"] },
  { id: 23, behavior: "Agent scoping agents:['a'] → other agentId untouched",
    tags: ["unscoped agent"] },
  { id: 24, behavior: "Hook errors never throw into the chain; DM errors fail open (undefined), group gate errors fail closed (handled:true)",
    tags: ["fail-open", "errors do not throw"] },
  { id: 25, behavior: "Autoconfig: only scoped keys, idempotent, opt-in",
    tags: ["autoconfig", "scoped paths", "idempotent"] },
  { id: 26, behavior: "Timing variation (CV > 0.15) + research ranges",
    tags: ["timing-distribution", "CV", "coefficient of variation"] },
  { id: 27, behavior: "Night-mode multiplier",
    tags: ["night", "nightMode", "23:00"] },
  { id: 28, behavior: "DM/media/trigger decide short-circuits, zero LLM calls",
    tags: ["short-circuit", "zero LLM", "decide"] },
  { id: 29, behavior: "Anti-tell: zero detected tells in split fixtures",
    tags: ["zero tells in split fixture", "clean casual"] },
  { id: 30, behavior: "Style-stats: caps/emoji/contraction computed + injected",
    tags: ["style-stats", "avgLen", "capsRate", "emojiRate", "contractionRate"] },
  { id: 31, behavior: "/connect removed (no command, no code)",
    tags: ["connect removed", "command snapshot", "no references"] },
  { id: 32, behavior: "Decide-scenarios contract: ≥ 20 labeled, deterministic green",
    tags: ["at least 20 labeled scenarios", "every scenario has required fields"] },
  { id: 33, behavior: "Social memory: ingest bounded, extract on cadence, one in flight",
    tags: ["caps buffer", "triggers extract", "one in flight"] },
  { id: 34, behavior: "Person-centric merge: facts attributed to the person they are about; durable-only",
    tags: ["facts attributed to the person they are about", "merge semantics"] },
  { id: 35, behavior: "Recall on speak only, ≤800 chars, scope-isolated per agent × conversation",
    tags: ["caps at recalllimit chars", "two agents same sessionkey", "speak turn populates memory"] },
];

const TESTS_DIR = resolve(__dirname);
const SKIPPED = [];

function isSkipped(id) {
  return SKIPPED.includes(id);
}

function collectTestFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = resolve(dir, e.name);
    if (e.isDirectory() && e.name !== "node_modules" && e.name !== "fixtures") {
      files.push(...collectTestFiles(full));
    } else if (e.isFile() && (e.name.endsWith(".test.js") || e.name.endsWith(".test.mjs"))) {
      files.push(full);
    }
  }
  return files;
}

function scanTestFiles() {
  const files = collectTestFiles(TESTS_DIR);
  const testNames = new Set();
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const line of content.split("\n")) {
      const m = line.match(/(?:it|test)\s*\(\s*["'`](.+?)["'`]/);
      if (m) testNames.add(m[1].toLowerCase());
    }
  }
  return testNames;
}

function check() {
  const testNames = scanTestFiles();
  let covered = 0;
  let skipped = 0;
  const results = [];

  for (const row of MATRIX) {
    let found = false;
    for (const tag of row.tags) {
      const lowerTag = tag.toLowerCase();
      for (const name of testNames) {
        if (name.includes(lowerTag)) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (found) {
      covered++;
      results.push(`  \u2713  #${String(row.id).padStart(2)} ${row.behavior}`);
    } else if (isSkipped(row.id)) {
      skipped++;
      results.push(`  \u223c  #${String(row.id).padStart(2)} ${row.behavior} [skipped]`);
    } else {
      results.push(`  \u2717  #${String(row.id).padStart(2)} ${row.behavior} [NOT FOUND]`);
    }
  }

  const total = 35;
  console.log(`\nParity matrix: ${covered + skipped}/${total} covered (${covered} tested, ${skipped} skipped)`);
  console.log(results.join("\n") + "\n");

  if (covered + skipped < total) {
    console.error(`FAIL: ${total - covered - skipped} row(s) uncovered.`);
    process.exit(1);
  }
}

if (process.argv.includes("--check")) {
  check();
} else {
  console.log("Parity matrix (%d rows). Use --check to verify coverage.", MATRIX.length);
  MATRIX.forEach((r) => console.log("  #%d  %s", String(r.id).padStart(2), r.behavior));
}
