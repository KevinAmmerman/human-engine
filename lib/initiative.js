import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInitiativeStore } from "./initiative-store.js";
import { buildTaskExtractPrompt, buildInitiativeDecidePrompt, buildInitiativeRenderPrompt, wrapUntrusted } from "./local-prompts.js";
import { isGroupSessionKey, isDmSessionKey, agentIdFromSessionKey, parseAgentScope } from "./scope.js";
import { isScopedAgent, resolveAgentConfigForSession } from "./config.js";
import { isQuietHour, localDayKey } from "./proactive.js";
import { sanitizeTells, expandInlineLists } from "./anti-tell.js";

// Initiative — Phase 1 + Phase 2.
//
// Phase 0 wired the durable per-agent x scope store and the hook surface.
// Phase 1 added capture (keyword/cadence-triggered task & directive extraction
// via an LLM) and recall (open tasks + standing directives injected into the
// agent's context). Phase 2 adds the per-scope tick: a deterministic gate
// (evaluateInitiative), an LLM decide step, a render step, and a shadow log.
// Everything is gated behind cfg.initiative.enabled === true (default false) —
// with the feature off it creates no files, injects no context, and changes no
// behavior. In shadow mode (the only reachable path in tests) candidates are
// logged but never sent.
const BUFFER_CAP = 200;
const MAX_TASK_CHARS = 160;
const KNOWN_SCOPES_CAP = 256;
const SENT_IDS_CAP = 512;
const ACTS_CAP = 64;

const KEYWORD_RE = /\b(merk dir|merken|denk dran|denke daran|vergiss nicht|nicht vergessen|erinner|kümmere dich|kümmer dich|plane|planen|organisier|organisiere|schau nach|frag nach|finde heraus|besorg|remember|remind me|don'?t forget|organi[sz]e|follow up|look into|sort out|note that)\b/i;

function timeParts(ts, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(ts))) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  return `${p.hour}:${p.minute}`;
}

function isActiveHour(now, activeHours) {
  const start = activeHours?.start;
  const end = activeHours?.end;
  if (typeof start !== "string" || typeof end !== "string" || !start || !end) return true;
  if (start === end) return false;
  const hhmm = timeParts(now, activeHours?.timezone);
  if (start < end) return hhmm >= start && hhmm < end;
  return hhmm >= start || hhmm < end;
}

// Plan 613 Phase 2: pure deterministic gate. Evaluates cheapest-first,
// collecting ALL hit reasons; `pass` is true only when no reason hit.
export function evaluateInitiative(candidate, ctx) {
  const reasons = [];
  const ini = ctx?.ini || {};
  const now = ctx?.now ?? Date.now();

  if (ctx?.enabled !== true) reasons.push("enabled");
  if (ctx?.scopeAllowed !== true) reasons.push("scope");
  if (!isActiveHour(now, ini.activeHours)) reasons.push("active-hours");
  if (isQuietHour(now, ini.quietStart, ini.quietEnd)) reasons.push("quiet-hours");
  if (ctx?.actsToday != null && ctx.actsToday >= (ini.maxActsPerDay ?? 2)) reasons.push("budget");
  if (ctx?.lastActAt && now - ctx.lastActAt < (ini.minGapMinutes ?? 240) * 60000) reasons.push("min-gap");
  if (ctx?.crossLastOutboundAt && now - ctx.crossLastOutboundAt < (ini.minGapMinutes ?? 240) * 60000) reasons.push("cross-budget");
  if (ctx?.lastHumanAt && now - ctx.lastHumanAt <= (ini.hotWindowMinutes ?? 15) * 60000) reasons.push("hot-room");
  if (ctx?.agentLastSpeakTs && now - ctx.agentLastSpeakTs < (ini.minGapAfterAgentSpeakMinutes ?? 30) * 60000) reasons.push("after-speak");
  if (ctx?.cooldownUntil && ctx.cooldownUntil > now) reasons.push("cooldown");
  if (candidate?.status && candidate.status !== "open") reasons.push("task-closed");

  let budgetMultiplier = 1;
  const ignoreStreak = ctx?.ignoreStreak ?? 0;
  if (ignoreStreak >= 4) reasons.push("paused");
  else if (ignoreStreak >= 2) budgetMultiplier = 0.5;

  if (reasons.length === 0) {
    const prob = ini.probability ?? 0.8;
    const rng = typeof ctx?.rng === "function" ? ctx.rng() : Math.random();
    if (!(rng < prob * budgetMultiplier)) reasons.push("probability");
  }

  return { pass: reasons.length === 0, reasons, budgetMultiplier };
}

export function createInitiative({ cfg, stateDir, log, llm, runtime, state, threads, now, rng, outbox }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const _now = typeof now === "function" ? now : () => Date.now();
  const _rng = typeof rng === "function" ? rng : () => Math.random();
  const store = createInitiativeStore({ stateDir, log });
  const enabled = cfg?.initiative?.enabled === true;

  const bufferByScope = new Map();
  const inflightExtract = new Set();
  const lastExtractTs = new Map();
  const knownScopes = new Set();
  const lastTickAt = new Map();
  const sentIds = new Map();
  let seeded = false;

  function getBuffer(scope) {
    if (!bufferByScope.has(scope)) {
      bufferByScope.set(scope, { entries: [], newSinceExtract: 0 });
    }
    return bufferByScope.get(scope);
  }

  function resolveAgentCfg(sk, agentId) {
    return resolveAgentConfigForSession(cfg, sk, agentId);
  }

  function scopeAllowed(sk) {
    const scopes = cfg?.initiative?.scopes;
    if (!Array.isArray(scopes) || scopes.length === 0) return true;
    for (const s of scopes) {
      if (s === "group" && isGroupSessionKey(sk)) return true;
      if (s === "dm" && isDmSessionKey(sk)) return true;
    }
    return false;
  }

  function normalize(text) {
    return String(text || "").trim().replace(/\s+/g, " ");
  }

  function taskId(normalizedText, createdAt) {
    return "t-" + createHash("sha1").update(normalizedText + "|" + createdAt).digest("hex").slice(0, 16);
  }

  function capTasks(state, maxOpen) {
    if (state.tasks.length <= maxOpen) return;
    // Storage-cap pressure: drop done/expired oldest-first first, so open tasks
    // survive. Only if still over the cap do we remove oldest open tasks. This
    // is a storage bound (not the extract contract, which never hard-deletes).
    const doneOrExpired = state.tasks
      .filter((t) => t.status === "done" || t.status === "expired")
      .sort((a, b) => (a.doneAt || a.createdAt || 0) - (b.doneAt || b.createdAt || 0));
    for (const t of doneOrExpired) {
      if (state.tasks.length <= maxOpen) break;
      state.tasks = state.tasks.filter((x) => x !== t);
    }
    if (state.tasks.length <= maxOpen) return;
    const openOldest = state.tasks
      .filter((t) => t.status === "open")
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    for (const t of openOldest) {
      if (state.tasks.length <= maxOpen) break;
      state.tasks = state.tasks.filter((x) => x !== t);
    }
  }

  function mergeExtract(state, parsed, scope, lastSpeaker, lastMessageTs, now) {
    const parsedScope = parseAgentScope(scope);
    const agentCfg = resolveAgentCfg(parsedScope?.sessionKey, state.agentId);
    const ini = agentCfg?.initiative || cfg?.initiative || {};
    const maxOpen = ini.maxOpenTasks ?? 20;
    const maxDirectives = ini.directives?.maxPerScope ?? 10;

    const existingOpen = new Set(
      state.tasks.filter((t) => t.status === "open").map((t) => t.text.toLowerCase()),
    );

    const createdAt = now ?? _now();
    const added = [];

    for (const raw of Array.isArray(parsed.tasks) ? parsed.tasks : []) {
      const text = normalize(raw?.text);
      if (!text) continue;
      const truncated = text.length > MAX_TASK_CHARS ? text.slice(0, MAX_TASK_CHARS) : text;
      const key = truncated.toLowerCase();
      if (existingOpen.has(key)) continue;
      const kind = ["task", "reminder", "commitment", "question"].includes(raw?.kind) ? raw.kind : "task";
      const people = Array.isArray(raw?.people) ? raw.people.map((p) => String(p).trim()).filter(Boolean).slice(0, 8) : [];
      const task = {
        id: taskId(key, createdAt),
        kind,
        text: truncated,
        people,
        createdAt,
        dueAt: typeof raw?.dueAt === "string" && raw.dueAt ? raw.dueAt : null,
        status: "open",
        source: { speaker: lastSpeaker || "", excerpt: "", messageTs: lastMessageTs || 0 },
        attempts: 0,
        lastActAt: 0,
        lastActKind: null,
        ignoreStreak: 0,
        doneAt: 0,
      };
      state.tasks.push(task);
      existingOpen.add(key);
      added.push(task);
    }

    for (const raw of Array.isArray(parsed.directives) ? parsed.directives : []) {
      const text = normalize(raw?.text);
      if (!text) continue;
      if (state.directives.some((d) => d.text.toLowerCase() === text.toLowerCase())) continue;
      state.directives.push({ id: "d-" + createHash("sha1").update(text).digest("hex").slice(0, 12), text, createdAt });
    }
    if (state.directives.length > maxDirectives) {
      state.directives.splice(0, state.directives.length - maxDirectives);
    }

    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    for (const id of Array.isArray(parsed.done) ? parsed.done : []) {
      const t = byId.get(String(id));
      if (t && t.status !== "done") { t.status = "done"; t.doneAt = createdAt; }
    }
    for (const id of Array.isArray(parsed.drop) ? parsed.drop : []) {
      const t = byId.get(String(id));
      if (t && t.status !== "expired") { t.status = "expired"; t.doneAt = createdAt; }
    }

    capTasks(state, maxOpen);
    return added;
  }

  function tolerantParse(raw) {
    const s = String(raw || "");
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  }

  async function extract(scope) {
    try {
      const buf = getBuffer(scope);
      const newMessages = buf.entries.map((e) => ({ speaker: e.speaker, text: e.text }));
      const parsedScope = parseAgentScope(scope);
      const agentId = parsedScope?.agentId || "";
      const state = store.getOrInit(scope, agentId);
      const lastSpeaker = newMessages[newMessages.length - 1]?.speaker || "";
      const lastMessageTs = newMessages[newMessages.length - 1]?.ts || _now();
      state.lastHumanAt = lastMessageTs;

      if (!llm || !llm.complete) {
        buf.newSinceExtract = 0;
        lastExtractTs.set(scope, _now());
        store.save(scope, state);
        return;
      }

      const agentCfg = resolveAgentCfg(parsedScope?.sessionKey, agentId);
      const prompt = buildTaskExtractPrompt({
        existing: JSON.stringify({ tasks: state.tasks.map((t) => ({ id: t.id, text: t.text, status: t.status })), directives: state.directives }),
        newMessages,
        agentName: agentCfg?.agentName || cfg?.agentName || "the assistant",
      });

      const result = await llm.complete({
        messages: [
          { role: "system", content: prompt.systemPrompt },
          { role: "user", content: prompt.userMessage },
        ],
        temperature: 0.2,
        maxTokens: 800,
        purpose: "human-engine-initiative-extract",
        agentId: agentId || undefined,
        allowAgentIdOverride: true,
        signal: AbortSignal.timeout(30000),
      });

      const parsed = tolerantParse(result?.text);
      if (parsed && typeof parsed === "object") {
        mergeExtract(state, parsed, scope, lastSpeaker, lastMessageTs, _now());
      }

      buf.newSinceExtract = 0;
      lastExtractTs.set(scope, _now());
      store.save(scope, state);
    } catch (err) {
      _log.warn(`human-engine: initiative: extract error for ${scope}: ${err?.message || err}`);
    }
  }

  async function onMessageReceived(event, ctx) {
    if (!enabled) return;
    const sk = ctx?.sessionKey;
    if (!sk || !scopeAllowed(sk)) return;
    const agentId = ctx?.agentId || agentIdFromSessionKey(sk);
    if (!isScopedAgent(cfg, agentId)) return;
    const scope = (agentId || "?") + "::" + sk;
    if (knownScopes.size >= KNOWN_SCOPES_CAP) knownScopes.delete(knownScopes.values().next().value);
    knownScopes.add(scope);

    let text = "";
    if (typeof event?.text === "string") text = event.text;
    else if (typeof event?.content === "string") text = event.content;
    else if (typeof event === "string") text = event;
    text = text.trim();
    if (!text) return;

    const speaker = ctx?.senderName || event?.metadata?.senderName || "User";
    const now = _now();
    const buf = getBuffer(scope);
    buf.entries.push({ speaker, text, ts: now });
    if (buf.entries.length > BUFFER_CAP) {
      buf.entries.splice(0, buf.entries.length - BUFFER_CAP);
    }
    buf.newSinceExtract++;

    const stateObj = store.getOrInit(scope, agentId);
    stateObj.lastHumanAt = now;

    // Plan 613 Phase 3: engagement attribution (≤48 h window, one per act).
    // If the agent's most recent act is unanswered and within the window, reset
    // the task's ignore-streak, record a reply, and backfill the log outcome.
    if (stateObj.lastActAt && now - stateObj.lastActAt <= 48 * 3600e3) {
      const replies = Array.isArray(stateObj.replies) ? stateObj.replies : [];
      const alreadyAnswered = replies.some((r) => r.ts > stateObj.lastActAt);
      if (!alreadyAnswered) {
        const acts = stateObj.acts || [];
        const lastAct = acts[acts.length - 1];
        if (lastAct) {
          const task = (stateObj.tasks || []).find((t) => t.id === lastAct.taskId);
          if (task) task.ignoreStreak = 0;
          if (typeof store.backfillLogOutcome === "function") {
            store.backfillLogOutcome(lastAct.id, true);
          }
        }
        replies.push({ ts: now });
        if (replies.length > 64) replies.splice(0, replies.length - 64);
        stateObj.replies = replies;
        store.save(scope, stateObj);
      }
    }

    const ini = resolveAgentCfg(sk, agentId)?.initiative || cfg?.initiative || {};
    const capture = ini.capture || {};

    let triggered = capture?.keywords === false ? false : KEYWORD_RE.test(text);
    if (!triggered && capture?.everyMessages > 0 && buf.newSinceExtract >= capture.everyMessages) {
      triggered = true;
    }
    if (!triggered && capture?.everyMinutes > 0 && now - (lastExtractTs.get(scope) || 0) >= capture.everyMinutes * 60000) {
      triggered = true;
    }

    if (triggered && !inflightExtract.has(scope)) {
      inflightExtract.add(scope);
      extract(scope)
        .catch((err) => _log.warn(`human-engine: initiative: extract error for ${scope}: ${err?.message || err}`))
        .finally(() => inflightExtract.delete(scope));
    }
  }

  function contextFor(sk, agentId) {
    if (!enabled || !sk || !scopeAllowed(sk)) return null;
    const resolvedAgentId = agentId || agentIdFromSessionKey(sk);
    if (!isScopedAgent(cfg, resolvedAgentId)) return null;
    const scope = (resolvedAgentId || "?") + "::" + sk;
    const state = store.getOrInit(scope, resolvedAgentId);
    const ini = resolveAgentCfg(sk, resolvedAgentId)?.initiative || cfg?.initiative || {};
    const maxChars = ini.maxContextChars ?? 600;

    const openTasks = state.tasks.filter((t) => t.status === "open");
    const directives = Array.isArray(state.directives) ? state.directives : [];

    const lines = [];
    if (openTasks.length > 0) {
      lines.push("Open tasks you own in this chat (keep them in mind, do not force them):");
      const now = _now();
      for (const t of openTasks) {
        const days = Math.max(1, Math.round((now - (t.createdAt || now)) / 86400e3));
        const people = t.people && t.people.length ? ", with " + t.people.join(", ") : "";
        lines.push(`- ${t.text} (open since ${days}d${people})`);
      }
    }
    if (directives.length > 0) {
      lines.push("Standing instructions for this chat:");
      for (const d of directives) {
        lines.push(`- ${d.text}`);
      }
    }

    if (lines.length === 0) return null;
    let block = lines.join("\n");
    const wrapped = wrapUntrusted(block);
    if (wrapped.length > maxChars) {
      const markerLen = wrapped.length - block.length;
      const innerMax = Math.max(1, maxChars - markerLen);
      const slice = block.slice(0, innerMax);
      const lastNewline = slice.lastIndexOf("\n");
      block = (lastNewline > 0 ? slice.slice(0, lastNewline) : slice).trim();
    }
    return wrapUntrusted(block);
  }

  async function onBeforePromptBuild(event, ctx) {
    if (!enabled) return;
    const sk = ctx?.sessionKey;
    if (!sk) return;
    const agentId = ctx?.agentId || agentIdFromSessionKey(sk);
    const block = contextFor(sk, agentId);
    if (block) return { appendSystemContext: block };
    return undefined;
  }

  async function tick() {
    if (!enabled) return;
    try {
      if (!seeded) {
        seedScopesFromDisk();
        seeded = true;
      }
      const now = _now();
      for (const scope of [...knownScopes]) {
        try {
          await tickScope(scope, now);
        } catch (err) {
          _log.warn(`human-engine: initiative: tick scope error for ${scope}: ${err?.message || err}`);
        }
      }
    } catch (err) {
      _log.warn(`human-engine: initiative: tick error: ${err?.message || err}`);
    }
  }

  function seedScopesFromDisk() {
    try {
      const root = path.join(stateDir, "initiative");
      const agentDirs = fs.readdirSync(root, { withFileTypes: true });
      for (const agentDir of agentDirs) {
        if (!agentDir.isDirectory()) continue;
        const full = path.join(root, agentDir.name);
        const files = fs.readdirSync(full, { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile() || !f.name.endsWith(".json")) continue;
          try {
            const parsed = JSON.parse(fs.readFileSync(path.join(full, f.name), "utf8"));
            if (parsed && typeof parsed?.scope === "string" && parsed.scope) {
              knownScopes.add(parsed.scope);
            }
          } catch {}
        }
      }
      if (knownScopes.size > KNOWN_SCOPES_CAP) {
        const it = knownScopes.values();
        while (knownScopes.size > KNOWN_SCOPES_CAP) knownScopes.delete(it.next().value);
      }
    } catch {}
  }

  function scrollCandidates(stateObj, now) {
    const ini = cfg?.initiative || {};
    const everyMs = (ini.everyMinutes ?? 60) * 60000;
    const firstNudgeMs = (ini.firstNudgeMinutes ?? 120) * 60000;
    return (stateObj.tasks || [])
      .filter((t) => t.status === "open")
      .filter((t) => {
        if (t.dueAt && Date.parse(t.dueAt) <= now) return true;
        if (t.attempts === 0 && now - (t.createdAt || now) >= firstNudgeMs) return true;
        if (t.lastActAt > 0 && now - t.lastActAt >= everyMs) return true;
        return false;
      })
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  async function initiativeDecide(candidate, stateObj, agentId, sk) {
    if (!llm || !llm.complete) return { decision: "SKIP", reason: "no-llm" };
    const agentCfg = resolveAgentCfg(sk, agentId);
    const buf = getBuffer(scopeFromSk(sk, agentId));
    const transcript = (buf?.entries || []).slice(-10).map((e) => ({ speaker: e.speaker, text: e.text }));
    const prompt = buildInitiativeDecidePrompt({
      task: candidate,
      directives: stateObj.directives || [],
      transcript,
      agentName: agentCfg?.agentName || cfg?.agentName || "the assistant",
    });
    try {
      const result = await llm.complete({
        messages: [
          { role: "system", content: prompt.systemPrompt },
          { role: "user", content: prompt.userMessage },
        ],
        temperature: 0.2,
        maxTokens: 120,
        purpose: "human-engine-initiative-decide",
        agentId: agentId || undefined,
        allowAgentIdOverride: true,
        signal: AbortSignal.timeout(15000),
      });
      const parsed = tolerantParse(result?.text);
      if (parsed && ["ACT", "SKIP", "DONE"].includes(parsed.decision)) {
        return { decision: parsed.decision, reason: String(parsed.reason || "").slice(0, 40) };
      }
      return { decision: "SKIP", reason: "parse" };
    } catch (err) {
      _log.warn(`human-engine: initiative: decide error for ${scopeFromSk(sk, agentId)}: ${err?.message || err}`);
      return { decision: "SKIP", reason: "error" };
    }
  }

  async function renderInitiative(candidate, stateObj, agentId, sk) {
    if (!llm || !llm.complete) return String(candidate.text || "");
    const agentCfg = resolveAgentCfg(sk, agentId);
    const prompt = buildInitiativeRenderPrompt({
      task: candidate,
      agentName: agentCfg?.agentName || cfg?.agentName || "the assistant",
      language: agentCfg?.language || cfg?.language || "de",
    });
    try {
      const result = await llm.complete({
        messages: [
          { role: "system", content: prompt.systemPrompt },
          { role: "user", content: prompt.userMessage },
        ],
        temperature: 0.7,
        maxTokens: 200,
        purpose: "human-engine-initiative-render",
        agentId: agentId || undefined,
        allowAgentIdOverride: true,
        signal: AbortSignal.timeout(15000),
      });
      return String(result?.text || candidate.text || "").trim();
    } catch (err) {
      _log.warn(`human-engine: initiative: render error for ${scopeFromSk(sk, agentId)}: ${err?.message || err}`);
      return String(candidate.text || "");
    }
  }

  function scopeFromSk(sk, agentId) {
    return (agentId || "?") + "::" + sk;
  }

  async function tickScope(scope, now) {
    const parsedScope = parseAgentScope(scope);
    const agentId = parsedScope?.agentId || "";
    const sk = parsedScope?.sessionKey;
    if (!sk) return;

    const ini = resolveAgentCfg(sk, agentId)?.initiative || cfg?.initiative || {};
    const everyMs = (ini.everyMinutes ?? 60) * 60000;
    if (everyMs <= 0) return; // everyMinutes 0 disables the ambient tick
    if (now - (lastTickAt.get(scope) || 0) < everyMs) return;
    lastTickAt.set(scope, now);

    const stateObj = store.getOrInit(scope, agentId);
    // day rollover: reset actsToday
    const today = localDayKey(now);
    if (stateObj.day !== today) {
      stateObj.day = today;
      stateObj.actsToday = 0;
      if (Array.isArray(stateObj.acts)) stateObj.acts = [];
    }

    const candidates = scrollCandidates(stateObj, now);
    if (candidates.length === 0) return;
    const candidate = candidates[0];

    const candidateId = "init-" + candidate.id + "-" + localDayKey(now);
    if (sentIds.has(candidateId)) return;

    const cooldownUntil = (stateObj.cooldowns && stateObj.cooldowns[candidate.id]?.until) || 0;
    const agentLastSpeakTs = threads?.snapshotFor ? (threads.snapshotFor(sk, agentId)?.lastAgentSpeakTs || 0) : 0;
    const crossLastOutboundAt = typeof outbox?.lastOutbound === "function" ? (outbox.lastOutbound(scope) || 0) : 0;

    const ctx = {
      enabled: true,
      scopeAllowed: scopeAllowed(sk),
      now,
      ini,
      actsToday: stateObj.actsToday || 0,
      lastActAt: stateObj.lastActAt || 0,
      lastHumanAt: stateObj.lastHumanAt || 0,
      cooldownUntil,
      agentLastSpeakTs,
      crossLastOutboundAt,
      ignoreStreak: candidate.ignoreStreak || 0,
      rng: _rng,
    };

    const gate = evaluateInitiative(candidate, ctx);
    if (!gate.pass) {
      // Transient gate reasons (hot-room, min-gap, after-speak, quiet-hours,
      // active-hours, budget, probability) must NOT consume the candidate —
      // a later tick retries once the reason clears.
      _log.info(`human-engine: initiative SKIP ${gate.reasons[0]} scope=${scope} task=${candidate.id}`);
      return;
    }

    // Gate passed: we are about to spend the LLM decide call, so consume the
    // candidate for the day (no re-decide spam).
    if (sentIds.size >= SENT_IDS_CAP) sentIds.delete(sentIds.keys().next().value);
    sentIds.set(candidateId, true);

    const decide = await initiativeDecide(candidate, stateObj, agentId, sk);
    if (decide.decision === "DONE") {
      candidate.status = "done";
      candidate.doneAt = now;
      store.save(scope, stateObj);
      _log.info(`human-engine: initiative DONE scope=${scope} task=${candidate.id}`);
      return;
    }
    if (decide.decision !== "ACT") {
      _log.info(`human-engine: initiative DECIDE SKIP scope=${scope} task=${candidate.id}`);
      return;
    }

    let rendered = await renderInitiative(candidate, stateObj, agentId, sk);
    try {
      const cleaned = sanitizeTells(rendered);
      rendered = expandInlineLists(cleaned.text || rendered);
    } catch {}

    if (ini.shadow === true) {
      store.appendLog({
        ts: now,
        day: today,
        mode: "shadow",
        candidateId,
        taskId: candidate.id,
        kind: candidate.kind || "task",
        scope,
        agentId,
        gate: { pass: true, reasons: [] },
        decide: { decision: "ACT", reason: decide.reason || "" },
        render: { preview: rendered },
        outcome: { repliedWithin48h: null },
        sent: false,
      });
      _log.info(`human-engine: initiative SHADOW scope=${scope} task=${candidate.id}`);
      return;
    }

    // LIVE path
    if (!runtime?.subagent?.run) {
      _log.warn(`human-engine: initiative cannot send — api.runtime.subagent.run unavailable scope=${scope}`);
      return;
    }
    try {
      await runtime.subagent.run({
        sessionKey: sk,
        message: rendered,
        deliver: true,
        idempotencyKey: "human-engine-initiative-" + candidateId,
      });
      // Ignore-streak increment on a new live act: if the previous act went
      // unanswered, the task's ignore-streak climbs; an inbound reply between
      // acts resets it.
      const prevActs = stateObj.acts || [];
      const prevAct = prevActs[prevActs.length - 1];
      if (prevAct) {
        const answered = (stateObj.replies || []).some((r) => r.ts > prevAct.ts);
        if (answered) candidate.ignoreStreak = 0;
        else candidate.ignoreStreak = (candidate.ignoreStreak || 0) + 1;
      } else {
        candidate.ignoreStreak = candidate.ignoreStreak || 0;
      }
      stateObj.actsToday = (stateObj.actsToday || 0) + 1;
      stateObj.lastActAt = now;
      if (!Array.isArray(stateObj.acts)) stateObj.acts = [];
      stateObj.acts.push({ ts: now, taskId: candidate.id, id: candidateId, kind: candidate.kind || "task" });
      if (stateObj.acts.length > ACTS_CAP) {
        stateObj.acts = stateObj.acts.slice(-ACTS_CAP);
      }
      candidate.attempts = (candidate.attempts || 0) + 1;
      candidate.lastActAt = now;
      candidate.lastActKind = "act";
      store.appendLog({
        ts: now,
        day: today,
        mode: "live",
        candidateId,
        taskId: candidate.id,
        kind: candidate.kind || "task",
        scope,
        agentId,
        gate: { pass: true, reasons: [] },
        decide: { decision: "ACT", reason: decide.reason || "" },
        render: { preview: rendered },
        outcome: { repliedWithin48h: null },
        sent: true,
      });
      store.save(scope, stateObj);
      if (typeof outbox?.record === "function") outbox.record(scope, "initiative", now);
      _log.info(`human-engine: initiative SENT scope=${scope} task=${candidate.id}`);
    } catch (err) {
      _log.warn(`human-engine: initiative send failed scope=${scope} task=${candidate.id}: ${err?.message || err}`);
    }
  }

  // ---- Plan 614: operator/admin command surface (manual, never throws) ----

  function scopeFromArgs(sk, agentId) {
    if (!sk) return null;
    return scopeFromSk(sk, agentId);
  }

  function adminList(sk, agentId) {
    try {
      const scope = scopeFromArgs(sk, agentId);
      if (scope) {
        const stateObj = store.getOrInit(scope, agentId);
        return { scope, tasks: stateObj.tasks || [], directives: stateObj.directives || [] };
      }
      const states = store.listScopesForAgent(agentId);
      return { scopes: states };
    } catch {
      return sk ? { scope: scopeFromArgs(sk, agentId), tasks: [], directives: [] } : { scopes: [] };
    }
  }

  function adminAddTask(sk, agentId, text) {
    try {
      const scope = scopeFromArgs(sk, agentId);
      const clean = normalize(text).slice(0, MAX_TASK_CHARS);
      if (!scope || !clean) return { error: "missing" };
      const stateObj = store.getOrInit(scope, agentId);
      const existing = (stateObj.tasks || []).some(
        (t) => t.status === "open" && t.text.toLowerCase() === clean.toLowerCase(),
      );
      if (existing) {
        return { duplicate: true };
      }
      const now = _now();
      const id = taskId(clean.toLowerCase(), now);
      const task = {
        id,
        kind: "task",
        text: clean,
        people: [],
        createdAt: now,
        dueAt: null,
        status: "open",
        source: { speaker: "manual", excerpt: "", messageTs: now },
        attempts: 0,
        lastActAt: 0,
        lastActKind: null,
        ignoreStreak: 0,
        doneAt: 0,
      };
      stateObj.tasks = stateObj.tasks || [];
      stateObj.tasks.push(task);
      store.save(scope, stateObj);
      return { task };
    } catch {
      return { error: "error" };
    }
  }

  function resolveTaskRef(stateObj, ref) {
    const open = (stateObj.tasks || []).filter((t) => t.status === "open");
    const idx = /^\d+$/.test(ref) ? parseInt(ref, 10) : NaN;
    if (Number.isInteger(idx) && idx >= 1 && idx <= open.length) {
      return open[idx - 1];
    }
    const prefix = ref.length >= 4 ? ref.toLowerCase() : "";
    if (prefix) {
      const match = open.filter((t) => t.id.toLowerCase().startsWith("t-" + prefix) || t.id.toLowerCase().includes(prefix));
      if (match.length === 1) return match[0];
    }
    return null;
  }

  function adminSetTaskStatus(sk, agentId, ref, status) {
    try {
      const scope = scopeFromArgs(sk, agentId);
      if (!scope || !ref) return { ok: false, reason: "missing" };
      const stateObj = store.getOrInit(scope, agentId);
      const task = resolveTaskRef(stateObj, ref);
      if (!task) return { ok: false, reason: "not-found" };
      if (status !== "done" && status !== "expired") return { ok: false, reason: "bad-status" };
      task.status = status;
      task.doneAt = _now();
      store.save(scope, stateObj);
      return { ok: true, task };
    } catch {
      return { ok: false, reason: "error" };
    }
  }

  function adminAddDirective(sk, agentId, text) {
    try {
      const scope = scopeFromArgs(sk, agentId);
      const clean = normalize(text).slice(0, MAX_TASK_CHARS);
      if (!scope || !clean) return { error: "missing" };
      const stateObj = store.getOrInit(scope, agentId);
      if ((stateObj.directives || []).some((d) => d.text.toLowerCase() === clean.toLowerCase())) {
        return { duplicate: true };
      }
      const ini = resolveAgentCfg(sk, agentId)?.initiative || cfg?.initiative || {};
      const maxDirectives = ini.directives?.maxPerScope ?? 10;
      stateObj.directives = stateObj.directives || [];
      stateObj.directives.push({ id: "d-" + createHash("sha1").update(clean).digest("hex").slice(0, 12), text: clean, createdAt: _now() });
      if (stateObj.directives.length > maxDirectives) {
        stateObj.directives.splice(0, stateObj.directives.length - maxDirectives);
      }
      store.save(scope, stateObj);
      return { directive: clean };
    } catch {
      return { error: "error" };
    }
  }

  function stop() {
    store.stop();
  }

  return {
    onMessageReceived,
    onBeforePromptBuild,
    contextFor,
    tick,
    stop,
    adminList,
    adminAddTask,
    adminSetTaskStatus,
    adminAddDirective,
    __store: store,
    __stateForTests: () => ({ bufferByScope, inflightExtract, lastExtractTs }),
  };
}
