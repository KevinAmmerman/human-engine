import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "./lib/config.js";
import { createGate } from "./lib/gate.js";
import { createNaturalize } from "./lib/naturalize.js";
import { buildPersonaPrompt, buildPersonaPromptWithMemory, buildSoulPrompt } from "./lib/persona.js";
import * as state from "./lib/state.js";
import { createVoiceCard } from "./lib/voice-card.js";
import { enhanceAndWrite, maybeAutoEnhance } from "./lib/soul.js";
import { planConfigChanges, formatReport } from "./lib/autoconfig.js";
import { createLocalEngine } from "./lib/local-engine.js";
import { createSocialMemory } from "./lib/social-memory.js";
import { createObservedStore } from "./lib/observed-store.js";
import { createProactive } from "./lib/proactive.js";
import { createDmProactive } from "./lib/dm-proactive.js";
import * as timing from "./lib/timing-engine.js";

const runtime = { api: null, cfg: null };

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

    const persona = { buildPersonaPrompt, buildPersonaPromptWithMemory, buildSoulPrompt };

    const pluginDir = new URL(".", import.meta.url).pathname;
    const stateDir = process.env.HUMAN_ENGINE_STATE_DIR || pluginDir + "state";

    const socialMemory = createSocialMemory({ cfg, llm, stateDir, log });

    const observedStore = createObservedStore({ stateDir, log });

    const proactive = createProactive({ cfg, state, engine, socialMemory, observedStore, runtime: api.runtime, stateDir, log });

    const dmProactive = createDmProactive({ cfg, llm, socialMemory, runtime: api.runtime, stateDir, log });

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
        const agentId = typeof sessionKey === "string" && sessionKey.startsWith("agent:")
          ? sessionKey.split(":")[1]
          : undefined;
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
          const speaker = role === "assistant" ? (cfg.agentName || "Agent") : "User";
          out.push({ speaker, text: text.slice(0, 300) });
        }
        return out.slice(-limit);
      } catch {
        return [];
      }
    }

    const gate = createGate({ cfg, engine, persona, socialMemory, observedStore, readTranscript: readSessionTranscript, log, proactive });
    const naturalize = createNaturalize({ cfg, engine, persona, socialMemory, log });

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
    api.on("before_agent_reply", wrap(gate.onBeforeAgentReply));
    api.on("before_agent_run", wrap(gate.onBeforeAgentRun));
    api.on("before_prompt_build", wrap(gate.onBeforePromptBuild));
    api.on("message_sending", wrap(gate.onMessageSending));
    api.on("message_sending", wrap(dmProactive.onMessageSending));
    api.on("before_prompt_build", wrap(voiceCard.onBeforePromptBuild));
    api.on("reply_dispatch", wrap(naturalize.onReplyDispatch));
    api.on("reply_payload_sending", wrap(naturalize.onReplyPayloadSending));

    api.on("gateway_start", wrap(() => {
      maybeAutoEnhance(cfg, engine);

      if (cfg.autoconfig) {
        const plan = planConfigChanges(cfg, api.config || {});
        const report = formatReport(plan);
        log.info(`human-engine autoconfig:\n${report}`);
      }
    }));

    const proactiveTick = setInterval(() => {
      proactive.tick().catch((err) => log.warn(`human-engine: proactive tick error: ${err?.message || err}`));
    }, 30 * 60 * 1000);
    if (typeof proactiveTick.unref === "function") proactiveTick.unref();

    api.on("gateway_stop", wrap(() => {
      clearInterval(proactiveTick);
      proactive.stop();
      dmProactive.stop();
      log.info("human-engine: proactive tick stopped (gateway_stop)");
    }));

    api.registerCommand({
      name: "soul",
      description: "Enhance your persona via local LLM.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const sub = (ctx.args || "").trim().toLowerCase();
        if (sub && !sub.startsWith("enhance")) {
          return { text: "Usage: /soul enhance \u2014 run persona enhancement." };
        }
        const reply = await enhanceAndWrite(cfg, engine);
        return { text: reply };
      },
    });
  },
});
