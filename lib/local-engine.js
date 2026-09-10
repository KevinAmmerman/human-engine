import { buildDecidePrompt, buildSplitPrompt, buildExtractPrompt, renderPromptBlock, buildEnhancePrompt, buildRegeneratePrompt, buildSelfVoiceExtractPrompt, renderSelfVoiceBlock } from "./local-prompts.js";
import { capMap } from "./state.js";
import { agentIdFromSessionKey } from "./scope.js";

const epochs = new Map();
const CAP = 4096;

export function getState() {
  return { epochs };
}

const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;
const MENTION_RE = /@(\d{5,})/g;

export function parseDecideVerdict(raw) {
  const text = String(raw || "").toUpperCase();
  if (text.trim() === "SPEAK") return "SPEAK";
  if (text.trim() === "STAY_SILENT") return "STAY_SILENT";
  if (text.trim() === "SKIP") return "SKIP";
  // Fences/Prosa/JSON: erstes Vorkommen eines der Tokens
  const m = /\b(SPEAK|STAY_SILENT|SKIP)\b/.exec(text.replace(/[`*"]/g, " "));
  return m ? m[1] : null;
}

export function parseDecideVerdictV2(raw) {
  const text = String(raw || "");
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  let parsed = null;
  if (s >= 0 && e > s) { try { parsed = JSON.parse(text.slice(s, e + 1)); } catch {} }
  if (parsed && typeof parsed.decision === "string") {
    const d = parsed.decision.toUpperCase();
    if (d === "SPEAK" || d === "STAY_SILENT" || d === "SKIP") {
      return {
        decision: d === "SKIP" ? "SKIP" : d,
        reason: typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 60) : "",
        addressedTo: typeof parsed.addressed_to === "string" ? parsed.addressed_to.trim().slice(0, 40) : "",
      };
    }
  }
  // Token-Fallback (Plan 016): Modell antwortete Token statt JSON
  const tok = parseDecideVerdict(text);
  return tok ? { decision: tok, reason: "(token-fallback)", addressedTo: "" } : null;
}

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

  async function decide({ sessionKey, messages, systemPrompt, isDM, hasMedia, mediaKind, transcript, persona, voiceCard, agentName, prompt, agentContactIds, replyToAgent, agentAliases, memoryContext, threadContext, moodEnergy }) {
    const prev = epochs.get(sessionKey) || 0;

    if (isDM) {
      const epoch = prev + 1;
      epochs.set(sessionKey, epoch);
      capMap(epochs, CAP);
      return { decision: "speak", epoch, path: "dm" };
    }

    if (replyToAgent === true) {
      const epoch = prev + 1;
      epochs.set(sessionKey, epoch);
      capMap(epochs, CAP);
      return { decision: "speak", epoch, path: "reply" };
    }

    if (hasHardTrigger(prompt, messages, agentName, agentContactIds, agentAliases)) {
      const epoch = prev + 1;
      epochs.set(sessionKey, epoch);
      capMap(epochs, CAP);
      return { decision: "speak", epoch, path: "hard" };
    }

    if (!llm || !llm.complete) {
      return null;
    }

    const v2 = cfg?.decide?.v2Contract === true;
    const decidePrompt = buildDecidePrompt({ transcript, persona, voiceCard, agentName, mediaKind, memoryContext, threadContext, v2Contract: v2, language: cfg?.language, moodEnergy });

    try {
      const result = await llm.complete({
        messages: [
          { role: "system", content: decidePrompt.systemPrompt },
          { role: "user", content: decidePrompt.userMessage },
        ],
        temperature: cfg?.decide?.temperature ?? 0.2,
        maxTokens: v2 ? 48 : 8,
        purpose: "human-engine-decide",
        agentId: agentIdFromSessionKey(sessionKey) || undefined,
        allowAgentIdOverride: true, // host requires explicit override authorization for plugin agentId (LLM_COMPLETION_NOT_AUTHORIZED)
        signal: AbortSignal.timeout(15000),
      });

      const raw = result?.text || "";
      const v2res = v2 ? parseDecideVerdictV2(raw) : null;
      const verdict = v2 ? (v2res?.decision ?? parseDecideVerdict(raw)) : parseDecideVerdict(raw);
      if (verdict === "SPEAK") {
        const epoch = prev + 1;
        epochs.set(sessionKey, epoch);
        capMap(epochs, CAP);
        const base = { decision: "speak", epoch, path: "llm" };
        return v2 ? { ...base, reason: v2res?.reason || "", addressedTo: v2res?.addressedTo || "" } : base;
      }
      // Only speak advances the epoch; stay_silent keeps it unchanged so an
      // ignored message mid-delivery cannot supersede live bubbles.
      const silent = { decision: "stay_silent", epoch: prev, path: "llm" };
      return v2 ? { ...silent, reason: v2res?.reason || "", addressedTo: v2res?.addressedTo || "" } : silent;
    } catch (err) {
      _log.warn(`human-engine: local-engine: decide LLM error: ${err?.message || err}`);
      return null;
    }
  }

  function estimateReadMs(triggerInfo, transcript) {
    const info = triggerInfo || {};
    let ms = 0;
    const triggerLen = typeof info.triggerLen === "number" ? info.triggerLen : null;
    if (triggerLen != null && triggerLen > 200) {
      ms += Math.min(4000, Math.floor(triggerLen / 20) * 1000);
    }
    const MEDIA_READ_MS = { image: 2500, video: 4000, voice: 1500, audio: 1500, document: 2000, sticker: 800, unknown: 1500 };
    const mediaMarkerRe = /\[(image|video|voice message|audio|document|sticker)\]/i;
    const lines = Array.isArray(transcript) ? transcript : [];
    for (const l of lines) {
      const m = mediaMarkerRe.exec(String(l?.text || ""));
      if (!m) continue;
      const raw = m[1].toLowerCase();
      const kind = raw === "voice message" ? "voice" : raw;
      ms += MEDIA_READ_MS[kind] ?? 1500;
    }
    return ms;
  }

  async function respond({ sessionKey, draft, epoch, systemPrompt, agentName, transcript, persona, voiceCard, isGroup, replyTarget, triggerInfo, language }) {
    const currentEp = epochs.get(sessionKey) || 0;
    if (epoch < currentEp) {
      return { superseded: true };
    }

    if (!llm || !llm.complete) {
      return { scheduled: [{ content: draft, position: 0, delayMs: 100 }], superseded: false };
    }

    const maxBubbles = cfg?.humanize?.maxBubbles ?? 5;
    const moodEnergy = triggerInfo?.moodEnergy ?? null;
    const splitPrompt = buildSplitPrompt({ draft, transcript, persona, voiceCard, maxBubbles, replyTarget, language, moodEnergy });

    try {
      const result = await llm.complete({
        messages: [
          { role: "system", content: splitPrompt.systemPrompt },
          { role: "user", content: splitPrompt.userMessage },
        ],
        temperature: cfg?.humanize?.temperature ?? 0.9,
        maxTokens: 1024,
        purpose: "human-engine-humanize",
        agentId: agentIdFromSessionKey(sessionKey) || undefined,
        allowAgentIdOverride: true, // host requires explicit override authorization for plugin agentId (LLM_COMPLETION_NOT_AUTHORIZED)
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
          const ctx = {
            isGroup: isGroup === true,
            isQuestionReply: Boolean(triggerInfo?.replyTarget?.quotedName),
            wasAddressed: triggerInfo?.wasAddressed === true,
            contentReadMs: estimateReadMs(triggerInfo, transcript),
            hourOfDay: new Date().getHours(),
            moodEnergy: triggerInfo?.moodEnergy ?? null,
            newestAgeMs: triggerInfo?.newestAgeMs ?? null,
          };
          const scheduled = timing.scheduleForBubbles(bubbles, ctx, timingCfg);
          return { scheduled, superseded: false };
        }
      }

      return { scheduled: [{ content: draft, position: 0, delayMs: 100 }], superseded: false };
    } catch (err) {
      _log.warn(`human-engine: local-engine: respond LLM error: ${err?.message || err}`);
      return { scheduled: [{ content: draft, position: 0, delayMs: 100 }], superseded: false };
    }
  }

  async function extractVoiceCard({ transcript, agentId }) {
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
        agentId: agentId || undefined,
        allowAgentIdOverride: true, // host requires explicit override authorization for plugin agentId (LLM_COMPLETION_NOT_AUTHORIZED)
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

  async function extractSelfVoice({ transcript, agentId }) {
    if (!llm || !llm.complete || !transcript || transcript.length === 0) return null;

    try {
      const extractPrompt = buildSelfVoiceExtractPrompt({ transcript });
      const result = await llm.complete({
        messages: [
          { role: "system", content: extractPrompt.systemPrompt },
          { role: "user", content: extractPrompt.userMessage },
        ],
        temperature: 0.2,
        maxTokens: 800,
        purpose: "human-engine-self-voice",
        agentId: agentId || undefined,
        allowAgentIdOverride: true, // host requires explicit override authorization for plugin agentId (LLM_COMPLETION_NOT_AUTHORIZED)
        signal: AbortSignal.timeout(30000),
      });

      const raw = result?.text || "";
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart < 0 || jsonEnd <= jsonStart) return null;

      const profile = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      if (!profile || !profile.summary) return null;

      const promptBlock = renderSelfVoiceBlock(profile);
      if (!promptBlock) return null;

      return { prompt_block: promptBlock, profile };
    } catch {
      return null;
    }
  }

  async function enhancePersona({ persona, agentId }) {
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
        agentId: agentId || undefined,
        allowAgentIdOverride: true, // host requires explicit override authorization for plugin agentId (LLM_COMPLETION_NOT_AUTHORIZED)
        signal: AbortSignal.timeout(60000),
      });

      const text = result?.text?.trim();
      if (!text) return null;

      return { system_prompt: text };
    } catch {
      return null;
    }
  }

  async function regenerateReply({ sessionKey, reasoning, transcript, systemPrompt, agentName, language }) {
    if (!llm || !llm.complete) return null;
    const prompt = buildRegeneratePrompt({ reasoning, transcript, agentName, language });
    try {
      const result = await llm.complete({
        messages: [
          { role: "system", content: prompt.systemPrompt },
          { role: "user", content: prompt.userMessage },
        ],
        temperature: 0.9,
        maxTokens: 200,
        purpose: "human-engine-regen",
        agentId: agentIdFromSessionKey(sessionKey) || undefined,
        allowAgentIdOverride: true, // host requires explicit override authorization for plugin agentId (LLM_COMPLETION_NOT_AUTHORIZED)
        signal: AbortSignal.timeout(30000),
      });
      const text = (result?.text || "").trim();
      return text ? { text } : null;
    } catch (err) {
      _log.warn(`human-engine: local-engine: regen LLM error: ${err?.message || err}`);
      return null;
    }
  }

  return { decide, respond, currentEpoch: (sk) => epochs.get(sk) || 0, extractVoiceCard, extractSelfVoice, enhancePersona, regenerateReply };
}
