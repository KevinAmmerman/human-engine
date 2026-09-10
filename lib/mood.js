import fs from "node:fs";
import path from "node:path";
import { wrapUntrusted, languagePack } from "./local-prompts.js";
import { pathSafe, isGroupSessionKey } from "./scope.js";
import { isEnabled, isScopedAgent } from "./config.js";

export function valenceLabels(lang) {
  return languagePack(lang).moodValenceLabels;
}

export function energyLabels(lang) {
  return languagePack(lang).moodEnergyLabels;
}

export function moodStatePath(stateDir, agentId, sessionKey) {
  return path.join(stateDir, "mood", pathSafe(agentId), pathSafe(sessionKey) + ".json");
}

export function neutralState() {
  return { valence: 0, energy: 0, note: "", updatedAt: 0 };
}

export function readMood(stateDir, agentId, sessionKey) {
  try {
    const raw = fs.readFileSync(moodStatePath(stateDir, agentId, sessionKey), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.valence === "number" && typeof parsed.energy === "number") {
      return {
        valence: clampAxis(parsed.valence),
        energy: clampAxis(parsed.energy),
        note: typeof parsed.note === "string" ? parsed.note : "",
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      };
    }
  } catch {}
  return neutralState();
}

function clampAxis(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(-2, Math.min(2, Math.round(x)));
}

export function applyDecay(state, nowMs, decayHours) {
  if (!state || typeof state.updatedAt !== "number") return state;
  const hours = typeof decayHours === "number" && decayHours > 0 ? decayHours : 6;
  if (nowMs - state.updatedAt > hours * 3600e3) {
    return {
      valence: clampAxis(state.valence / 2),
      energy: clampAxis(state.energy / 2),
      note: "",
      updatedAt: state.updatedAt,
    };
  }
  return state;
}

export function clampShift(old, next, maxShiftPerUpdate) {
  const maxShift = typeof maxShiftPerUpdate === "number" && maxShiftPerUpdate >= 0 ? maxShiftPerUpdate : 1;
  const shift = (oldVal, nextVal) => {
    const diff = nextVal - oldVal;
    const clampedDiff = Math.max(-maxShift, Math.min(maxShift, diff));
    return clampAxis(oldVal + clampedDiff);
  };
  return {
    valence: shift(old.valence, next.valence),
    energy: shift(old.energy, next.energy),
    note: trimNote(next.note),
  };
}

function trimNote(note) {
  if (typeof note !== "string") return "";
  return note.trim().split(/\s+/).slice(0, 8).join(" ");
}

export function buildAppraisalPrompt(recentTurns, currentState, language) {
  const pack = languagePack(language);
  const turns = (recentTurns || [])
    .map((t) => `${t.speaker || "User"}: ${t.text || ""}`)
    .slice(-20)
    .join("\n");
  const current = currentState && typeof currentState === "object"
    ? `valence: ${currentState.valence}\nenergy: ${currentState.energy}\nnote: ${currentState.note || ""}`
    : "valence: 0\nenergy: 0\nnote:";
  // TODO(029): the output rule "max 8 Wörter, deutsch, keine Namen" is a
  // German-convention rule interwoven with the note-format contract, not a
  // plain label — left hardcoded (STOP condition in plan 029).
  return `${pack.moodIntro} ${pack.moodFeelWords} Antworte NUR:
valence: <-2..+2>
energy: <-2..+2>
note: <max 8 Wörter, deutsch, keine Namen>

${pack.moodStateHeader}
${current}

${pack.moodTurnsHeader}
${turns}`;
}

export function parseAppraisal(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const v = /valence\s*[:=]\s*([+-]?\d+)/i.exec(text);
  const e = /energy\s*[:=]\s*([+-]?\d+)/i.exec(text);
  if (!v || !e) return null;
  const valence = parseInt(v[1], 10);
  const energy = parseInt(e[1], 10);
  if (valence < -2 || valence > 2 || energy < -2 || energy > 2) return null;
  const noteMatch = /note\s*[:=]\s*(.+)/i.exec(text);
  const note = noteMatch ? trimNote(noteMatch[1]) : "";
  return { valence, energy, note };
}

export function renderInjection(state, language) {
  if (!state) return "";
  const pack = languagePack(language);
  const v = clampAxis(state.valence);
  const e = clampAxis(state.energy);
  const parts = [];
  parts.push(`Current mood state (internal, never mention, quote or explain it — let it color tone naturally): valence ${v} (${pack.moodValenceLabels[String(v)]}), energy ${e} (${pack.moodEnergyLabels[String(e)]}).`);
  if (state.note) parts.push("note: " + wrapUntrusted(state.note));
  return parts.join(" ");
}

async function writeMood(stateDir, agentId, sessionKey, state) {
  const file = moodStatePath(stateDir, agentId, sessionKey);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function createMood({ cfg, llm, stateDir, log, readTranscript }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const counters = new Map();

  function keyFor(agentId, sessionKey) {
    return (agentId || "?") + "::" + (sessionKey || "");
  }

  function onMessageReceived(event, ctx) {
    try {
      const sk = ctx?.sessionKey;
      const agentId = ctx?.agentId;
      if (!sk) return;
      if (cfg?.mood?.enabled !== true) return;
      if (!isScopedAgent(cfg, agentId)) return;
      if (isGroupSessionKey(sk)) return;
      const key = keyFor(agentId, sk);
      const n = (counters.get(key) || 0) + 1;
      counters.set(key, n);
      if (counters.size > 4096) counters.clear();

      const refreshEvery = cfg?.mood?.refreshEvery ?? 5;
      const refreshMinutes = cfg?.mood?.refreshMinutes || 0;
      let should = false;
      if (refreshEvery > 0 && refreshMinutes === 0 && n % refreshEvery === 0) {
        should = true;
      }
      if (refreshMinutes > 0) {
        const state = readMood(stateDir, agentId, sk);
        const last = state.updatedAt;
        if (Date.now() - last >= refreshMinutes * 60 * 1000) should = true;
      }
      if (should) {
        maybeUpdateMood(agentId, sk, ctx?.sessionId).catch(() => {});
      }
    } catch {}
  }

  async function maybeUpdateMood(agentId, sessionKey, sessionId) {
    try {
      const current = readMood(stateDir, agentId, sessionKey);
      const recentTurns = await readTranscript?.(sessionKey, sessionId || sessionKey, 20) || [];
      if (recentTurns.length === 0) return;

      if (!llm || !llm.complete) return;

      const prompt = buildAppraisalPrompt(recentTurns, current, cfg?.language);
      const result = await llm.complete({
        messages: [
          { role: "system", content: "You appraise a running conversation's mood. Follow the output format exactly." },
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
        maxTokens: 120,
        purpose: "human-engine-mood",
        agentId: agentId || undefined,
        signal: AbortSignal.timeout(30000),
      });

      const parsed = parseAppraisal(result?.text || "");
      if (!parsed) {
        _log.warn(`human-engine: mood appraisal unparseable for agent=${agentId}, keeping state`);
        return;
      }

      const maxShift = cfg?.mood?.maxShiftPerUpdate ?? 1;
      const shifted = clampShift(current, parsed, maxShift);
      const next = { ...shifted, updatedAt: Date.now() };
      writeMood(stateDir, agentId, sessionKey, next);
      _log.info(`human-engine: mood updated agent=${agentId} valence=${next.valence} energy=${next.energy}`);
    } catch (err) {
      _log.warn(`human-engine: mood update error agent=${agentId}: ${err?.message || err}`);
    }
  }

  function onBeforePromptBuild(event, ctx) {
    try {
      if (!isEnabled(cfg)) return;
      if (cfg?.mood?.enabled !== true) return;
      if (!isScopedAgent(cfg, ctx?.agentId)) return;
      const sk = ctx?.sessionKey;
      if (!sk) return;
      if (isGroupSessionKey(sk)) return;
      const agentId = ctx?.agentId;
      let state = readMood(stateDir, agentId, sk);
      state = applyDecay(state, Date.now(), cfg?.mood?.decayHours);
      if (state.valence === 0 && state.energy === 0 && !state.note) return;
      return { appendSystemContext: renderInjection(state, cfg?.language) };
    } catch (err) {
      _log.warn(`human-engine: mood injection error: ${err?.message || err}`);
      return;
    }
  }

  return { onMessageReceived, onBeforePromptBuild, maybeUpdateMood, counters };
}
