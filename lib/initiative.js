import { createHash } from "node:crypto";
import { createInitiativeStore } from "./initiative-store.js";
import { buildTaskExtractPrompt, wrapUntrusted } from "./local-prompts.js";
import { isGroupSessionKey, isDmSessionKey, agentIdFromSessionKey, parseAgentScope } from "./scope.js";
import { isScopedAgent, resolveAgentConfigForSession } from "./config.js";

// Initiative — Phase 1: capture + recall ("she remembers").
//
// Phase 0 wired the durable per-agent x scope store and the hook surface.
// Phase 1 adds capture (keyword/cadence-triggered task & directive extraction
// via an LLM) and recall (open tasks + standing directives injected into the
// agent's context). Everything is gated behind cfg.initiative.enabled === true
// (default false) — with the feature off it creates no files, injects no
// context, and changes no behavior.
//
// Phase 2+ adds the per-scope tick that decides on due tasks, dispatch, and
// parity rows.
const BUFFER_CAP = 200;
const MAX_TASK_CHARS = 160;

const KEYWORD_RE = /\b(merk dir|merken|denk dran|denke daran|vergiss nicht|nicht vergessen|erinner|kümmere dich|kümmer dich|plane|planen|organisier|organisiere|schau nach|frag nach|finde heraus|besorg|remember|remind me|don'?t forget|organi[sz]e|follow up|look into|sort out|note that)\b/i;

export function createInitiative({ cfg, stateDir, log, llm }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const store = createInitiativeStore({ stateDir, log });
  const enabled = cfg?.initiative?.enabled === true;

  const bufferByScope = new Map();
  const inflightExtract = new Set();
  const lastExtractTs = new Map();

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
    let openCount = state.tasks.filter((t) => t.status === "open").length;
    if (openCount <= maxOpen) return;
    const excess = openCount - maxOpen;
    const evictable = state.tasks
      .filter((t) => t.status === "open")
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    for (let i = 0; i < excess && i < evictable.length; i++) {
      const t = evictable[i];
      t.status = "expired";
      t.doneAt = Date.now();
    }
  }

  function mergeExtract(state, parsed, scope, lastSpeaker, lastMessageTs) {
    const agentCfg = resolveAgentCfg(scope.split("::").slice(1).join("::"), state.agentId);
    const ini = agentCfg?.initiative || cfg?.initiative || {};
    const maxOpen = ini.maxOpenTasks ?? 20;
    const maxDirectives = ini.directives?.maxPerScope ?? 10;

    const existingOpen = new Set(
      state.tasks.filter((t) => t.status === "open").map((t) => t.text.toLowerCase()),
    );

    const now = Date.now();
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
        id: taskId(key, now),
        kind,
        text: truncated,
        people,
        createdAt: now,
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
      state.directives.push({ id: "d-" + createHash("sha1").update(text).digest("hex").slice(0, 12), text, createdAt: now });
    }
    if (state.directives.length > maxDirectives) {
      state.directives.splice(0, state.directives.length - maxDirectives);
    }

    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    for (const id of Array.isArray(parsed.done) ? parsed.done : []) {
      const t = byId.get(String(id));
      if (t && t.status !== "done") { t.status = "done"; t.doneAt = Date.now(); }
    }
    for (const id of Array.isArray(parsed.drop) ? parsed.drop : []) {
      const t = byId.get(String(id));
      if (t && t.status !== "expired") { t.status = "expired"; t.doneAt = Date.now(); }
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
      const lastMessageTs = newMessages[newMessages.length - 1]?.ts || Date.now();
      state.lastHumanAt = lastMessageTs;

      if (!llm || !llm.complete) {
        buf.newSinceExtract = 0;
        lastExtractTs.set(scope, Date.now());
        store.save(scope, state);
        return;
      }

      const agentCfg = resolveAgentCfg(scope.split("::").slice(1).join("::"), agentId);
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
        mergeExtract(state, parsed, scope, lastSpeaker, lastMessageTs);
      }

      buf.newSinceExtract = 0;
      lastExtractTs.set(scope, Date.now());
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

    let text = "";
    if (typeof event?.text === "string") text = event.text;
    else if (typeof event?.content === "string") text = event.content;
    else if (typeof event === "string") text = event;
    text = text.trim();
    if (!text) return;

    const speaker = ctx?.senderName || event?.metadata?.senderName || "User";
    const buf = getBuffer(scope);
    buf.entries.push({ speaker, text, ts: Date.now() });
    if (buf.entries.length > BUFFER_CAP) {
      buf.entries.splice(0, buf.entries.length - BUFFER_CAP);
    }
    buf.newSinceExtract++;

    const ini = resolveAgentCfg(sk, agentId)?.initiative || cfg?.initiative || {};
    const capture = ini.capture || {};
    const now = Date.now();

    let triggered = capture?.keywords === false ? false : KEYWORD_RE.test(text);
    if (!triggered && capture?.everyMessages > 0 && buf.newSinceExtract >= capture.everyMessages) {
      triggered = true;
    }
    if (!triggered && capture?.everyMinutes > 0 && now - (lastExtractTs.get(scope) || 0) >= capture.everyMinutes * 60000) {
      triggered = true;
    }

    if (triggered && !inflightExtract.has(scope)) {
      inflightExtract.add(scope);
      try {
        await extract(scope);
      } finally {
        inflightExtract.delete(scope);
      }
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
      const now = Date.now();
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
    // Phase 2+: heartbeat-like per-scope cadence that acts on due tasks.
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
    __store: store,
    __stateForTests: () => ({ bufferByScope, inflightExtract, lastExtractTs }),
  };
}
