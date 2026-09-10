import fs from "node:fs";
import path from "node:path";
import { pathSafe, parseAgentScope } from "./scope.js";
import { localDayKey } from "./proactive.js";
import { redactSessionKey } from "./redact.js";

const FLUSH_MS = 2000;
const CACHE_CAP = 512;
const STATE_BYTE_CAP = 64 * 1024;
const LOG_RETENTION_DAYS = 14;
const LOG_BYTE_CAP = 4 * 1024 * 1024;

function scopeToPath(stateDir, agentId, sessionKey) {
  const base = path.join(stateDir, "initiative", pathSafe(agentId));
  return { dir: base, file: path.join(base, pathSafe(sessionKey) + ".json") };
}

function defaultState() {
  return {
    version: 1,
    scope: "",
    agentId: "",
    tasks: [],
    directives: [],
    lastCaptureTs: 0,
    lastActAt: 0,
    lastHumanAt: 0,
    day: "",
    actsToday: 0,
    acts: [],
    replies: [],
    cooldowns: {},
  };
}

export function createInitiativeStore({ stateDir, log }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const cache = new Map();
  const dirty = new Set();
  const flushTimers = new Map();
  const logFile = path.join(stateDir || ".", "initiative.jsonl");

  function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
    try { fs.chmodSync(dir, 0o700); } catch {}
  }

  function parseScope(scope) {
    if (typeof scope !== "string" || !scope) return null;
    return parseAgentScope(scope);
  }

  function loadFromFile(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
    return null;
  }

  function evictToCap(stateObj) {
    let raw = JSON.stringify(stateObj);
    if (Buffer.byteLength(raw, "utf8") <= STATE_BYTE_CAP) return;
    const byDone = [...stateObj.tasks].sort((a, b) => {
      const ad = a?.status === "done" ? 1 : 0;
      const bd = b?.status === "done" ? 1 : 0;
      if (ad !== bd) return bd - ad;
      return (a?.createdAt || 0) - (b?.createdAt || 0);
    });
    for (const t of byDone) {
      if (Buffer.byteLength(raw, "utf8") <= STATE_BYTE_CAP) break;
      stateObj.tasks = stateObj.tasks.filter((x) => x !== t);
      raw = JSON.stringify(stateObj);
    }
  }

  function writeFile(scope, stateObj) {
    const parsed = parseScope(scope);
    if (!parsed) return;
    const { dir, file } = scopeToPath(stateDir, parsed.agentId, parsed.sessionKey);
    ensureDir(dir);
    evictToCap(stateObj);
    const tmp = file + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(stateObj), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      _log.warn(`human-engine: initiative: write error for ${redactSessionKey(scope)}: ${err?.message || err}`);
      try { fs.unlinkSync(tmp); } catch {}
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
    writeFile(scope, stateObj);
  }

  function getOrInit(scope, agentId) {
    let stateObj = cache.get(scope);
    if (!stateObj) {
      const parsed = parseScope(scope);
      const { file } = scopeToPath(stateDir, parsed ? parsed.agentId : agentId || "?", parsed ? parsed.sessionKey : scope);
      const loaded = loadFromFile(file);
      stateObj = loaded && typeof loaded === "object" ? loaded : defaultState();
      stateObj.scope = scope;
      stateObj.agentId = agentId || parsed?.agentId || "";
      cache.set(scope, stateObj);
      if (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value);
    }
    return stateObj;
  }

  function load(scope) {
    const parsed = parseScope(scope);
    if (!parsed) return null;
    const { file } = scopeToPath(stateDir, parsed.agentId, parsed.sessionKey);
    const loaded = loadFromFile(file);
    return loaded && typeof loaded === "object" ? loaded : null;
  }

  function save(scope, stateObj) {
    cache.set(scope, stateObj);
    markDirty(scope);
    flushScope(scope);
  }

  function readLogLines() {
    try {
      const raw = fs.readFileSync(logFile, "utf8");
      return raw.trim().split("\n").filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  function writeLogEntries(entries) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
      const tmp = logFile + ".tmp";
      fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""), { mode: 0o600 });
      fs.renameSync(tmp, logFile);
    } catch (err) {
      _log.warn(`human-engine: initiative: log rewrite error: ${err?.message || err}`);
    }
  }

  function pruneLog(entries) {
    if (!Array.isArray(entries)) return [];
    const now = Date.now();
    const today = localDayKey(now);
    const cutoffMs = now - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const cutoffDay = localDayKey(cutoffMs + 24 * 60 * 60 * 1000);
    const kept = [];
    for (const e of entries) {
      const day = typeof e?.day === "string" ? e.day : localDayKey(typeof e?.ts === "number" ? e.ts : now);
      if (day >= cutoffDay) kept.push(e);
    }
    return kept;
  }

  function pruneLogOnDisk() {
    try {
      const kept = pruneLog(readLogLines());
      if (kept.length === 0) {
        try { fs.rmSync(logFile, { force: true }); } catch {}
        return;
      }
      writeLogEntries(kept);
    } catch {}
  }

  function appendLog(entry) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
      try {
        const st = fs.statSync(logFile);
        if (st.size > LOG_BYTE_CAP) {
          fs.renameSync(logFile, logFile + ".old");
        }
      } catch {}
      pruneLogOnDisk();
      fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch (err) {
      _log.warn(`human-engine: initiative: log append error: ${err?.message || err}`);
    }
  }

  function pruneLogForTests() {
    return pruneLogOnDisk();
  }

  // Plan 613 Phase 3: backfill `outcome.repliedWithin48h` on the last matching
  // log entry for a candidateId. Atomic read-modify-write (tmp+rename) — no
  // concurrent append can interleave. First attribution wins (an already-set
  // boolean is left in place). Fail-safe: any error is swallowed.
  function backfillLogOutcome(candidateId, replied) {
    try {
      const entries = readLogLines();
      if (entries.length === 0) return;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (candidateId && e?.candidateId && e.candidateId !== candidateId) continue;
        if (e?.outcome && typeof e.outcome === "object" && typeof e.outcome.repliedWithin48h === "boolean") {
          continue; // already answered — leave the first attribution in place
        }
        if (!e?.outcome || typeof e.outcome !== "object") e.outcome = {};
        e.outcome.repliedWithin48h = replied === true;
        writeLogEntries(entries);
        return;
      }
    } catch {}
  }

  function stop() {
    for (const scope of [...dirty]) flushScope(scope);
    for (const t of flushTimers.values()) clearTimeout(t);
    flushTimers.clear();
  }

  return {
    scopeToPath,
    defaultState,
    load,
    save,
    getOrInit,
    appendLog,
    pruneLog,
    pruneLogForTests,
    backfillLogOutcome,
    stop,
    __stateForTests: () => ({ cache, dirty, flushTimers, logFile }),
  };
}
