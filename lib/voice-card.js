import fs from "node:fs";
import path from "node:path";
import { setVoiceCardGetter } from "./persona.js";
import { isEnabled, isScopedAgent, resolveAgentConfigForSession } from "./config.js";
import { isChatSession } from "./gate.js";
import { parseScope } from "./scope.js";
import { MEDIA_PLACEHOLDER_SET } from "./messages.js";
import { UNTRUSTED_DIRECTIVE, wrapUntrusted } from "./local-prompts.js";
import { redactSessionKey } from "./redact.js";

const WINDOW = 100;
const MAX_ENTRIES = 256;
const LEGACY_BUCKET = "__legacy__";
const FORMAT_VERSION = 2;

function evictOldest(obj, max = MAX_ENTRIES) {
  const keys = Object.keys(obj);
  while (keys.length > max) {
    delete obj[keys.shift()];
  }
}

const CONTROL_PREFIXES = [
  "[New message]",
  "[Observed Telegram group context",
  "[Current addressed message",
  "[User sent ",
  "[The user sent ",
  "[Delivered from ",
  "[IMPORTANT:",
];

// agentId → { cache: {}, counter: {} } — per-agent namespaced state (Plan 004).
// `cache`/`counter` are no longer exported as flat objects; all access goes
// through bucketFor(agentId). Sessions without a parseable agentId land in
// the __legacy__ bucket so nothing is silently dropped.
export const stateByAgent = new Map();
export const refreshing = new Set();

// Flat, but collision-safe keyed `agentId + "|" + sessionKey`.
const lastRefreshTime = {};

let logRef = null;
let stateDir = null;
let migrateOnce = false;
let warnedGlobalOnce = false;
let warnedNoAgentOnce = false;

function bucketFor(agentId) {
  const id = agentId || LEGACY_BUCKET;
  let b = stateByAgent.get(id);
  if (!b) {
    b = { cache: {}, counter: {} };
    stateByAgent.set(id, b);
  }
  return b;
}

function isControlMarker(line) {
  return CONTROL_PREFIXES.some((p) => line.startsWith(p));
}

export function parseMessages(content) {
  const out = [];
  let author = "user";
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || isControlMarker(line)) continue;
    const m = line.match(/^\[([^\]]{1,60})\]\s*(.*)$/);
    if (m && !MEDIA_PLACEHOLDER_SET.has(`[${m[1].trim()}]`)) {
      author = m[1].trim() || "user";
      const text = m[2].trim();
      if (text) out.push({ author, text });
    } else {
      if (line) out.push({ author, text: line });
    }
  }
  return out;
}

export function buildTranscript(messages, windowSize = WINDOW) {
  if (!messages || !Array.isArray(messages)) return [];
  const result = [];
  for (const msg of messages) {
    if (typeof msg === "string") {
      result.push(...parseMessages(msg));
    } else if (msg && typeof msg === "object" && msg.role === "user" && typeof msg.content === "string" && msg.content) {
      result.push(...parseMessages(msg.content));
    }
  }
  return result.slice(-(windowSize > 0 ? windowSize : WINDOW)).map((m, idx) => ({ id: String(idx), speaker: m.author, text: m.text }));
}

// perSessionCard:false collapses cards WITHIN one agent only (documented
// semantic change, Plan 004): "__global__:<agentId>" instead of the old
// global "__global__" shared across all agents/channels.
function cardKey(sessionKey, perSession, agentId) {
  return perSession ? sessionKey : ("__global__:" + (agentId || LEGACY_BUCKET));
}

function cacheFilePath() {
  return path.join(stateDir, "social-learning-cache.json");
}

// v1 (flat {cache, counter}) → v2 (per-agent buckets). Runs at most once
// under migrateOnce so a broken/mid-crash migration never loops. Keys without
// an "agent:" prefix (other than the dropped "__global__") are moved to the
// __legacy__ bucket rather than discarded — safer than throwing away learned
// cards (we warn once either way).
function migrateV1(data) {
  const out = new Map();
  const put = (agentId, key, val, isCounter) => {
    const id = agentId || LEGACY_BUCKET;
    const b = out.get(id) || { cache: {}, counter: {} };
    if (isCounter) b.counter[key] = val;
    else b.cache[key] = val;
    out.set(id, b);
  };
  const move = (src, isCounter) => {
    if (!src || typeof src !== "object") return;
    for (const key of Object.keys(src)) {
      if (key === "__global__") {
        if (!warnedGlobalOnce) {
          warnedGlobalOnce = true;
          logRef?.warn?.(`human-engine: voice-card v1 __global__ card dropped on migration (cross-tenant contaminated; will relearn)`);
        }
        continue;
      }
      const scope = parseScope(key);
      if (scope) {
        put(scope.agentId, key, src[key], isCounter);
      } else {
        if (!warnedNoAgentOnce) {
          warnedNoAgentOnce = true;
          logRef?.warn?.(`human-engine: voice-card v1 key without agent: prefix moved to ${LEGACY_BUCKET}: ${String(key).slice(0, 40)}`);
        }
        put(LEGACY_BUCKET, key, src[key], isCounter);
      }
    }
  };
  move(data.cache, false);
  move(data.counter, true);
  for (const [agentId, b] of out) {
    bucketFor(agentId).cache = b.cache;
    bucketFor(agentId).counter = b.counter;
  }
}

export function loadCache() {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFilePath(), "utf8"));
    if (data && data.version === FORMAT_VERSION && data.agents) {
      for (const [agentId, b] of Object.entries(data.agents)) {
        const bucket = bucketFor(agentId);
        bucket.cache = b.cache || {};
        bucket.counter = b.counter || {};
      }
      return;
    }
    if (data && (data.cache || data.counter)) {
      if (migrateOnce) return;
      migrateOnce = true;
      migrateV1(data);
      saveCache();
    }
  } catch {}
}

export function saveCache() {
  try {
    const filePath = cacheFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = filePath + ".tmp";
    const agents = {};
    for (const [agentId, b] of stateByAgent) {
      agents[agentId] = { cache: b.cache, counter: b.counter };
    }
    fs.writeFileSync(tmp, JSON.stringify({ version: FORMAT_VERSION, agents }), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch {}
}

export function getCard(sessionKey, perSession = false, agentId) {
  return bucketFor(agentId).cache[cardKey(sessionKey, perSession, agentId)] || null;
}

export function createVoiceCard({ cfg, engine, stateDir: sd, log }) {
  logRef = log;
  stateDir = sd;
  loadCache();

  setVoiceCardGetter((sk, agentId) => getCard(sk, cfg.socialLearning?.perSessionCard !== false, agentId));

  function onBeforePromptBuild(event, ctx) {
    try {
      if (!isEnabled(cfg)) return;
      if (cfg.socialLearning?.enabled === false) return;
      if (!isScopedAgent(cfg, ctx?.agentId)) return;
      if (!event || !event.messages || !Array.isArray(event.messages)) return;
      const sk = ctx?.sessionKey;
      if (!sk) return;
      if (!isChatSession(sk)) return;

      const agentId = parseScope(sk)?.agentId || ctx?.agentId || LEGACY_BUCKET;
      const agentCfg = resolveAgentConfigForSession(cfg, sk, ctx?.agentId);
      const perSession = agentCfg.socialLearning?.perSessionCard !== false;
      const bucket = bucketFor(agentId);
      const key = cardKey(sk, perSession, agentId);

      bucket.counter[sk] = (bucket.counter[sk] || 0) + 1;
      const n = bucket.counter[sk];
      const hasCard = key in bucket.cache;
      evictOldest(bucket.counter);
      evictOldest(lastRefreshTime);

      const refreshEvery = agentCfg.socialLearning?.refreshEvery ?? 5;
      const refreshMinutes = agentCfg.socialLearning?.refreshMinutes || 0;
      let shouldRefresh = false;

      if (hasCard && refreshMinutes > 0) {
        const lk = agentId + "|" + sk;
        const lastRefresh = lastRefreshTime[lk] || 0;
        if (Date.now() - lastRefresh >= refreshMinutes * 60 * 1000) {
          shouldRefresh = true;
        }
      }

      if (!hasCard || (refreshEvery > 0 && n % refreshEvery === 0 && refreshMinutes === 0) || shouldRefresh) {
        setTimeout(() => spawnRefresh(sk, agentId, event.messages, agentCfg, engine), 0);
      }

      const card = bucket.cache[key];
      if (card) {
        return { appendSystemContext: UNTRUSTED_DIRECTIVE + "\n" + wrapUntrusted(card) };
      }
    } catch {}
  }

  return { onBeforePromptBuild };
}

async function spawnRefresh(sessionKey, agentId, messages, cfgCtx, engine) {
  const rk = agentId + "|" + sessionKey;
  if (refreshing.has(rk)) return;
  refreshing.add(rk);
  try {
    const windowSize = cfgCtx.socialLearning?.window ?? WINDOW;
    const transcript = buildTranscript(messages, windowSize);
    if (transcript.length === 0) return;

    if (cfgCtx.socialLearning?.logRequests) {
      try {
        const logDir = path.join(path.dirname(stateDir), "logs");
        fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
        const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
        const record = JSON.stringify({
          ts,
          session_id: redactSessionKey(sessionKey),
          message_count: transcript.length,
          body: { transcript: { messages: transcript } },
        });
        fs.appendFileSync(path.join(logDir, "social-learning-requests.jsonl"), record + "\n", { mode: 0o600 });
      } catch {}
    }

    const result = await engine.extractVoiceCard({ transcript, agentId: agentId || undefined });
    const promptBlock = result?.prompt_block;
    if (typeof promptBlock === "string" && promptBlock) {
      const perSession = cfgCtx.socialLearning?.perSessionCard !== false;
      const bucket = bucketFor(agentId);
      bucket.cache[cardKey(sessionKey, perSession, agentId)] = promptBlock;
      lastRefreshTime[agentId + "|" + sessionKey] = Date.now();
      evictOldest(bucket.cache);
      evictOldest(lastRefreshTime);
      saveCache();
    }
  } catch {
  } finally {
    refreshing.delete(rk);
  }
}
