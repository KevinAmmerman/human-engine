import fs from "node:fs";
import path from "node:path";
import { pathSafe, parseAgentScope } from "./scope.js";
import { resolveAgentConfig } from "./config.js";
import { redactSessionKey } from "./redact.js";

const FLUSH_MS = 2000;
const CACHE_CAP = 512;

function scopeToPath(stateDir, agentId, sessionKey) {
  const base = path.join(stateDir, "social-threads", pathSafe(agentId));
  return { dir: base, file: path.join(base, pathSafe(sessionKey) + ".json") };
}

function defaultState() {
  return {
    version: 1,
    openTopics: [],
    lastAgentSpeakTs: 0,
    lastGroupActivityTs: 0,
    agentAbsentSince: 0,
  };
}

function oneSentence(s) {
  const text = String(s || "").trim();
  if (!text) return "";
  const m = text.match(/^[^.!?]*[.!?]/);
  return m ? m[0].trim() : text.slice(0, 80);
}

export function createThreads({ cfg, stateDir, socialMemory, observedStore, log }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const enabled = cfg?.threads?.enabled === true;
  const absenceThresholdHours = cfg?.threads?.absenceThresholdHours ?? 24;
  const topicExpiryDays = cfg?.threads?.topicExpiryDays ?? 14;
  const absenceThresholdMs = absenceThresholdHours * 3600e3;
  const topicExpiryMs = topicExpiryDays * 86400e3;

  const cache = new Map();
  const dirty = new Set();
  const flushTimers = new Map();

  function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
    try { fs.chmodSync(dir, 0o700); } catch {}
  }

  function loadFromFile(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") {
        return {
          version: 1,
          openTopics: Array.isArray(parsed.openTopics) ? parsed.openTopics : [],
          lastAgentSpeakTs: typeof parsed.lastAgentSpeakTs === "number" ? parsed.lastAgentSpeakTs : 0,
          lastGroupActivityTs: typeof parsed.lastGroupActivityTs === "number" ? parsed.lastGroupActivityTs : 0,
          agentAbsentSince: typeof parsed.agentAbsentSince === "number" ? parsed.agentAbsentSince : 0,
        };
      }
    } catch {}
    return null;
  }

  function writeFile(scope, stateObj) {
    const parsed = parseAgentScope(scope);
    if (!parsed) return;
    const { dir, file } = scopeToPath(stateDir, parsed.agentId, parsed.sessionKey);
    ensureDir(dir);
    const tmp = file + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(stateObj), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      _log.warn(`human-engine: threads: write error for ${redactSessionKey(scope)}: ${err?.message || err}`);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  function ownNamesFor(agentId) {
    const agentCfg = resolveAgentConfig(cfg, agentId);
    return [String(agentCfg?.agentName || ""), ...(agentCfg?.agentAliases || [])]
      .map((n) => String(n || "").toLowerCase())
      .filter(Boolean);
  }

  // Source: the agent's person profile open_threads (schemaV2). Under
  // personStore the scope resolves to the agent profile automatically.
  // Expiry uses each person's open-thread lastTs, falling back to the person's
  // lastSeenTs (schemaV2 entries carry no ts — documented choice).
  function collectOpenTopics(scope, agentId) {
    if (!socialMemory?.getOrLoadProfile) return [];
    let profile;
    try { profile = socialMemory.getOrLoadProfile(scope); } catch { return []; }
    const people = profile?.people || {};
    const ownNames = ownNamesFor(agentId);
    const now = Date.now();
    const topics = [];
    for (const p of Object.values(people)) {
      const threads = Array.isArray(p.open_threads) ? p.open_threads : [];
      const personLastTs = typeof p.lastSeenTs === "number" ? p.lastSeenTs : 0;
      for (const t of threads) {
        if (!t || typeof t !== "object") continue;
        if (t.status === "resolved") continue;
        const entryTs = typeof t.lastUpdateTs === "number"
          ? t.lastUpdateTs
          : typeof t.lastTs === "number" ? t.lastTs : personLastTs;
        if (entryTs > 0 && now - entryTs > topicExpiryMs) continue;
        const topic = String(t.topic || "").trim();
        if (!topic) continue;
        const who = String(t.whoOwesWhat || "").toLowerCase();
        let owner;
        if (who.trim().length === 0) owner = "none";
        else if (ownNames.length > 0 && ownNames.some((n) => who.includes(n))) owner = "agent";
        else owner = "member";
        topics.push({
          topic,
          summary: oneSentence(t.lastExchange),
          lastTs: entryTs,
          awaiting: owner,
          owner,
        });
        if (topics.length >= 3) break;
      }
      if (topics.length >= 3) break;
    }
    return topics;
  }

  function rebuild(scope, sk, agentId) {
    const stateObj = defaultState();
    stateObj.openTopics = collectOpenTopics(scope, agentId);
    const ownNames = ownNamesFor(agentId);
    const rows = observedStore?.readObserved ? observedStore.readObserved(sk, 200) : [];
    let lastGroup = 0;
    let lastAgent = 0;
    for (const r of rows) {
      if (typeof r?.ts !== "number") continue;
      if (r.ts > lastGroup) lastGroup = r.ts;
      if (ownNames.includes(String(r?.speaker || "").toLowerCase()) && r.ts > lastAgent) lastAgent = r.ts;
    }
    stateObj.lastGroupActivityTs = lastGroup;
    stateObj.lastAgentSpeakTs = lastAgent;
    if (lastAgent > 0) stateObj.agentAbsentSince = Date.now() - lastAgent;
    return stateObj;
  }

  function loadOrRebuild(scope, sk, agentId) {
    const parsed = parseAgentScope(scope);
    const { file } = scopeToPath(stateDir, parsed ? parsed.agentId : agentId || "?", sk);
    const loaded = loadFromFile(file);
    if (loaded) return loaded;
    const rebuilt = rebuild(scope, sk, agentId);
    cache.set(scope, rebuilt);
    markDirty(scope);
    flushScope(scope);
    return rebuilt;
  }

  function decayAbsence(stateObj) {
    if (stateObj.lastAgentSpeakTs > 0 && stateObj.lastAgentSpeakTs < stateObj.lastGroupActivityTs) {
      stateObj.agentAbsentSince = Date.now() - stateObj.lastAgentSpeakTs;
    }
  }

  function markDirty(scope) {
    dirty.add(scope);
    if (flushTimers.has(scope)) return;
    const t = setTimeout(() => {
      flushTimers.delete(scope);
      flushScope(scope);
    }, FLUSH_MS);
    if (typeof t.unref === "function") t.unref();
    flushTimers.set(scope, t);
  }

  function flushScope(scope) {
    if (!dirty.has(scope)) return;
    dirty.delete(scope);
    if (flushTimers.has(scope)) {
      clearTimeout(flushTimers.get(scope));
      flushTimers.delete(scope);
    }
    const stateObj = cache.get(scope);
    if (!stateObj) return;
    decayAbsence(stateObj);
    writeFile(scope, stateObj);
  }

  function getOrInit(scope, sk, agentId) {
    let stateObj = cache.get(scope);
    if (!stateObj) {
      stateObj = loadOrRebuild(scope, sk, agentId);
      cache.set(scope, stateObj);
      if (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value);
    }
    return stateObj;
  }

  function onActivity(sk, agentId) {
    if (!enabled || !sk) return;
    const scope = (agentId || "?") + "::" + sk;
    const stateObj = getOrInit(scope, sk, agentId);
    stateObj.lastGroupActivityTs = Date.now();
    markDirty(scope);
  }

  function onSpeak(sk, agentId) {
    if (!enabled || !sk) return;
    const scope = (agentId || "?") + "::" + sk;
    const stateObj = getOrInit(scope, sk, agentId);
    stateObj.lastAgentSpeakTs = Date.now();
    stateObj.agentAbsentSince = 0;
    markDirty(scope);
  }

  function renderLine(stateObj, gapActive) {
    const topics = stateObj.openTopics.slice(0, 3);
    const topicTexts = topics.map((t) => t.summary || t.topic).filter(Boolean);
    const parts = [];
    if (gapActive) {
      const days = Math.max(1, Math.round(stateObj.agentAbsentSince / 86400e3));
      let gapLine = `You last spoke here ${days} days ago.`;
      if (topicTexts.length > 0) gapLine += ` Open threads: ${topicTexts.join("; ")}.`;
      parts.push(gapLine);
    } else {
      parts.push(`Open threads: ${topicTexts.join("; ")}.`);
    }
    parts.push("A returning member briefly acknowledges the gap or picks up a thread — pick ONE, naturally.");
    return parts.join("\n");
  }

  function contextFor(sk, agentId) {
    if (!enabled || !sk) return null;
    const scope = (agentId || "?") + "::" + sk;
    const stateObj = getOrInit(scope, sk, agentId);
    stateObj.openTopics = collectOpenTopics(scope, agentId);
    decayAbsence(stateObj);
    const gapActive = stateObj.agentAbsentSince > absenceThresholdMs;
    const hasAwaiting = stateObj.openTopics.some((t) => t.awaiting === "agent");
    if (!gapActive && !hasAwaiting) return null;
    return renderLine(stateObj, gapActive);
  }

  // Plan 023: raw snapshot for proactive triggers (return_greeting /
  // threadCallback). Load-or-rebuild like contextFor, but returns raw state —
  // no rendering, no guards. Null when threads are disabled.
  function snapshotFor(sk, agentId) {
    if (!enabled || !sk) return null;
    const scope = (agentId || "?") + "::" + sk;
    const stateObj = getOrInit(scope, sk, agentId);
    stateObj.openTopics = collectOpenTopics(scope, agentId);
    decayAbsence(stateObj);
    return {
      agentAbsentSince: stateObj.agentAbsentSince,
      lastGroupActivityTs: stateObj.lastGroupActivityTs,
      lastAgentSpeakTs: stateObj.lastAgentSpeakTs,
      openTopics: stateObj.openTopics,
    };
  }

  function stop() {
    for (const scope of [...dirty]) flushScope(scope);
    for (const t of flushTimers.values()) clearTimeout(t);
    flushTimers.clear();
  }

  return { onActivity, onSpeak, contextFor, snapshotFor, stop, __stateForTests: () => ({ cache, dirty, flushTimers }) };
}
