import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import fs from "node:fs";
import path from "node:path";
import { resolveConfig, resolveAgentConfig } from "./lib/config.js";
import { createGate } from "./lib/gate.js";
import { createNaturalize, clearAllBubbleTimers } from "./lib/naturalize.js";
import { buildPersonaPrompt, buildPersonaPromptWithMemory, buildSoulPrompt, setSelfVoiceGetter } from "./lib/persona.js";
import * as state from "./lib/state.js";
import { createVoiceCard } from "./lib/voice-card.js";
import { createSelfVoice } from "./lib/self-voice.js";
import { enhanceAndWrite, maybeAutoEnhance } from "./lib/soul.js";
import { warnStartupConfig } from "./lib/autoconfig.js";
import { createLocalEngine } from "./lib/local-engine.js";
import { createSocialMemory } from "./lib/social-memory.js";
import { createObservedStore } from "./lib/observed-store.js";
import { createProactive } from "./lib/proactive.js";
import { createDmProactive } from "./lib/dm-proactive.js";
import { createMood } from "./lib/mood.js";
import { createThreads } from "./lib/threads.js";
import { createInitiative } from "./lib/initiative.js";
import * as timing from "./lib/timing-engine.js";
import { agentIdFromSessionKey } from "./lib/scope.js";

const runtime = { api: null, cfg: null };

export function transcriptEventTsMs(event) {
  const raw = event?.timestamp ?? event?.message?.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function isNoReplyAssistantText(role, text) {
  return role === "assistant" && /^\s*NO_REPLY\s*$/i.test(String(text || ""));
}

export function resolveTranscriptSpeaker(role, message, agentName) {
  if (role === "assistant") return agentName || "Agent";
  const raw = message?.__openclaw?.senderName;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return "User";
}

export default definePluginEntry({
  id: "human-engine",
  name: "Human Engine",
  description: "Local human-like conversation engine: turn-taking, naturalization, voice, persona, social memory.",
  register(api) {
    const cfg = resolveConfig(api);
    runtime.api = api;
    runtime.cfg = cfg;

    const log = api.logger || { info() {}, warn() {}, debug() {}, error() {} };

    const llm = api.runtime?.llm || null;
    if (!llm) {
      log.warn("human-engine: api.runtime.llm not available \u2014 engine runs in degraded mode (no LLM calls)");
    }

    const engine = createLocalEngine({ cfg, llm, timing, log });

    const persona = { buildPersonaPrompt, buildPersonaPromptWithMemory, buildSoulPrompt, snapshotFor: (agentId) => selfVoice.snapshotFor(agentId) };

    const pluginDir = new URL(".", import.meta.url).pathname;
    const stateDir = process.env.HUMAN_ENGINE_STATE_DIR || pluginDir + "state";

    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      for (const d of fs.readdirSync(stateDir, { withFileTypes: true })) {
        if (d.isDirectory()) { try { fs.chmodSync(path.join(stateDir, d.name), 0o700); } catch {} }
      }
      fs.chmodSync(stateDir, 0o700);
    } catch {}

    const socialMemory = createSocialMemory({ cfg, llm, stateDir, log });

    const observedStore = createObservedStore({ stateDir, log });

    const selfVoice = createSelfVoice({ cfg, engine, stateDir, observedStore, log });
    setSelfVoiceGetter((agentId) => selfVoice.snapshotFor(agentId));

    const threads = createThreads({ cfg, stateDir, socialMemory, observedStore, log });

    const proactive = createProactive({ cfg, state, engine, socialMemory, observedStore, runtime: api.runtime, stateDir, log, threads });

    const dmProactive = createDmProactive({ cfg, llm, socialMemory, runtime: api.runtime, stateDir, log, activityFilePath: cfg.dmProactive?.dayFitActivityPath || null });

    const transcriptApiPromise = import("openclaw/plugin-sdk/session-transcript-runtime")
      .then((m) => m)
      .catch((err) => {
        log.warn(`human-engine: session-transcript-runtime unavailable, observed stays plugin-local: ${err?.message || err}`);
        return null;
      });

    async function readSessionTranscript(sessionKey, sessionId, limit = 20) {
      try {
        const m = await transcriptApiPromise;
        if (!m?.readSessionTranscriptEvents) return [];
        const agentId = agentIdFromSessionKey(sessionKey);
        if (!agentId || !sessionId) return [];
        const events = await m.readSessionTranscriptEvents({ agentId, sessionKey, sessionId });
        const out = [];
        for (const e of events || []) {
          if (e?.type !== "message") continue;
          const msg = e.message || {};
          const role = msg.role;
          if (role !== "user" && role !== "assistant") continue;
          let text = "";
          const c = msg.content;
          if (typeof c === "string") text = c;
          else if (Array.isArray(c)) {
            text = c.filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n");
          }
          text = text.trim();
          if (!text) continue;
          if (isNoReplyAssistantText(role, text)) continue;
          const speaker = resolveTranscriptSpeaker(role, msg, resolveAgentConfig(cfg, agentIdFromSessionKey(sessionKey))?.agentName || cfg.agentName || "Agent");
          const entry = { speaker, text: text.slice(0, 300) };
          const ts = transcriptEventTsMs(e);
          if (ts !== undefined) entry.ts = ts;
          out.push(entry);
        }
        return out.slice(-limit);
      } catch {
        return [];
      }
    }

    const mood = createMood({ cfg, llm, stateDir, log, readTranscript: readSessionTranscript });

    const naturalize = createNaturalize({ cfg, engine, persona, socialMemory, observedStore, mood, selfVoice, log });
    const gate = createGate({ cfg, engine, persona, socialMemory, observedStore, readTranscript: readSessionTranscript, log, proactive, onSilence: naturalize.onSilence, threads, mood });

    const initiative = createInitiative({ cfg, stateDir, log, llm, runtime: api.runtime, state, threads });

    const voiceCard = createVoiceCard({ cfg, engine, stateDir, log });

    function wrap(handler) {
      return async (...args) => {
        try {
          return await handler(...args);
        } catch (err) {
          log.warn(`human-engine: hook error: ${err?.message || err}`);
        }
      };
    }

    api.on("message_received", wrap(gate.onMessageReceived));
    api.on("message_received", wrap(dmProactive.onMessageReceived));
    api.on("message_received", wrap(mood.onMessageReceived));
    api.on("message_received", wrap(initiative.onMessageReceived));
    api.on("before_agent_reply", wrap(gate.onBeforeAgentReply));
    api.on("before_agent_run", wrap(gate.onBeforeAgentRun));
    api.on("before_prompt_build", wrap(gate.onBeforePromptBuild));
    api.on("before_prompt_build", wrap(initiative.onBeforePromptBuild));
    api.on("message_sending", wrap(gate.onMessageSending));
    api.on("message_sending", wrap(dmProactive.onMessageSending));
    api.on("before_prompt_build", wrap(voiceCard.onBeforePromptBuild));
    api.on("before_prompt_build", wrap(mood.onBeforePromptBuild));
    api.on("reply_dispatch", wrap(naturalize.onReplyDispatch));
    api.on("reply_payload_sending", wrap(naturalize.onReplyPayloadSending));

    api.on("gateway_start", wrap(() => {
      maybeAutoEnhance(cfg, engine);

      if (cfg.autoconfig) {
        warnStartupConfig(cfg, api.config || {}, log);
      }
    }));

    const proactiveTick = setInterval(() => {
      proactive.tick().catch((err) => log.warn(`human-engine: proactive tick error: ${err?.message || err}`));
    }, 30 * 60 * 1000);
    if (typeof proactiveTick.unref === "function") proactiveTick.unref();

    const initiativeTick = setInterval(() => {
      initiative.tick().catch((err) => log.warn(`human-engine: initiative tick error: ${err?.message || err}`));
    }, 5 * 60 * 1000);
    if (typeof initiativeTick.unref === "function") initiativeTick.unref();

    api.on("gateway_stop", wrap(() => {
      clearInterval(proactiveTick);
      clearInterval(initiativeTick);
      proactive.stop();
      dmProactive.stop();
      clearAllBubbleTimers();
      socialMemory.stop();
      threads.stop();
      initiative.stop();
      log.info("human-engine: proactive tick stopped, naturalize timers cleared (gateway_stop)");
    }));

    function voiceHandler(ctx, sub) {
      const agentId = ctx?.agentId;
      if (!agentId) {
        return { text: "/soul voice requires an agent context (agentId)." };
      }
      if (!selfVoice.__enabled) {
        return { text: "Self-voice is disabled (selfVoice.enabled is not true). Nothing to govern." };
      }
      try {
        if (sub === "voice") {
          const active = selfVoice.snapshotFor(agentId);
          const pending = readPendingSelfVoice(agentId);
          if (!active && !pending) {
            return { text: "No self-voice yet. It learns once you have \u226530 own lines and refresh cadence fires." };
          }
          const lines = [];
          if (active) lines.push(`Active (${active.length} chars):\n${shortHead(active)}`);
          if (pending) lines.push(`Pending diff (${pending.length} chars):\n${shortHead(pending)}`);
          lines.push("Use /soul voice accept to adopt the pending voice, /soul voice reset to clear it.");
          return { text: lines.join("\n\n") };
        }
        if (sub === "voice accept") {
          const pending = readPendingSelfVoice(agentId);
          if (!pending) {
            return { text: "Nothing to accept \u2014 there is no pending self-voice yet." };
          }
          const active = selfVoice.snapshotFor(agentId) || "";
          selfVoice.accept(agentId);
          return { text: `Stimme \u00fcbernommen (${active.length} \u2192 ${pending.length} Zeichen).` };
        }
        if (sub === "voice reset") {
          const had = selfVoice.snapshotFor(agentId) || readPendingSelfVoice(agentId);
          if (!had) {
            return { text: "Nothing to reset \u2014 there is no self-voice yet." };
          }
          selfVoice.reset(agentId);
          return { text: "Self-voice reset \u2014 it will relearn from future replies." };
        }
      } catch (err) {
        log.warn(`human-engine: /soul voice error: ${err?.message || err}`);
        return { text: "Something went wrong reading the self-voice state." };
      }
      return { text: "Usage: /soul voice \u2014 preview, /soul voice accept \u2014 adopt, /soul voice reset \u2014 clear." };
    }

    function readPendingSelfVoice(agentId) {
      const stateDir = process.env.HUMAN_ENGINE_STATE_DIR || new URL(".", import.meta.url).pathname + "state";
      const file = path.join(stateDir, "self-voice", String(agentId).replace(/[^a-zA-Z0-9_-]/g, "_") + ".json");
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return typeof parsed.pendingCard === "string" ? parsed.pendingCard : null;
      } catch {
        return null;
      }
    }

    function shortHead(text) {
      const s = String(text || "").replace(/\s+/g, " ").trim();
      return s.length > 120 ? s.slice(0, 120) + "\u2026" : s;
    }

    api.registerCommand({
      name: "soul",
      description: "Enhance your persona via local LLM, or govern your learned self-voice.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const sub = (ctx.args || "").trim().toLowerCase();
        if (sub === "voice" || sub === "voice accept" || sub === "voice reset") {
          return voiceHandler(ctx, sub);
        }
        if (sub && !sub.startsWith("enhance")) {
          return { text: "Usage: /soul enhance \u2014 run persona enhancement. /soul voice \u2014 preview/accept/reset your learned voice." };
        }
        const reply = await enhanceAndWrite(ctx?.agentId ? resolveAgentConfig(cfg, ctx.agentId) : cfg, engine, ctx?.agentId);
        return { text: reply };
      },
    });
  },
});
