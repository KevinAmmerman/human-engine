import { buildDecidePrompt, buildSplitPrompt, buildExtractPrompt, renderPromptBlock, buildEnhancePrompt, buildRegeneratePrompt } from "./local-prompts.js";

const epochs = new Map();
const CAP = 4096;

function capMap() {
  if (epochs.size <= CAP) return;
  const keys = [...epochs.keys()];
  for (let i = 0; i < epochs.size - CAP; i++) {
    epochs.delete(keys[i]);
  }
}

export function getState() {
  return { epochs };
}

const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;
const MENTION_RE = /@(\d{5,})/g;

export function hasHardTrigger(prompt, messages, agentName, agentContactIds, agentAliases = []) {
  const stripUrls = (s) => (s || "").replace(URL_RE, " ");
  const text = stripUrls(prompt).toLowerCase();
  const allText = [text, ...(messages || []).map((m) => stripUrls(m.text || m.content || "").toLowerCase())].join(" ");
  const names = [agentName || "OpenClaw", ...(agentAliases || [])];
  for (const rawName of names) {
    const name = String(rawName).toLowerCase();
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(allText)) return true;
  }
  if (agentContactIds && agentContactIds.size > 0) {
    for (const m of (prompt || "").matchAll(MENTION_RE)) {
      if (agentContactIds.has(m[1])) return true;
    }
  }
  return false;
}

export function createLocalEngine({ cfg, llm, timing, log }) {
  const _log = log || { info() {}, warn() {}, debug() {}, error() {} };

  function openThread(sessionKey) {
    return { id: sessionKey };
  }

  async function decide({ sessionKey, messages, systemPrompt, isDM, hasMedia, transcript, persona, voiceCard, agentName, prompt, agentContactIds, replyToAgent, agentAliases }) {
    const prev = epochs.get(sessionKey) || 0;

    if (isDM || hasMedia) {
      const epoch = prev + 1;
      epochs.set(sessionKey, epoch);
      capMap();
      return { decision: "speak", epoch, path: isDM ? "dm" : "media" };
    }

    if (replyToAgent === true) {
      const epoch = prev + 1;
      epochs.set(sessionKey, epoch);
      capMap();
      return { decision: "speak", epoch, path: "reply" };
    }

    if (hasHardTrigger(prompt, messages, agentName, agentContactIds, agentAliases)) {
      const epoch = prev + 1;
      epochs.set(sessionKey, epoch);
      capMap();
      return { decision: "speak", epoch, path: "hard" };
    }

    if (!llm || !llm.complete) {
      return null;
    }

    const decidePrompt = buildDecidePrompt({ transcript, persona, voiceCard, agentName });

    try {
      const result = await llm.complete({
        messages: [
          { role: "system", content: decidePrompt.systemPrompt },
          { role: "user", content: decidePrompt.userMessage },
        ],
        temperature: cfg?.decide?.temperature ?? 0.2,
        maxTokens: 8,
        purpose: "human-engine-decide",
        signal: AbortSignal.timeout(15000),
      });

      const text = (result?.text || "").trim().toUpperCase();
      if (text === "SPEAK") {
        const epoch = prev + 1;
        epochs.set(sessionKey, epoch);
        capMap();
        return { decision: "speak", epoch, path: "llm" };
      }
      // Only speak advances the epoch; stay_silent keeps it unchanged so an
      // ignored message mid-delivery cannot supersede live bubbles.
      return { decision: "stay_silent", epoch: prev, path: "llm" };
    } catch (err) {
      _log.warn(`local-engine: decide LLM error: ${err?.message || err}`);
      return null;
    }
  }

  async function respond({ sessionKey, draft, epoch, systemPrompt, agentName, transcript, persona, voiceCard, isGroup }) {
    const currentEp = epochs.get(sessionKey) || 0;
    if (epoch < currentEp) {
      return { superseded: true };
    }

    if (!llm || !llm.complete) {
      return { scheduled: [{ content: draft, position: 0, delayMs: 100 }], superseded: false };
    }

    const maxBubbles = cfg?.humanize?.maxBubbles ?? 5;
    const splitPrompt = buildSplitPrompt({ draft, transcript, persona, voiceCard, maxBubbles });

    try {
      const result = await llm.complete({
        messages: [
          { role: "system", content: splitPrompt.systemPrompt },
          { role: "user", content: splitPrompt.userMessage },
        ],
        temperature: cfg?.humanize?.temperature ?? 0.9,
        maxTokens: 1024,
        purpose: "human-engine-humanize",
        signal: AbortSignal.timeout(30000),
      });

      const raw = result?.text || "";
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      let parsed = null;
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        try {
          parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
        } catch {}
      }

      if (parsed && Array.isArray(parsed.messages) && parsed.messages.length > 0 && parsed.messages.length <= maxBubbles) {
        const bubbles = parsed.messages
          .slice(0, maxBubbles)
          .filter((m) => typeof m === "string" && m.length > 0 && m.length <= 400)
          .map((content, i) => ({ content, position: i }));

        if (bubbles.length > 0) {
          const timingCfg = cfg?.timing || {};
          const ctx = { isGroup: isGroup === true };
          const scheduled = timing.scheduleForBubbles(bubbles, ctx, timingCfg);
          return { scheduled, superseded: false };
        }
      }

      return { scheduled: [{ content: draft, position: 0, delayMs: 100 }], superseded: false };
    } catch (err) {
      _log.warn(`local-engine: respond LLM error: ${err?.message || err}`);
      return { scheduled: [{ content: draft, position: 0, delayMs: 100 }], superseded: false };
    }
  }

  async function extractVoiceCard({ transcript }) {
    if (!llm || !llm.complete || !transcript || transcript.length === 0) return null;

    try {
      const extractPrompt = buildExtractPrompt({ transcript });
      const result = await llm.complete({
        messages: [
          { role: "system", content: extractPrompt.systemPrompt },
          { role: "user", content: extractPrompt.userMessage },
        ],
        temperature: 0.3,
        maxTokens: 800,
        purpose: "human-engine-extract",
        signal: AbortSignal.timeout(30000),
      });

      const raw = result?.text || "";
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart < 0 || jsonEnd <= jsonStart) return null;

      const profile = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      if (!profile || !profile.summary) return null;

      const promptBlock = renderPromptBlock(profile);
      if (!promptBlock) return null;

      return { prompt_block: promptBlock, profile };
    } catch {
      return null;
    }
  }

  async function enhancePersona({ persona }) {
    if (!llm || !llm.complete || !persona) return null;

    try {
      const enhancePrompt = buildEnhancePrompt({ personaSeed: persona });
      const result = await llm.complete({
        messages: [
          { role: "system", content: enhancePrompt.systemPrompt },
        ],
        temperature: 0.7,
        maxTokens: 2000,
        purpose: "human-engine-soul",
        signal: AbortSignal.timeout(60000),
      });

      const text = result?.text?.trim();
      if (!text) return null;

      return { system_prompt: text };
    } catch {
      return null;
    }
  }

  async function regenerateReply({ sessionKey, reasoning, transcript, systemPrompt, agentName }) {
    if (!llm || !llm.complete) return null;
    const prompt = buildRegeneratePrompt({ reasoning, transcript, agentName });
    try {
      const result = await llm.complete({
        messages: [
          { role: "system", content: prompt.systemPrompt },
          { role: "user", content: prompt.userMessage },
        ],
        temperature: 0.9,
        maxTokens: 200,
        purpose: "human-engine-regen",
        signal: AbortSignal.timeout(30000),
      });
      const text = (result?.text || "").trim();
      return text ? { text } : null;
    } catch (err) {
      _log.warn(`local-engine: regen LLM error: ${err?.message || err}`);
      return null;
    }
  }

  return { openThread, decide, respond, currentEpoch: (sk) => epochs.get(sk) || 0, extractVoiceCard, enhancePersona, regenerateReply };
}
