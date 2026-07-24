import { isEnabled, isScopedAgent } from "./config.js";
import * as state from "./state.js";
import { capMap } from "./state.js";

export const bubbleTimers = new Map();

export function clearAllBubbleTimers() {
  for (const timers of bubbleTimers.values()) {
    for (const t of timers) clearTimeout(t);
  }
  bubbleTimers.clear();
}

export function createNaturalize({ cfg, state: st, engine, persona, socialMemory, log }) {
  const _log = log || { info() {}, warn() {}, debug() {} };

  function onBeforeAgentReply(event, ctx) {
    try {
      if (!isEnabled(cfg)) return;
      if (!isScopedAgent(cfg, ctx?.agentId)) return;
      const sk = ctx?.sessionKey;
      if (!sk) return;
      const cleanedBody = event?.cleanedBody || "";
      if (!cleanedBody || !state.speakEpochBySession.has(sk)) return;
      state.draftBySession.set(sk, cleanedBody);
      capMap(state.draftBySession, 4096);
      return;
    } catch {
      return;
    }
  }

  async function onReplyDispatch(event, ctx) {
    try {
      if (!isEnabled(cfg)) return;
      if (!isScopedAgent(cfg, ctx?.agentId)) return;
      const sk = ctx?.sessionKey;
      if (!sk) return;
      if (event?.sendPolicy !== "allow") return;

      const epoch = state.speakEpochBySession.get(sk);
      if (epoch == null) return;
      state.speakEpochBySession.delete(sk);

      const draft = state.draftBySession.get(sk);
      if (!draft) return;
      state.draftBySession.delete(sk);

      const chatKey = ctx.chatId || ctx.channelId || sk;
      const latest = state.latestEpochByChat.get(chatKey);
      let effectiveEpoch = epoch;
      if (latest != null && latest !== epoch) {
        effectiveEpoch = latest;
      }

      const dispatcher = ctx.dispatcher;
      _log.info("human-engine: dispatch sk=%s epoch=%s hasDraft=%s hasDispatcher=%s sendPolicy=%s", sk, epoch, Boolean(draft), Boolean(dispatcher), event?.sendPolicy);
      if (!dispatcher) return;

      const systemPrompt = persona?.buildPersonaPromptWithMemory?.(cfg, state, sk) || null;

      const isGroup = state.chatTypeBySession.get(sk) === "group";

      let respondResult;
      if (engine) {
        respondResult = await engine.respond({
          sessionKey: sk,
          draft,
          epoch: effectiveEpoch,
          systemPrompt,
          agentName: cfg.agentName,
          transcript: state.transcriptBySession?.get?.(sk),
          persona: systemPrompt,
          voiceCard: null,
          isGroup,
        });
      }

      if (socialMemory && cfg.socialMemory?.enabled !== false) {
        const scope = (ctx.agentId || "?") + "::" + sk;
        socialMemory.ingest(scope, { speaker: cfg.agentName || "Agent", text: draft, ts: Date.now() });
      }

      if (!respondResult || respondResult.superseded) {
        return;
      }

      const scheduled = respondResult.scheduled;
      if (!scheduled || scheduled.length === 0) {
        return;
      }

      cancelSessionTimers(sk);

      const timers = [];
      const abortController = new AbortController();

      if (ctx.abortSignal) {
        ctx.abortSignal.addEventListener("abort", () => {
          abortController.abort();
          cancelSessionTimers(sk);
          try { dispatcher.markComplete(); } catch {}
        }, { once: true });
      }

      for (let i = 0; i < scheduled.length; i++) {
        const bubble = scheduled[i];
        const timer = setTimeout(() => {
          if (abortController.signal.aborted) return;
          const currentEp = engine ? engine.currentEpoch(sk) : 0;
          if (currentEp > effectiveEpoch) {
            cancelSessionTimers(sk);
            try { dispatcher.markComplete(); } catch {}
            return;
          }
          try {
            dispatcher.sendBlockReply({ text: bubble.content });
          } catch {}
          if (i === scheduled.length - 1) {
            cancelSessionTimers(sk);
            try { dispatcher.markComplete(); } catch {}
          }
        }, bubble.delayMs);
        timers.push(timer);
      }

      bubbleTimers.set(sk, timers);
      return { handled: true };
    } catch {
      return;
    }
  }

  function cancelSessionTimers(sk) {
    const existing = bubbleTimers.get(sk);
    if (existing) {
      for (const t of existing) clearTimeout(t);
      bubbleTimers.delete(sk);
    }
  }

  return { onBeforeAgentReply, onReplyDispatch };
}
