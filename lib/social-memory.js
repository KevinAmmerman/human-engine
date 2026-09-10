import fs from "node:fs";
import path from "node:path";
import { resolveAgentConfig } from "./config.js";
import { buildMemoryExtractPrompt, buildMemoryExtractPromptV2 } from "./local-prompts.js";
import { redactSessionKey } from "./redact.js";
import { pathSafe, parseAgentScope } from "./scope.js";

const MAX_BUFFER = 200;
const FLUSH_MS = 2000;
const PROFILE_CACHE_MAX = 256;

function scopeToPath(stateDir, agentId, sessionKey) {
  const base = path.join(stateDir, "social-memory", pathSafe(agentId));
  return { dir: base, file: path.join(base, pathSafe(sessionKey) + ".json") };
}

// Plan 019: person-store file — ONE file per AGENT (not per session).
function agentProfilePath(stateDir, agentId) {
  return path.join(stateDir, "social-memory", pathSafe(agentId) + ".json");
}

function defaultProfile() {
  return { people: {}, updatedAt: 0, messageCount: 0 };
}

function unionStrings(a, b) {
  const seen = new Set();
  const out = [];
  for (const s of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (typeof s !== "string") continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function loadProfile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.people) {
      return parsed;
    }
  } catch {}
  return null;
}

function parseScope(scope) {
  return parseAgentScope(scope);
}

function isSelfName(cfg, name, agentId) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return false;
  const agentCfg = resolveAgentConfig(cfg, agentId);
  const needles = [String(agentCfg?.agentName || ""), ...(agentCfg?.agentAliases || [])]
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean);
  return needles.includes(n);
}

export function createSocialMemory({ cfg, llm, stateDir, log }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const extractEvery = cfg?.socialMemory?.extractEvery ?? 25;
  const extractMinutes = cfg?.socialMemory?.extractMinutes ?? 0;
  const maxPeople = cfg?.socialMemory?.maxPeople ?? 50;
  const recallLimit = cfg?.socialMemory?.recallLimit ?? 800;
  const personStore = cfg?.socialMemory?.personStore === true;
  const schemaV2 = cfg?.socialMemory?.schemaV2 === true;

  const bufferByScope = new Map();
  const inflightExtract = new Set();
  const profileCache = new Map();
  const lastExtractTs = new Map();
  const dirtyScopes = new Set();
  const lastIngestSigByScope = new Map(); // scope -> { speaker, text, ts } (Dedup für Hook-Refires)
  const flushTimers = new Map();

  function getBuffer(scope) {
    if (!bufferByScope.has(scope)) {
      bufferByScope.set(scope, { entries: [], newSinceExtract: 0 });
    }
    return bufferByScope.get(scope);
  }

  function ensureDir(dirPath) {
    try { fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 }); } catch {}
    try { fs.chmodSync(dirPath, 0o700); } catch {}
  }

  // ONE indirect accessor: resolves a scope (or already-resolved key) to the
  // profile-cache/dirty/flush identity. Under personStore:true that identity is
  // the AGENT (all sessions share one per-person profile); under false it stays
  // the exact per-session behavior. Every internal caller routes through this —
  // no per-callsite branches.
  function resolveKey(scopeOrKey) {
    if (!personStore) return scopeOrKey;
    return parseScope(scopeOrKey)?.agentId ?? scopeOrKey;
  }

  // Path for a resolved key: personStore → agent-level file; else → session file.
  function pathForKey(key) {
    if (personStore) {
      const dir = path.join(stateDir, "social-memory");
      return { dir, file: path.join(dir, pathSafe(key) + ".json") };
    }
    const parsed = parseScope(key);
    return scopeToPath(stateDir, parsed.agentId, parsed.sessionKey);
  }

  function normalizeProfile(profile, agentId) {
    for (const name of Object.keys(profile.people)) {
      if (isSelfName(cfg, name, agentId)) continue;
      const p = profile.people[name];
      if (!Array.isArray(p.facts)) p.facts = [];
      if (!Array.isArray(p.preferences)) p.preferences = [];
      if (typeof p.situation !== "string") p.situation = "";
      if (typeof p.lastSeenTs !== "number") p.lastSeenTs = 0;
      if (typeof p.mentionCount !== "number") p.mentionCount = 0;
      if (typeof p.relationship !== "string") p.relationship = "";
      if (!Array.isArray(p.open_threads)) p.open_threads = [];
      if (typeof p.emotional_state !== "string") p.emotional_state = "";
      if (typeof p.emotionalStateUpdatedAt !== "number") p.emotionalStateUpdatedAt = 0;
    }
    return profile;
  }

  // Merge a legacy per-session profile into a per-agent target (Plan 019
  // migration): facts/preferences = string-union (capped 20), situation =
  // longer non-empty, lastSeenTs = max, mentionCount = sum.
  function mergeProfiles(target, source) {
    for (const [name, p] of Object.entries(source?.people || {})) {
      if (!p || typeof p !== "object") continue;
      const t = target.people[name] || { facts: [], preferences: [], situation: "", lastSeenTs: 0, mentionCount: 0 };
      t.facts = unionStrings(t.facts, p.facts).slice(0, 20);
      t.preferences = unionStrings(t.preferences, p.preferences).slice(0, 20);
      const ps = typeof p.situation === "string" ? p.situation : "";
      if (ps.length > (typeof t.situation === "string" ? t.situation.length : 0)) t.situation = ps;
      t.lastSeenTs = Math.max(t.lastSeenTs || 0, typeof p.lastSeenTs === "number" ? p.lastSeenTs : 0);
      t.mentionCount = (t.mentionCount || 0) + (typeof p.mentionCount === "number" ? p.mentionCount : 0);
      target.people[name] = t;
    }
    target.messageCount = (target.messageCount || 0) + (source?.messageCount || 0);
    return target;
  }

  // Idempotent migration: on first agent access under personStore:true, read
  // all legacy per-session *.json in the agent dir (except the agent file),
  // merge them per person, write the agent file, and MOVE session files to
  // legacy-sessions/ (never deletes — PII stays 0600/0700). If the agent file
  // already exists it counts as migrated → no double migration.
  function migrateAndLoadAgentProfile(agentId) {
    const agentFile = agentProfilePath(stateDir, agentId);
    const existing = loadProfile(agentFile);
    if (existing) return existing;

    const agentDir = path.join(stateDir, "social-memory", pathSafe(agentId));
    const merged = defaultProfile();
    const sessionFiles = [];
    if (fs.existsSync(agentDir)) {
      let entries = [];
      try { entries = fs.readdirSync(agentDir); } catch {}
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        if (name === pathSafe(agentId) + ".json") continue;
        const fp = path.join(agentDir, name);
        let isFile = false;
        try { isFile = fs.statSync(fp).isFile(); } catch {}
        if (!isFile) continue;
        const prof = loadProfile(fp);
        if (prof) {
          sessionFiles.push({ name, fp, prof });
          mergeProfiles(merged, prof);
        }
      }
    }
    if (sessionFiles.length === 0) return merged;
    merged.version = 1;
    merged.migrated = true;
    writeProfileFile(agentId, merged);
    const legacyDir = path.join(agentDir, "legacy-sessions");
    ensureDir(legacyDir);
    for (const s of sessionFiles) {
      try { fs.renameSync(s.fp, path.join(legacyDir, s.name)); } catch {}
    }
    return merged;
  }

  function getOrLoadProfile(scope) {
    const parsed = parseScope(scope);
    if (!parsed) return defaultProfile();
    const key = resolveKey(scope);
    if (profileCache.has(key)) return profileCache.get(key);
    let profile;
    if (personStore) {
      profile = migrateAndLoadAgentProfile(parsed.agentId);
    } else {
      const { dir, file } = scopeToPath(stateDir, parsed.agentId, parsed.sessionKey);
      profile = loadProfile(file) || defaultProfile();
    }
    normalizeProfile(profile, parsed.agentId);
    profileCache.set(key, profile);
    capProfileCache();
    return profile;
  }

  function capProfileCache() {
    while (profileCache.size > PROFILE_CACHE_MAX) {
      profileCache.delete(profileCache.keys().next().value);
    }
  }

  function writeProfile(scope, profile) {
    const key = resolveKey(scope);
    if (key == null) return;
    dirtyScopes.add(key);
    if (flushTimers.has(key)) return;
    const t = setTimeout(() => {
      flushTimers.delete(key);
      flushScope(key);
    }, FLUSH_MS);
    if (typeof t.unref === "function") t.unref();
    flushTimers.set(key, t);
  }

  function flushScope(key) {
    key = resolveKey(key);
    if (!dirtyScopes.has(key)) return;
    dirtyScopes.delete(key);
    if (flushTimers.has(key)) {
      clearTimeout(flushTimers.get(key));
      flushTimers.delete(key);
    }
    const profile = profileCache.get(key);
    if (!profile) return;
    writeProfileFile(key, profile);
  }

  function writeProfileFile(key, profile) {
    const { dir, file } = pathForKey(key);
    ensureDir(dir);
    profile.updatedAt = Date.now();
    const tmp = file + ".tmp";
    try {
      let raw = JSON.stringify(profile);
      let buf = Buffer.byteLength(raw, "utf8");
      if (buf > 65536) {
        const keys = Object.keys(profile.people);
        const toRemove = Math.max(0, keys.length - Math.floor(maxPeople / 2));
        for (let i = 0; i < toRemove && keys.length > 0; i++) {
          delete profile.people[keys[i]];
        }
        raw = JSON.stringify(profile);
      }
      fs.writeFileSync(tmp, raw, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      _log.warn(`human-engine: social-memory: write error for ${redactSessionKey(key)}: ${err?.message || err}`);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  function isEnabled() {
    return cfg?.socialMemory?.enabled !== false;
  }

  function ingest(scope, { speaker, text, ts }) {
    try {
      if (!scope || !speaker || !isEnabled()) return;
      const parsed = parseScope(scope);
      if (isSelfName(cfg, speaker, parsed?.agentId)) return;
      if (!text || !String(text).trim()) return; // Media-only / Empty: kein Memory-Wert
      const now = ts || Date.now();
      const sig = lastIngestSigByScope.get(scope);
      // Kompromiss: dieselbe Person schickt zweimal identischen Text innerhalb
      // 60 s -> zweite echte Nachricht wird als Hook-Refire gefiltert (selten;
      // Refire desselben Texts ist der dominante Fall).
      if (sig && sig.speaker === speaker && sig.text === String(text) &&
          now - sig.ts < 60_000) {
        return; // gleiche Nachricht im Hook-Refire — nicht erneut zählen
      }
      lastIngestSigByScope.set(scope, { speaker, text: String(text), ts: now });
      if (lastIngestSigByScope.size > 1024) lastIngestSigByScope.delete(lastIngestSigByScope.keys().next().value);
      const buf = getBuffer(scope);
      buf.entries.push({ speaker, text, ts: ts || Date.now() });
      if (buf.entries.length > MAX_BUFFER) {
        buf.entries.splice(0, buf.entries.length - MAX_BUFFER);
      }
      buf.newSinceExtract++;

      const profile = getOrLoadProfile(scope);
      if (profile.people[speaker]) {
        profile.people[speaker].lastSeenTs = ts || Date.now();
        profile.people[speaker].mentionCount = (profile.people[speaker].mentionCount || 0) + 1;
      } else {
        profile.people[speaker] = {
          facts: [], preferences: [], situation: "",
          lastSeenTs: ts || Date.now(), mentionCount: 1,
        };
      }
      profile.messageCount = (profile.messageCount || 0) + 1;
      writeProfile(scope, profile);

      const byCount = extractEvery > 0 && buf.newSinceExtract >= extractEvery;
      const byTime = extractMinutes > 0 && (Date.now() - (lastExtractTs.get(scope) || 0)) >= extractMinutes * 60000;

      if ((byCount || byTime) && !inflightExtract.has(scope)) {
        inflightExtract.add(scope);
        extract(scope).finally(() => inflightExtract.delete(scope));
      }
    } catch {}
  }

  async function extract(scope) {
    try {
      const buf = getBuffer(scope);
      // Plan 019 (MED-risk, known limitation): under personStore:true, two
      // parallel extracts from different sessions of the SAME agent mutate the
      // shared per-agent profile object. The livePeople re-apply below covers
      // metadata; fact-merge is "parsed.people wins" per person. Deliberately
      // NOT locked — this is a documented design decision, not to be solved
      // with locks.
      const existingProfile = getOrLoadProfile(scope);
      const livePeople = existingProfile.people;

      const newMessages = buf.entries.slice(-extractEvery).map(e => ({
        speaker: e.speaker, text: e.text,
      }));

      if (!llm || !llm.complete) {
        buf.newSinceExtract = 0;
        lastExtractTs.set(scope, Date.now());
        writeProfile(scope, existingProfile);
        flushScope(scope);
        return;
      }

      const prompt = schemaV2
        ? buildMemoryExtractPromptV2({
            existingProfile: JSON.stringify(existingProfile),
            newMessages,
            agentName: resolveAgentConfig(cfg, parseScope(scope)?.agentId)?.agentName,
          })
        : buildMemoryExtractPrompt({
            existingProfile: JSON.stringify(existingProfile),
            newMessages,
          });

      const result = await llm.complete({
        messages: [
          { role: "system", content: prompt.systemPrompt },
          { role: "user", content: prompt.userMessage },
        ],
        temperature: 0.2,
        maxTokens: 1200,
        purpose: "human-engine-memory",
        agentId: parseScope(scope)?.agentId || undefined,
        signal: AbortSignal.timeout(30000),
      });

      const raw = result?.text || "";
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      let parsed = null;
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        try { parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)); } catch {}
      }

      if (parsed && parsed.people && typeof parsed.people === "object") {
        const mergedPeople = { ...existingProfile.people };
        for (const [name, data] of Object.entries(parsed.people)) {
          if (!data || typeof data !== "object") continue;
          if (isSelfName(cfg, name, parsed?.agentId)) continue;
          const existing = mergedPeople[name] || { facts: [], preferences: [], situation: "", lastSeenTs: 0, mentionCount: 0 };
          if (schemaV2) {
            mergedPeople[name] = {
              facts: Array.isArray(data.facts) ? data.facts.slice(0, 12) : existing.facts,
              preferences: Array.isArray(data.preferences) ? data.preferences.slice(0, 6) : existing.preferences,
              situation: typeof data.situation === "string" ? data.situation : existing.situation,
              lastSeenTs: existing.lastSeenTs,
              mentionCount: existing.mentionCount,
              relationship: typeof data.relationship === "string" ? data.relationship.slice(0, 400) : (existing.relationship || ""),
              open_threads: Array.isArray(data.open_threads)
                ? data.open_threads.filter(t => t && typeof t === "object" && typeof t.topic === "string").slice(0, 3)
                    .map(t => ({
                      topic: String(t.topic).slice(0, 120),
                      lastExchange: String(t.lastExchange || "").slice(0, 200),
                      whoOwesWhat: String(t.whoOwesWhat || "").slice(0, 120),
                    }))
                : (existing.open_threads || []),
              emotional_state: typeof data.emotional_state === "string" ? data.emotional_state.slice(0, 200) : (existing.emotional_state || ""),
              emotionalStateUpdatedAt: data.emotional_state ? Date.now() : (existing.emotionalStateUpdatedAt || 0),
            };
          } else {
            mergedPeople[name] = {
              facts: Array.isArray(data.facts) ? data.facts.slice(0, 20) : existing.facts,
              preferences: Array.isArray(data.preferences) ? data.preferences.slice(0, 20) : existing.preferences,
              situation: typeof data.situation === "string" ? data.situation : existing.situation,
              lastSeenTs: existing.lastSeenTs,
              mentionCount: existing.mentionCount,
            };
          }
        }
        const names = Object.keys(mergedPeople);
        if (names.length > maxPeople) {
          names.sort((a, b) => (mergedPeople[a].lastSeenTs || 0) - (mergedPeople[b].lastSeenTs || 0));
          for (let i = 0; i < names.length - maxPeople; i++) {
            delete mergedPeople[names[i]];
          }
        }
        existingProfile.people = mergedPeople;
      }

      // Re-apply metadata that advanced while the LLM call was in flight:
      // ingests during extract mutated the pre-merge live objects, so if the
      // merged result kept an older lastSeenTs, restore the newer value.
      for (const [name, live] of Object.entries(livePeople)) {
        const merged = existingProfile.people[name];
        if (!merged) continue;
        if ((live.lastSeenTs || 0) > (merged.lastSeenTs || 0)) {
          merged.lastSeenTs = live.lastSeenTs;
          merged.mentionCount = live.mentionCount;
        }
      }

      buf.newSinceExtract = 0;
      lastExtractTs.set(scope, Date.now());
      writeProfile(scope, existingProfile);
      flushScope(scope);
    } catch (err) {
      _log.warn(`human-engine: social-memory: extract error for ${redactSessionKey(scope)}: ${err?.message || err}`);
    }
  }

  function recall(scope, involvedNames) {
    try {
      if (!isEnabled()) return "";
      const profile = getOrLoadProfile(scope);
      const people = profile.people;
      const parsed = parseScope(scope);
      const names = Object.keys(people).filter((n) => !isSelfName(cfg, n, parsed?.agentId));
      if (names.length === 0) return "";

      const involved = (involvedNames || []).map(n => typeof n === "string" ? n.toLowerCase() : "").filter(Boolean);
      const selected = [];
      const remaining = [];

      for (const name of names) {
        const lowerName = name.toLowerCase();
        const isExact = involved.some(inv => inv === lowerName);
        const isPrefix = !isExact && involved.some(inv => lowerName.startsWith(inv) || inv.startsWith(lowerName));
        if (isExact || isPrefix) {
          selected.push(name);
        } else {
          remaining.push(name);
        }
      }

      remaining.sort((a, b) => (people[b].lastSeenTs || 0) - (people[a].lastSeenTs || 0));
      selected.push(...remaining.slice(0, 3));

      const parts = [];
      for (const name of selected) {
        const p = people[name];
        const facts = p.facts || [];
        const prefs = p.preferences || [];
        const sit = p.situation || "";
        const itemParts = [];
        if (facts.length > 0) itemParts.push(facts.slice(0, 3).join(", "));
        if (prefs.length > 0) itemParts.push("prefers " + prefs.slice(0, 2).join(", "));
        if (sit) itemParts.push(sit);
        if (itemParts.length > 0) {
          parts.push(name + ": " + itemParts.join("; "));
        }
      }

      let result = parts.join(". ");
      if (result.length > recallLimit) {
        result = result.slice(0, recallLimit);
        const lastPeriod = result.lastIndexOf(".");
        if (lastPeriod > recallLimit * 0.5) {
          result = result.slice(0, lastPeriod + 1);
        }
      }
      return result;
    } catch {
      return "";
    }
  }

  function stop() {
    for (const scope of [...dirtyScopes]) flushScope(scope);
    for (const t of flushTimers.values()) clearTimeout(t);
    flushTimers.clear();
    inflightExtract.clear();
    lastIngestSigByScope.clear();
  }

  return { ingest, extract, recall, getOrLoadProfile, bufferByScope, inflightExtract, profileCache, flush: flushScope, stop };
}
