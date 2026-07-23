import fs from "node:fs";
import path from "node:path";
import { buildMemoryExtractPrompt } from "./local-prompts.js";

const MAX_BUFFER = 200;

function pathSafe(s) {
  if (!s || typeof s !== "string") return "_";
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function scopeToPath(stateDir, agentId, sessionKey) {
  const base = path.join(stateDir, "social-memory", pathSafe(agentId));
  return { dir: base, file: path.join(base, pathSafe(sessionKey) + ".json") };
}

function defaultProfile() {
  return { people: {}, updatedAt: 0, messageCount: 0 };
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
  const last = scope.lastIndexOf("::");
  if (last < 0) return null;
  return { agentId: scope.slice(0, last), sessionKey: scope.slice(last + 2) };
}

export function createSocialMemory({ cfg, llm, stateDir, log }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const extractEvery = cfg?.socialMemory?.extractEvery ?? 25;
  const extractMinutes = cfg?.socialMemory?.extractMinutes ?? 0;
  const maxPeople = cfg?.socialMemory?.maxPeople ?? 50;
  const recallLimit = cfg?.socialMemory?.recallLimit ?? 800;

  const bufferByScope = new Map();
  const inflightExtract = new Set();
  const profileCache = new Map();
  const lastExtractTs = new Map();

  function getBuffer(scope) {
    if (!bufferByScope.has(scope)) {
      bufferByScope.set(scope, { entries: [], newSinceExtract: 0 });
    }
    return bufferByScope.get(scope);
  }

  function ensureDir(dirPath) {
    try { fs.mkdirSync(dirPath, { recursive: true }); } catch {}
  }

  function getOrLoadProfile(scope) {
    if (profileCache.has(scope)) return profileCache.get(scope);
    const parsed = parseScope(scope);
    if (!parsed) return defaultProfile();
    const { dir, file } = scopeToPath(stateDir, parsed.agentId, parsed.sessionKey);
    const profile = loadProfile(file) || defaultProfile();
    for (const name of Object.keys(profile.people)) {
      const p = profile.people[name];
      if (!Array.isArray(p.facts)) p.facts = [];
      if (!Array.isArray(p.preferences)) p.preferences = [];
      if (typeof p.situation !== "string") p.situation = "";
      if (typeof p.lastSeenTs !== "number") p.lastSeenTs = 0;
      if (typeof p.mentionCount !== "number") p.mentionCount = 0;
    }
    profileCache.set(scope, profile);
    return profile;
  }

  function writeProfile(scope, profile) {
    const parsed = parseScope(scope);
    if (!parsed) return;
    const { dir, file } = scopeToPath(stateDir, parsed.agentId, parsed.sessionKey);
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
      fs.writeFileSync(tmp, raw, "utf8");
      fs.renameSync(tmp, file);
    } catch (err) {
      _log.warn("social-memory: write error for %s: %s", scope, err?.message || err);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  function isEnabled() {
    return cfg?.socialMemory?.enabled !== false;
  }

  function ingest(scope, { speaker, text, ts }) {
    try {
      if (!scope || !speaker || !isEnabled()) return;
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
      const existingProfile = getOrLoadProfile(scope);

      const newMessages = buf.entries.slice(-extractEvery).map(e => ({
        speaker: e.speaker, text: e.text,
      }));

      if (!llm || !llm.complete) {
        buf.newSinceExtract = 0;
        lastExtractTs.set(scope, Date.now());
        writeProfile(scope, existingProfile);
        return;
      }

      const prompt = buildMemoryExtractPrompt({
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
          if (data && typeof data === "object") {
            const existing = mergedPeople[name] || { facts: [], preferences: [], situation: "", lastSeenTs: 0, mentionCount: 0 };
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

      buf.newSinceExtract = 0;
      lastExtractTs.set(scope, Date.now());
      writeProfile(scope, existingProfile);
    } catch (err) {
      _log.warn("social-memory: extract error for %s: %s", scope, err?.message || err);
    }
  }

  function recall(scope, involvedNames) {
    try {
      if (!isEnabled()) return "";
      const profile = getOrLoadProfile(scope);
      const people = profile.people;
      const names = Object.keys(people);
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

  return { ingest, extract, recall, getOrLoadProfile, bufferByScope, inflightExtract, profileCache };
}
