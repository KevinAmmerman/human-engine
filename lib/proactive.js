import fs from "node:fs";
import path from "node:path";
import { buildProactiveDecidePrompt, wrapUntrusted } from "./local-prompts.js";

let _rng = () => Math.random();

export function setRng(fn) {
  _rng = fn;
}

export function resetRng() {
  _rng = () => Math.random();
}

const UNANSWERED_BASE_MS = 8 * 60 * 1000;
const UNANSWERED_JITTER_MS = 7 * 60 * 1000;
const STALLED_BASE_MS = 20 * 60 * 1000;
const STALLED_JITTER_MS = 20 * 60 * 1000;
const COMMITMENT_DELAY_MS = 120 * 60 * 1000;
const ENGAGEMENT_WINDOW_MS = 15 * 60 * 1000;
const COOLDOWN_CAP_MS = 48 * 60 * 60 * 1000;
const MAX_ENTRIES = 256;

const QUESTION_WORD_RE = /\b(wer|wann|wo|warum|wie|was|welch|kann|kannst|könnt|können|soll|sollen|muss|müssen|würde|würden|mag|magst|weiß|kennt|geht)\b/i;
const PROMISE_RE = /(ich schau nach|schaue ich nach|schau ich nach|ich schaue nach|ich guck|gucke ich|ich kuck|ich sage bescheid|ich sag bescheid|sag ich bescheid|ich check|ich melde mich|melde mich|ich kümmere mich|ich kläre|ich schreibe dir)/i;

const STOPWORDS = new Set([
  "und", "oder", "aber", "nicht", "doch", "auch", "dann", "denn", "noch", "nur", "mal", "schon", "mit",
  "aus", "bei", "von", "für", "das", "der", "die", "den", "dem", "des", "ein", "eine", "einen", "einem",
  "einer", "im", "am", "um", "auf", "an", "zu", "als", "so", "wie", "ist", "sind", "war", "warst", "wir",
  "ihr", "es", "er", "sie", "man", "ich", "du", "mich", "mir", "dir", "sich", "euch", "mein", "dein",
  "was", "wer", "wenn", "wann", "wo", "warum", "ja", "nein", "ok", "okay", "hi", "hey", "bitte", "danke",
  "heute", "morgen", "gerade", "jetzt", "alles", "etwas", "nichts", "jemand", "niemand",
]);

const MESSAGE_TEMPLATES = {
  unanswered_question: (c) =>
    `A group member asked a question that is still unanswered and you can answer it. The question: "${wrapUntrusted(short(c.anchor))}". Write one short, helpful reply in the group's voice.`,
  stalled_exchange: (c) =>
    `The group conversation stalled after your last message. If you have something valuable to add (a follow-up, a result, a correction), send one short message now. Otherwise do nothing.`,
  context_match: (c) =>
    `You hold a fact relevant to the current topic: "${wrapUntrusted(short(c.anchor))}". If sharing it genuinely helps the group, send one short message.`,
  follow_up_commitment: (c) =>
    `You promised the group something earlier: "${wrapUntrusted(short(c.anchor))}". Deliver the outcome or a brief status update now in one short message.`,
};

function short(s, n = 120) {
  const t = typeof s === "string" ? s : "";
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function pathSafe(s) {
  if (!s || typeof s !== "string") return "_";
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function scopeFor(agentId, sessionKey) {
  return (agentId || "?") + "::" + sessionKey;
}

function agentIdFromSessionKey(sk) {
  if (typeof sk !== "string" || !sk.startsWith("agent:")) return null;
  return sk.split(":")[1] || null;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

export function localDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function contentWords(text) {
  const words = String(text || "").toLowerCase().split(/[^a-zäöüß0-9]+/i).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

function tokenMatch(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
}

export function overlapCount(text, facts) {
  const wa = contentWords(text);
  const wb = contentWords(facts);
  let count = 0;
  for (const a of wa) {
    if (wb.some((b) => tokenMatch(a, b))) count++;
  }
  return count;
}

function isQuestion(text) {
  const t = String(text || "").trim();
  return /\?\s*$/.test(t) || QUESTION_WORD_RE.test(t);
}

function isAddressedToSomeone(text, agentName) {
  const t = String(text || "");
  if (/@\S+/.test(t)) return true;
  const name = String(agentName || "").trim().toLowerCase();
  if (name && t.toLowerCase().includes(name)) return true;
  return false;
}

export function isQuietHour(now, quietStart, quietEnd) {
  const d = new Date(now);
  const hhmm = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  if (typeof quietStart !== "string" || typeof quietEnd !== "string" || !quietStart || !quietEnd) return false;
  if (quietStart < quietEnd) return hhmm >= quietStart && hhmm < quietEnd;
  return hhmm >= quietStart || hhmm < quietEnd;
}

function describeCandidate(c) {
  const t = c?.type || "?";
  const map = {
    unanswered_question: `A question hangs unanswered: "${short(c?.anchor)}"`,
    stalled_exchange: "The conversation stalled after you last spoke",
    context_match: `The current topic matches a fact you hold: "${short(c?.anchor)}"`,
    follow_up_commitment: `You promised something earlier: "${short(c?.anchor)}"`,
  };
  return t + ": " + (map[t] || short(c?.anchor) || "?");
}

export function createProactive({ cfg, state, engine, socialMemory, observedStore, runtime, stateDir, log, now }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const _now = typeof now === "function" ? now : () => Date.now();
  const pcfg = cfg?.proactive || {};
  const agentName = cfg?.agentName || "Agent";
  const stateFile = path.join(stateDir || ".", "proactive.json");

  const pending = new Map();
  const timers = new Map();
  const velocityBySession = new Map();
  const lastInboundBySession = new Map();
  const lastAgentTurnByScope = new Map();
  const firedFollowUpsByScope = new Map();
  const counters = {};
  const cooldowns = {};
  const engagements = {};

  function capMapKey(map, max) {
    if (map.size <= max) return;
    const keys = [...map.keys()];
    for (let i = 0; i < map.size - max; i++) {
      map.delete(keys[i]);
    }
  }

  function capObject(obj, max) {
    const keys = Object.keys(obj);
    if (keys.length <= max) return;
    for (let i = 0; i < keys.length - max; i++) {
      delete obj[keys[i]];
    }
  }

  function load() {
    try {
      const raw = fs.readFileSync(stateFile, "utf8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        if (data.counters && typeof data.counters === "object") Object.assign(counters, data.counters);
        if (data.cooldowns && typeof data.cooldowns === "object") Object.assign(cooldowns, data.cooldowns);
        if (data.engagements && typeof data.engagements === "object") Object.assign(engagements, data.engagements);
      }
    } catch {}
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      const tmp = stateFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ counters, cooldowns, engagements }), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, stateFile);
    } catch (err) {
      _log.warn(`proactive: save error: ${err?.message || err}`);
    }
  }

  function sessionFromScope(scope) {
    const i = scope.lastIndexOf("::");
    return i >= 0 ? scope.slice(i + 2) : scope;
  }

  function readTranscriptPeek(sk, n) {
    if (state && typeof state.getTranscriptPeek === "function") {
      try {
        return state.getTranscriptPeek(sk, n);
      } catch {
        return [];
      }
    }
    return [];
  }

  function getCounter(scope) {
    const today = localDayKey(_now());
    const c = counters[scope];
    if (!c || c.day !== today) return { day: today, count: 0, lastSentAt: 0 };
    return c;
  }

  function bumpCounter(scope) {
    const today = localDayKey(_now());
    const c = counters[scope];
    const now = _now();
    if (c && c.day === today) {
      c.count += 1;
      c.lastSentAt = now;
    } else {
      counters[scope] = { day: today, count: 1, lastSentAt: now };
    }
    capObject(counters, MAX_ENTRIES);
  }

  function candidateKey(c) {
    return c.type + "::" + c.scopeKey;
  }

  function candidateId(c) {
    return c.type + "-" + pathSafe(c.scopeKey) + "-" + c.detectAt;
  }

  function setPending(c) {
    const key = candidateKey(c);
    cancelPending(c.type, c.scopeKey);
    pending.set(key, c);
    const delay = Math.max(0, c.matureAt - _now());
    const handle = setTimeout(() => {
      timers.delete(key);
      matureCandidate(key).catch((err) => _log.warn(`human-engine: proactive mature error: ${err?.message || err}`));
    }, delay);
    if (typeof handle.unref === "function") handle.unref();
    timers.set(key, handle);
    capMapKey(pending, MAX_ENTRIES);
    capMapKey(timers, MAX_ENTRIES);
    _log.info(`human-engine: proactive candidate type=${c.type} sk=${c.sessionKey} matureIn=${Math.round(delay / 60000)}min`);
  }

  function cancelPending(type, scopeKey) {
    const key = type + "::" + scopeKey;
    if (timers.has(key)) {
      clearTimeout(timers.get(key));
      timers.delete(key);
    }
    pending.delete(key);
  }

  async function matureCandidate(key) {
    const c = pending.get(key);
    if (!c) return;
    pending.delete(key);
    if (timers.has(key)) {
      clearTimeout(timers.get(key));
      timers.delete(key);
    }
    if (c.matureAt > _now()) return;
    await runFunnel(c);
  }

  async function tick() {
    const now = _now();
    let changed = false;
    for (const scope of Object.keys(engagements)) {
      const e = engagements[scope];
      if (now > e.until) {
        applyIgnored(scope);
        delete engagements[scope];
        changed = true;
      }
    }
    for (const key of [...pending.keys()]) {
      const c = pending.get(key);
      if (c && c.matureAt <= now) {
        pending.delete(key);
        if (timers.has(key)) {
          clearTimeout(timers.get(key));
          timers.delete(key);
        }
        await runFunnel(c);
      }
    }
    if (changed) save();
  }

  function applyIgnored(scope) {
    const base = (pcfg.cooldownBaseMinutes ?? 180) * 60000;
    const existing = cooldowns[scope];
    const maxMult = Math.max(1, Math.floor(COOLDOWN_CAP_MS / base));
    const mult = Math.min((existing?.multiplier || 1) * 2, maxMult);
    cooldowns[scope] = { until: _now() + base * mult, multiplier: mult };
    capObject(cooldowns, MAX_ENTRIES);
    _log.info(`human-engine: proactive engagement ignored scope=${scope} cooldown=${base * mult}ms`);
  }

  async function onInbound(sk, opts = {}) {
    try {
      if (!sk) return;
      if (opts.ownReply) {
        const agentId = opts.agentId || agentIdFromSessionKey(sk);
        if (agentId) {
          lastAgentTurnByScope.set(scopeFor(agentId, sk), _now());
          capMapKey(lastAgentTurnByScope, MAX_ENTRIES);
        }
        return;
      }
      if (pcfg?.enabled !== true && pcfg?.shadow !== true) return;
      const isGroup = opts.isGroup === true || (typeof sk === "string" && sk.includes(":group:"));
      if (!isGroup) return;

      const agentId = opts.agentId || agentIdFromSessionKey(sk);
      const scope = scopeFor(agentId, sk);
      const senderName = opts.senderName || "User";
      const text = String(opts.text || "").trim();
      const now = _now();

      const engaged = engagements[scope];
      if (engaged) {
        if (now <= engaged.until) {
          delete engagements[scope];
          cooldowns[scope] = { until: 0, multiplier: 1 };
          capObject(cooldowns, MAX_ENTRIES);
          save();
          _log.info(`human-engine: proactive engaged scope=${scope} (cooldown reset)`);
        } else {
          applyIgnored(scope);
          delete engagements[scope];
          save();
        }
      }

      const vel = velocityBySession.get(sk) || [];
      vel.push(now);
      velocityBySession.set(sk, vel.slice(-64));
      capMapKey(velocityBySession, MAX_ENTRIES);
      lastInboundBySession.set(sk, now);
      capMapKey(lastInboundBySession, MAX_ENTRIES);

      if (pcfg?.triggers?.contextMatch !== false && text && socialMemory?.recall) {
        const facts = socialMemory.recall(scope, [senderName, agentName]);
        if (typeof facts === "string" && facts && overlapCount(text, facts) >= 2) {
          const c = {
            type: "context_match",
            scopeKey: scope,
            sessionKey: sk,
            agentId,
            anchor: text,
            senderName,
            detectAt: now,
            matureAt: now,
            context: short(facts, 300),
          };
          await runFunnel(c);
        }
      }

      if (pcfg?.triggers?.unansweredQuestion !== false) {
        if (isQuestion(text) && !isAddressedToSomeone(text, agentName)) {
          const matureAt = now + UNANSWERED_BASE_MS + Math.round(UNANSWERED_JITTER_MS * _rng());
          setPending({
            type: "unanswered_question",
            scopeKey: scope,
            sessionKey: sk,
            agentId,
            anchor: text,
            senderName,
            detectAt: now,
            matureAt,
            context: text,
          });
        } else {
          cancelPending("unanswered_question", scope);
        }
      }

      if (pcfg?.triggers?.stalledExchange !== false) {
        const peek = readTranscriptPeek(sk, 5);
        if (peek.some((l) => l.speaker === agentName)) {
          const matureAt = now + STALLED_BASE_MS + Math.round(STALLED_JITTER_MS * _rng());
          const last = [...peek].reverse().find((l) => l.speaker === agentName);
          setPending({
            type: "stalled_exchange",
            scopeKey: scope,
            sessionKey: sk,
            agentId,
            anchor: last?.text || text,
            senderName,
            detectAt: now,
            matureAt,
            context: short(last?.text, 300) || "",
          });
        } else {
          cancelPending("stalled_exchange", scope);
        }
      }

      if (pcfg?.triggers?.followUpCommitment !== false) {
        const peek = readTranscriptPeek(sk, 10);
        const agentLines = peek.filter((l) => l.speaker === agentName);
        const last = agentLines.length > 0 ? agentLines[agentLines.length - 1] : null;
        if (last && PROMISE_RE.test(String(last.text || ""))) {
          const anchor = String(last.text || "");
          const fired = firedFollowUpsByScope.get(scope);
          const existing = pending.get("follow_up_commitment::" + scope);
          if ((!fired || !fired.has(anchor)) && !(existing && existing.anchor === anchor)) {
            setPending({
              type: "follow_up_commitment",
              scopeKey: scope,
              sessionKey: sk,
              agentId,
              anchor,
              senderName: agentName,
              detectAt: now,
              matureAt: now + COMMITMENT_DELAY_MS,
              context: "",
            });
          }
        } else {
          cancelPending("follow_up_commitment", scope);
        }
      }
    } catch (err) {
      _log.warn(`human-engine: proactive onInbound error sk=${sk}: ${err?.message || err}`);
    }
  }

  function evaluate(c) {
    const scope = c.scopeKey;
    const now = _now();
    const reasons = [];

    if (pcfg?.enabled !== true) reasons.push("disabled");

    const counter = getCounter(scope);
    const budget = pcfg?.budgetPerDay ?? 2;
    if (counter.day === localDayKey(now) && counter.count >= budget) reasons.push("budget");
    if (counter.lastSentAt && now - counter.lastSentAt < (pcfg?.minGapMinutes ?? 180) * 60000) reasons.push("min-gap");

    const cd = cooldowns[scope];
    if (cd && cd.until && cd.until > now) reasons.push("cooldown");

    const peek = readTranscriptPeek(c.sessionKey, 5);
    const newest = peek[peek.length - 1];
    if (newest && newest.speaker === agentName) reasons.push("double-text");

    if (isQuietHour(now, pcfg?.quietStart, pcfg?.quietEnd)) reasons.push("quiet-hours");

    const recent = (velocityBySession.get(c.sessionKey) || []).filter((t) => now - t <= 60000);
    if (recent.length >= 4) reasons.push("velocity");

    if (_rng() >= (pcfg?.probability ?? 0.5)) reasons.push("probability");

    return { pass: reasons.length === 0, reasons };
  }

  function shadowOrSkip(c, reason) {
    if (pcfg?.shadow === true) {
      _log.info(`human-engine: proactive SHADOW type=${c.type} sk=${c.sessionKey} reason=${reason}`);
    } else {
      _log.info(`human-engine: proactive skip type=${c.type} sk=${c.sessionKey} reason=${reason}`);
    }
  }

  async function proactiveDecide(c) {
    const transcript = readTranscriptPeek(c.sessionKey, 10);
    const prompt = buildProactiveDecidePrompt({
      transcript,
      candidate: describeCandidate(c),
      agentName,
    });
    const llm = runtime?.llm;
    if (!llm || typeof llm.complete !== "function") return false;
    try {
      const result = await llm.complete({
        messages: [
          { role: "system", content: prompt.systemPrompt },
          { role: "user", content: prompt.userMessage },
        ],
        temperature: 0.2,
        maxTokens: 8,
        purpose: "human-engine-proactive-decide",
        signal: AbortSignal.timeout(15000),
      });
      return String(result?.text || "").trim().toUpperCase() === "SPEAK";
    } catch (err) {
      _log.warn(`human-engine: proactive decide error: ${err?.message || err}`);
      return false;
    }
  }

  async function runFunnel(c) {
    const gateResult = evaluate(c);
    if (!gateResult.pass) {
      shadowOrSkip(c, "failed:" + gateResult.reasons[0]);
      return;
    }
    const decided = await proactiveDecide(c);
    if (!decided) {
      shadowOrSkip(c, "decide:skip");
      return;
    }
    await fire(c);
  }

  async function fire(c) {
    const scope = c.scopeKey;
    if (pcfg?.shadow === true) {
      _log.info(`human-engine: proactive SHADOW type=${c.type} sk=${c.sessionKey} reason=passed`);
      return;
    }
    if (!runtime?.subagent?.run) {
      _log.warn(`human-engine: proactive cannot send — api.runtime.subagent.run unavailable type=${c.type} sk=${c.sessionKey}`);
      return;
    }
    const id = candidateId(c);
    const tpl = MESSAGE_TEMPLATES[c.type];
    const message = tpl ? tpl(c) : short(c.anchor, 120);
    try {
      await runtime.subagent.run({
        sessionKey: c.sessionKey,
        message,
        deliver: true,
        idempotencyKey: "human-engine-proactive-" + id,
      });
      const now = _now();
      engagements[scope] = { until: now + ENGAGEMENT_WINDOW_MS, sentAt: now };
      bumpCounter(scope);
      capObject(engagements, MAX_ENTRIES);
      if (c.type === "follow_up_commitment") {
        if (!firedFollowUpsByScope.has(scope)) firedFollowUpsByScope.set(scope, new Set());
        firedFollowUpsByScope.get(scope).add(c.anchor);
        capMapKey(firedFollowUpsByScope, MAX_ENTRIES);
      }
      save();
      _log.info(`human-engine: proactive SENT type=${c.type} sk=${c.sessionKey} id=${id}`);
    } catch (err) {
      _log.warn(`human-engine: proactive send failed type=${c.type} sk=${c.sessionKey}: ${err?.message || err}`);
    }
  }

  function stop() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    pending.clear();
  }

  load();
  return { onInbound, tick, evaluate, fire, stop };
}
