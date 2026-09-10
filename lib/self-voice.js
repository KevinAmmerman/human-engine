import fs from "node:fs";
import path from "node:path";
import { pathSafe } from "./scope.js";
import { resolveAgentConfigForSession } from "./config.js";
import { redactSessionKey } from "./redact.js";

const FORMAT_VERSION = 1;

function stateFile(stateDir, agentId) {
  return path.join(stateDir, "self-voice", pathSafe(agentId || "?") + ".json");
}

function defaultState() {
  return { version: FORMAT_VERSION, activeCard: null, pendingCard: null, updatedAt: 0 };
}

function readState(stateDir, agentId) {
  try {
    const raw = fs.readFileSync(stateFile(stateDir, agentId), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === FORMAT_VERSION && typeof parsed === "object") {
      return {
        version: FORMAT_VERSION,
        activeCard: typeof parsed.activeCard === "string" ? parsed.activeCard : null,
        pendingCard: typeof parsed.pendingCard === "string" ? parsed.pendingCard : null,
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      };
    }
  } catch {}
  return defaultState();
}

function writeState(stateDir, agentId, stateObj) {
  const file = stateFile(stateDir, agentId);
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  try { fs.chmodSync(dir, 0o700); } catch {}
  const tmp = file + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(stateObj), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function ownNamesFor(cfg, sessionKey, agentId) {
  const agentCfg = resolveAgentConfigForSession(cfg, sessionKey, agentId);
  return [String(agentCfg?.agentName || ""), ...(agentCfg?.agentAliases || [])]
    .map((n) => String(n || "").toLowerCase())
    .filter(Boolean);
}

export function createSelfVoice({ cfg, engine, stateDir, observedStore, log }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const enabled = cfg?.selfVoice?.enabled === true;
  const refreshMinutes = cfg?.selfVoice?.refreshMinutes ?? 60;
  const minVolume = cfg?.selfVoice?.minVolume ?? 30;

  function readVolume(sessionKey) {
    const rows = observedStore?.readObserved ? observedStore.readObserved(sessionKey, 200) : [];
    return rows.length;
  }

  // Extract the agent's own lines (alias-tolerant, lowercase) from observed.
  function ownLines(cfg, sessionKey, agentId) {
    const names = ownNamesFor(cfg, sessionKey, agentId);
    if (names.length === 0) return [];
    const rows = observedStore?.readObserved ? observedStore.readObserved(sessionKey, 200) : [];
    return rows
      .filter((r) => names.includes(String(r?.speaker || "").toLowerCase()))
      .map((r) => ({ speaker: r.speaker, text: r.text, ts: r.ts }));
  }

  async function refreshFor(agentId, sessionKey) {
    if (!enabled || !agentId || !sessionKey) return false;
    try {
      const lines = ownLines(cfg, sessionKey, agentId);
      if (lines.length < minVolume) {
        _log.info(`human-engine: self-voice: below min volume (${lines.length}/${minVolume}) agent=${agentId}`);
        return false;
      }
      if (!engine?.extractSelfVoice) return false;
      const result = await engine.extractSelfVoice({ transcript: lines, agentId });
      const block = result?.prompt_block;
      if (typeof block !== "string" || !block) return false;

      const current = readState(stateDir, agentId);
      const diffNote = current.activeCard
        ? `oldLines=${current.activeCard.split("\n").length} newLines=${block.split("\n").length}`
        : "no active card yet";
      current.pendingCard = block;
      current.updatedAt = Date.now();
      writeState(stateDir, agentId, current);
      _log.info(`human-engine: self-voice: pending diff ${diffNote} agent=${agentId} sk=${redactSessionKey(sessionKey)}`);
      return true;
    } catch (err) {
      _log.warn(`human-engine: self-voice: refresh error agent=${agentId}: ${err?.message || err}`);
      return false;
    }
  }

  // Active card for persona rendering. null when disabled / none.
  function snapshotFor(agentId) {
    if (!enabled || !agentId) return null;
    const stateObj = readState(stateDir, agentId);
    return stateObj.activeCard || null;
  }

  // Owner-gated: pending → active (+ .bak of previous active).
  function accept(agentId) {
    if (!enabled || !agentId) return false;
    const stateObj = readState(stateDir, agentId);
    if (!stateObj.pendingCard) return false;
    if (stateObj.activeCard) {
      try {
        fs.writeFileSync(stateFile(stateDir, agentId) + ".bak", stateObj.activeCard, { encoding: "utf8", mode: 0o600 });
      } catch {}
    }
    stateObj.activeCard = stateObj.pendingCard;
    stateObj.pendingCard = null;
    stateObj.updatedAt = Date.now();
    writeState(stateDir, agentId, stateObj);
    _log.info(`human-engine: self-voice: accepted agent=${agentId}`);
    return true;
  }

  // Controlled death: clear active (and pending).
  function reset(agentId) {
    if (!enabled || !agentId) return false;
    const stateObj = readState(stateDir, agentId);
    stateObj.activeCard = null;
    stateObj.pendingCard = null;
    stateObj.updatedAt = Date.now();
    writeState(stateDir, agentId, stateObj);
    _log.info(`human-engine: self-voice: reset agent=${agentId}`);
    return true;
  }

  // Cadence-gated refresh trigger, off the hot path. Called once per own reply
  // persist; schedules an extract refresh at most every refreshMinutes per agent.
  // Never blocks the caller, never runs two refreshes for the same agent at once.
  const lastRefreshAt = new Map();
  const refreshing = new Set();
  const REFRESH_MAP_CAP = 256;

  function onOwnReply(agentId, sk) {
    if (!enabled || !agentId || !sk) return;
    try {
      const now = Date.now();
      const last = lastRefreshAt.get(agentId) || 0;
      if (now - last < refreshMinutes * 60 * 1000) return;
      lastRefreshAt.set(agentId, now);
      if (lastRefreshAt.size > REFRESH_MAP_CAP) {
        lastRefreshAt.delete(lastRefreshAt.keys().next().value);
      }
      if (refreshing.has(agentId)) return;
      refreshing.add(agentId);
      const timer = setTimeout(() => {
        refreshFor(agentId, sk)
          .catch(() => {})
          .finally(() => refreshing.delete(agentId));
      }, 0);
      if (typeof timer.unref === "function") timer.unref();
    } catch {}
  }

  return { refreshFor, snapshotFor, accept, reset, onOwnReply, readVolume, __enabled: enabled };
}
