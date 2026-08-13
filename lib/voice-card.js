import fs from "node:fs";
import path from "node:path";
import { setVoiceCardGetter } from "./persona.js";
import { isEnabled, isScopedAgent } from "./config.js";
import { isChatSession } from "./gate.js";
import { MEDIA_PLACEHOLDER_SET } from "./messages.js";

const REFRESH_EVERY = 5;
const WINDOW = 100;
const GLOBAL_KEY = "__global__";

const CONTROL_PREFIXES = [
  "[New message]",
  "[Observed Telegram group context",
  "[Current addressed message",
  "[User sent ",
  "[The user sent ",
  "[Delivered from ",
  "[IMPORTANT:",
];

export let cache = {};
export let counter = {};
export let refreshing = new Set();

const lastRefreshTime = {};

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

export function buildTranscript(messages) {
  if (!messages || !Array.isArray(messages)) return [];
  const result = [];
  for (const msg of messages) {
    if (typeof msg === "string") {
      result.push(...parseMessages(msg));
    } else if (msg && typeof msg === "object" && msg.role === "user" && typeof msg.content === "string" && msg.content) {
      result.push(...parseMessages(msg.content));
    }
  }
  return result.slice(-WINDOW).map((m, idx) => ({ id: String(idx), speaker: m.author, text: m.text }));
}

function cardKey(sessionKey, perSession) {
  return perSession ? sessionKey : GLOBAL_KEY;
}

export let stateDir = null;
let logRef = null;

function cacheFilePath() {
  return path.join(stateDir, "social-learning-cache.json");
}

export function loadCache() {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFilePath(), "utf8"));
    if (data.cache) Object.assign(cache, data.cache);
    if (data.counter) Object.assign(counter, data.counter);
  } catch {}
}

export function saveCache() {
  try {
    const filePath = cacheFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ cache, counter }), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch {}
}

export function getCard(sessionKey, perSession = false) {
  return cache[cardKey(sessionKey, perSession)] || null;
}

export function createVoiceCard({ cfg, engine, stateDir: sd, log }) {
  logRef = log;
  stateDir = sd;
  loadCache();

  setVoiceCardGetter((sk) => getCard(sk, cfg.socialLearning?.perSessionCard !== false));

  function onBeforePromptBuild(event, ctx) {
    try {
      if (!isEnabled(cfg)) return;
      if (!isScopedAgent(cfg, ctx?.agentId)) return;
      if (!event || !event.messages || !Array.isArray(event.messages)) return;
      const sk = ctx?.sessionKey;
      if (!sk) return;
      if (!isChatSession(sk)) return;

      const perSession = cfg.socialLearning?.perSessionCard !== false;
      const key = cardKey(sk, perSession);

      counter[sk] = (counter[sk] || 0) + 1;
      const n = counter[sk];
      const hasCard = key in cache;

      const refreshMinutes = cfg.socialLearning?.refreshMinutes || 0;
      let shouldRefresh = false;

      if (hasCard && refreshMinutes > 0) {
        const lastRefresh = lastRefreshTime[sk] || 0;
        if (Date.now() - lastRefresh >= refreshMinutes * 60 * 1000) {
          shouldRefresh = true;
        }
      }

      if (!hasCard || (n % REFRESH_EVERY === 0 && refreshMinutes === 0) || shouldRefresh) {
        setTimeout(() => spawnRefresh(sk, event.messages, cfg, engine), 0);
      }

      const card = cache[key];
      if (card) {
        return { appendSystemContext: card };
      }
    } catch {}
  }

  return { onBeforePromptBuild };
}

async function spawnRefresh(sessionKey, messages, cfgCtx, engine) {
  if (refreshing.has(sessionKey)) return;
  refreshing.add(sessionKey);
  try {
    const transcript = buildTranscript(messages);
    if (transcript.length === 0) return;

    if (cfgCtx.socialLearning?.logRequests) {
      try {
        const logDir = path.join(path.dirname(stateDir), "logs");
        fs.mkdirSync(logDir, { recursive: true });
        const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
        const record = JSON.stringify({
          ts,
          session_id: sessionKey,
          message_count: transcript.length,
          body: { transcript: { messages: transcript } },
        });
        fs.appendFileSync(path.join(logDir, "social-learning-requests.jsonl"), record + "\n");
      } catch {}
    }

    const result = await engine.extractVoiceCard({ transcript });
    const promptBlock = result?.prompt_block;
    if (typeof promptBlock === "string" && promptBlock) {
      const perSession = cfgCtx.socialLearning?.perSessionCard !== false;
      cache[cardKey(sessionKey, perSession)] = promptBlock;
      lastRefreshTime[sessionKey] = Date.now();
      saveCache();
    }
  } catch {
  } finally {
    refreshing.delete(sessionKey);
  }
}
