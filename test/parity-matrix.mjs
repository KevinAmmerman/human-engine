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
    tags: ["increments epoch on each speak"] },
  { id: 16, behavior: "Bubbles delivered in order at increasing delays",
    tags: ["bubbles", "increasing delays", "timing"] },
  { id: 17, kind: "static", behavior: "Zero network in entire plugin (fetch/WebSocket absent)",
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
  { id: 25, behavior: "Autoconfig: opt-in warnings-only advisory (no channel changes, no dead-model keys)",
    tags: ["autoconfig", "no channel changes", "dead-model"] },
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
  { id: 31, kind: "static", behavior: "/connect removed (no command, no code)",
    tags: ["connect removed", "command snapshot", "no references"] },
  { id: 32, behavior: "Decide-scenarios contract: ≥ 20 labeled, deterministic green",
    tags: ["at least 20 labeled scenarios", "every scenario has required fields"] },
  { id: 33, behavior: "Social memory: ingest bounded, extract on cadence, one in flight",
    tags: ["caps buffer", "triggers extract", "one in flight"] },
  { id: 34, behavior: "Person-centric merge: facts attributed to the person they are about; durable-only",
    tags: ["facts attributed to the person they are about", "merge semantics"] },
  { id: 35, behavior: "Recall on speak only, ≤800 chars, scope-isolated per agent × conversation",
    tags: ["caps at recalllimit chars", "two agents same sessionkey", "speak turn populates memory"] },
  { id: 36, behavior: "Proactive: 3-stage funnel, shadow default, budget/cooldown/quiet-hours, subagent.run deliver, no gate loop",
    tags: ["proactive", "shadow sends nothing but logs", "budget enforcement", "cooldown", "quiet hours", "deliver:true", "idempotencykey", "subagent.run"] },
  { id: 37, behavior: "dm-proactive shadow-v2: envelope send passes through (envelope stripped, never cancels/rewrites), candidate + gate verdicts + renderPreview logged; plain agent text untouched; malformed envelope warn + pass-through",
    tags: ["shadow=true passes through with the envelope stripped", "non-commitment outbound text produces no log entry", "malformed envelope warns and passes through"] },
  { id: 38, behavior: "dm-proactive: care anti-annoyance — max 1 care send/day, hard 48h no-reply care rule survives day rollover",
    tags: ["2nd care candidate the same day is blocked by care-budget", "care send without reply for >=48h blocks further care", "budget/care markers survive recreate"] },
  { id: 39, behavior: "dm-proactive: quiet hours 23-07 hard in Europe/Berlin with deadline exception (latestMs - now < 2h)",
    tags: ["22:30 Berlin (20:30 UTC, summer) is NOT quiet", "quiet hours 23:30 block unless the deadline is <2h away"] },
  { id: 40, behavior: "dm-proactive live: gate-pass cancels original + sends rendered draft once via subagent.run with idempotencyKey, budget bumped only after a successful send; duplicate id cancels without a second send",
    tags: ["sends via subagent.run deliver with idempotency key", "budget not bumped after failed send", "duplicate sentId in live"] },
  { id: 41, behavior: "own replies survive restart in decide context (observed store, merged transcript)",
    tags: ["own replies survive restart"] },
  { id: 42, behavior: "decide context ordering: chronological merge + NO_REPLY filter + ts backfill",
    tags: ["chronological merge", "no_reply filter", "ts backfill"] },
  { id: 43, behavior: "system fallback payloads (no-visible-reply / queue-cap) suppressed in capture",
    tags: ["suppressed system fallback payload"] },
  { id: 44, behavior: "named-first transcript dedup (named copy wins over anonymous) + topical follow-up rule",
    tags: ["named peek copy wins", "topical pick-ups"] },
  { id: 45, behavior: "directly-addressed decide rule incl. second-person addressee",
    tags: ["second-person addressee", "directly-addressed rule"] },
  { id: 46, behavior: "FIFO dispatcher binding survives later-message silence",
    tags: ["oldest unconsumed dispatcher", "silence completes only unconsumed", "displacement no longer completes"] },
  { id: 47, behavior: "Mood: stateful valence/energy per DM session, default off, injection via appendSystemContext",
    tags: ["current mood state", "mood injection", "appendSystemContext"] },
  { id: 48, behavior: "Mood: master switch + chat-type + agent scoping gate injection (dm-only, never groups)",
    tags: ["mood disabled returns undefined", "mood group chat returns undefined", "mood unscoped agent"] },
  { id: 49, behavior: "Mood: appraisal clamps shift per axis, note trimmed to 8 words, unparseable keeps state",
    tags: ["maxshiftperupdate", "note trimmed", "mood appraisal unparseable"] },
  { id: 50, behavior: "Mood: decay pulls valence/energy toward neutral after quiet period and clears note",
    tags: ["mood decay", "halves valence"] },
  { id: 51, behavior: "naturalize.disableDM: DM replies pass through as one raw message (no bubbles, no cancel, own reply persisted) while group arming/bubbling is unchanged",
    tags: ["disabledm"] },
  { id: 52, behavior: "social cards are isolated per agent: per-agent cache buckets, per-agent eviction, perSessionCard:false collapses per agent only (v1 cache migrates on load)",
    tags: ["social card isolation"] },
  { id: 53, behavior: "dm-proactive tenancy: dmProactive.agents overrides global agents (DM lane stays gated while global features unscope the agent)", tags: ["dm-proactive tenancy"] },
  { id: 54, behavior: "proactive/dm-proactive state isolated per agent: per-agent sentIds and byKind buckets (legacy v2 migrates), per-agent proactive budgets/eviction", tags: ["proactive tenancy"] },
  { id: 55, behavior: "onboarding a new agent/group is declarative (profiles + files only) and misconfiguration warns loudly at startup (autoconfig), incl. inert-profile and missing-paths cases",
    tags: ["new agent in 3 files", "profile exists but agent not in agents allowlist"] },
  { id: 56, behavior: "host agent-run-failed fallback payloads (⚠️ Agent run failed (model: …)) are suppressed at capture like Plan-540 fallbacks — never captured, never humanized, never delivered",
    tags: ["agent-run-failed suppression"] },
  { id: 57, behavior: "transcript dedup is speaker-aware: distinct speakers with identical text or media markers are never collapsed; anonymous-vs-named cross-layer dedup (Plan 543) preserved",
    tags: ["speaker-aware dedup: distinct named speakers", "speaker-aware dedup: distinct speakers with identical media marker", "speaker-aware dedup: same speaker", "named-first dedup", "decide-ctx lastSpeaker"] },
  { id: 58, behavior: "untrusted wrapping is complete on all prompt builders incl. regenerate + persona/memory/voice-card + mood note",
    tags: ["carries the untrusted-data directive in the system prompt", "wraps the transcript block in group chat log markers", "includes voice card when available", "includes memory when present", "renderInjection resolves semantic labels"] },
  { id: 59, behavior: "decide verdict parsing tolerates model noise (fences/JSON/prose) via token extraction, exact-match fast path first",
    tags: ["decide verdict parsing tolerates model noise"] },
  { id: 60, behavior: "dm-proactive budget is per-agent namespaced with per-agent eviction (Plan 005 parity for budget)",
    tags: ["per-agent eviction: agent-a overflow", "budget is namespaced per agent"] },
  { id: 61, behavior: "person store: memory profiles are per-human (agent-namespaced, cross-session merged) when socialMemory.personStore is enabled",
    tags: ["one per-agent profile grows across two sessions of the same agent", "kevin in agent1 is separate from kevin in agent2", "personstore:false keeps per-session files"] },
  { id: 62, behavior: "legacy per-session profiles migrate into the person store idempotently",
    tags: ["migrates 3 legacy session files into one per-agent profile idempotently"] },
  { id: 63, behavior: "schemaV2 extract captures relationship/open_threads/emotional_state with design caps + merge-level self-exclusion",
    tags: ["schemaV2:true merges relationship/open_threads/emotional_state with design caps", "schemaV2:true applies v1 caps", "schemaV2:true skips a self entry"] },
  { id: 64, behavior: "schemaV2 is default-off (v1 behavior preserved)",
    tags: ["schemaV2:false uses v1 prompt and v1 caps", "schemaV2:false with relationship/open_threads in LLM output keeps v1 shape"] },
  { id: 65, behavior: "decide prompt receives compact person memory (wrapped, bounded) before the speak/silent decision",
    tags: ["decide receives compact memoryContext for an ingested person", "decide receives null memoryContext for unknown sender", "decide memoryContext includes an explicitly mentioned third person", "renders memoryContext before the transcript between delimiters"] },
  { id: 66, behavior: "recall renders schemaV2 relationship/threads/emotional texture (fresh-gated)",
    tags: ["renders relationship/open_threads/emotional_state when schemaV2", "recall v2 drops emotional_state when older than 48h", "recallCompact applies harder caps"] },
  { id: 67, behavior: "production timing sets hourOfDay + wasAddressed (night mode and direct-address fast-path active); style stats exclude the agent's own lines",
    tags: ["plan 026: respond ctx carries hourOfDay and wasAddressed (production timing caller)", "plan 026: wasAddressed shortens the first-bubble delay via the real timing engine", "plan 026: hourOfDay night fast-path is active (hourOfDay=3 vs 14)", "plan 026: triggerInfo.wasAddressed is true for speak-path hard", "plan 026: triggerInfo.wasAddressed is false for speak-path llm (no replyTarget)", "stashes the speak path into speakPathBySession (hard)", "stashes the speak path into speakPathBySession on the burst-reuse path (llm)", "plan 026: excludes the agent's own lines from style stats"] },
  { id: 68, behavior: "mechanical tells (em-dash/markdown/lists/headers) are sanitized at flush + per-bubble with fail-open semantics; semantic tells are logged only",
    tags: ["replaces em-dashes with commas", "strips bold markdown", "converts bullet/numbered lists to plain lines", "strips headers", "detects but does NOT replace semantic tells (banned word)", "sanitizes the finalDraft before engine.respond sees it", "sanitizes a bubble with an em-dash before delivery; warn log fired", "drops an all-empty-after-sanitize scheduled set and delivers the raw draft", "drops only empty-after-sanitize bubbles; non-empty ones still deliver"] },
  { id: 69, behavior: "decide v2Contract emits audit reasons/addressed_to with token fallback (default off)",
    tags: ["parses clean JSON SPEAK with reason and addressed_to", "parses JSON wrapped in fences", "falls back to the v1 token when model answers a bare token", "garbage → null → stay_silent with empty reason", "caps reason at 60 chars", "caps addressed_to at 40 chars", "v2 SPEAK advances the epoch, STAY_SILENT does not", "v1 mode returns no reason/addressedTo fields", "parseDecideVerdictV2 maps SKIP and parseDecideVerdict handles SKIP", "v2 decide prompt carries the STRICT JSON contract line", "v2 proactive prompt switches to STRICT JSON", "claims reason/addressed_to from the v2 decide result into the log"] },
  { id: 70, behavior: "decide persona includes the group voice card + style constraint (register-aware turn-taking); voiceCard param stays null to avoid duplication",
    tags: ["decide persona carries the voice card and style constraint", "decide persona without card/peek-stats degrades to soul + anti-tell", "decide gets a lean persona"] },
  { id: 71, behavior: "prompts/labels/trigger-wordlists resolve via language packs; de is byte-identical default; non-de groups run documented reduced proactive mode",
    tags: ["de is the byte-identical default for unknown codes", "formatAge renders en skeleton labels", "split prompt carries the en reply-language hint", "regenerate prompt switches regenstyle per pack", "dm render prompt switches style/language fields per pack", "decide prompt renders en age labels in transcript and rule", "mood labels + feel-words resolve via language pack", "language defaults to de and is agent-overlayable", "non-de language runs reduced trigger mode"] },
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

  const total = MATRIX.length;
  const staticRows = MATRIX.filter((r) => r.kind === "static").length;
  console.log(`\nParity matrix: ${covered + skipped}/${total} covered (${covered} tested, ${skipped} skipped)`);
  console.log(results.join("\n") + "\n");
  console.log(`static rows: ${staticRows} (review recommended)`);

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
