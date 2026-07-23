import { isEnabled, isScopedAgent } from "./config.js";
import { toServiceMessages, isCommand } from "./messages.js";
import * as state from "./state.js";
import { pushObserved, capMap, pushTranscriptPeek } from "./state.js";

const OBSERVED_HEADER = "[Observed group context — you stayed silent]";

export function createGate({ cfg, state: st, engine, persona, socialMemory, log }) {
  const _log = log || { info() {}, warn() {}, debug() {} };

  function onMessageReceived(event, ctx) {
    try {
      const sk = ctx?.sessionKey;
      if (!sk) return;
      state.chatTypeBySession.set(sk, ctx.isGroup === true ? "group" : "dm");
      capMap(state.chatTypeBySession, 4096);

      const text = typeof event === "string" ? event : event?.text || event?.content || "";
      if (text) {
        pushTranscriptPeek(sk, "[" + (ctx.senderId || "User") + "] " + text);
      }

      if (socialMemory && isEnabled(cfg) && isScopedAgent(cfg, ctx?.agentId)) {
        const scope = (ctx.agentId || "?") + "::" + sk;
        socialMemory.ingest(scope, { speaker: ctx.senderId || "User", text, ts: Date.now() });
      }
    } catch {
    }
  }

  async function onBeforeAgentRun(event, ctx) {
    try {
      if (!isEnabled(cfg)) return;
      if (!isScopedAgent(cfg, ctx?.agentId)) return;

      const prompt = event?.prompt || "";
      if (!prompt && !event?.messages?.length) return;
      if (isCommand(prompt)) return;

      const sk = ctx?.sessionKey;
      if (!sk) return;

      pushTranscriptPeek(sk, "[" + (ctx.senderId || "User") + "] " + prompt);

      if (socialMemory) {
        const scope = (ctx.agentId || "?") + "::" + sk;
        socialMemory.ingest(scope, { speaker: ctx.senderId || "User", text: prompt, ts: Date.now() });
      }

      const messages = toServiceMessages([{ text: prompt, senderName: ctx.senderId || "User" }]);
      const isDM = (state.chatTypeBySession.get(sk) || "dm") === "dm";
      const hasMedia = (event?.messages || []).some((m) => m.hasMedia === true);

      const systemPrompt = persona?.buildPersonaPrompt(cfg, sk);

      const engineResult = await engine.decide({
        sessionKey: sk,
        messages,
        systemPrompt: systemPrompt || undefined,
        isDM,
        hasMedia,
        prompt,
        agentName: cfg.agentName,
        transcript: event?.messages ? (event.messages.filter(m => m.role === "user").map(m => ({ speaker: ctx.senderId || "User", text: typeof m.content === "string" ? m.content : "" }))) : [],
        persona: systemPrompt || undefined,
        voiceCard: null,
      });

      const decision = engineResult?.decision;
      const epoch = engineResult?.epoch;

      if (epoch != null) {
        const chatKey = ctx.chatId || ctx.channelId || sk;
        state.latestEpochByChat.set(chatKey, epoch);
        capMap(state.latestEpochByChat, 4096);
      }

      if (decision === "speak") {
        if (epoch != null) {
          state.speakEpochBySession.set(sk, epoch);
          capMap(state.speakEpochBySession, 4096);
        }
        if (socialMemory) {
          const scope = (ctx.agentId || "?") + "::" + sk;
          const mem = socialMemory.recall(scope, [ctx.senderId || "User", cfg.agentName || "Agent"]);
          if (mem) {
            state.memoryBySession.set(sk, mem);
          }
        }
        return;
      }

      if (decision === "stay_silent") {
        pushObserved(sk, `[${ctx.senderId || "User"}] ${prompt}`);
        return { outcome: "block", reason: "human-engine-stay-silent", message: "" };
      }

      if (engineResult === null) {
        const chatType = state.chatTypeBySession.get(sk) || "dm";
        if (chatType === "group") {
          pushObserved(sk, `[${ctx.senderId || "User"}] ${prompt}`);
          return { outcome: "block", reason: "human-engine-group-fail-closed", message: "" };
        }
        return;
      }

      return;
    } catch {
      return;
    }
  }

  function onBeforePromptBuild(event, ctx) {
    try {
      if (!isEnabled(cfg)) return;
      if (!isScopedAgent(cfg, ctx?.agentId)) return;
      const sk = ctx?.sessionKey;
      if (!sk) return;

      const result = {};

      const observedLines = state.observedBySession.get(sk);
      if (observedLines && observedLines.length > 0) {
        result.appendContext = OBSERVED_HEADER + "\n" + observedLines.join("\n");
        state.observedBySession.delete(sk);
      }

      const mem = state.memoryBySession.get(sk);
      if (mem) {
        result.appendSystemContext = `What you know about the people here (from memory):\n${mem}`;
      }

      if (result.appendContext || result.appendSystemContext) {
        return result;
      }
      return;
    } catch {
      return;
    }
  }

  return { onMessageReceived, onBeforeAgentRun, onBeforePromptBuild };
}
