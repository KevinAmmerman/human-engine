import { isEnabled, isScopedAgent } from "./config.js";
import { toServiceMessages, isCommand } from "./messages.js";
import * as state from "./state.js";
import { pushObserved, capMap, pushTranscriptPeek } from "./state.js";

const OBSERVED_HEADER = "[Observed group context — you stayed silent]";
const BLOCK_TEXT_RE = /^Your message could not be sent\b[\s\S]*\bblocked by human-engine\b/;

export function isGroupSessionKey(sk) {
  return typeof sk === "string" && sk.includes(":group:");
}

export function createGate({ cfg, state: st, engine, persona, socialMemory, persistObserved, log }) {
  const _log = log || { info() {}, warn() {}, debug() {} };

  function isGroup(sk) {
    return isGroupSessionKey(sk) || state.chatTypeBySession.get(sk) === "group";
  }

  function persist(sk, senderName, prompt) {
    if (typeof persistObserved !== "function") return;
    try {
      persistObserved(sk, senderName, prompt);
    } catch {}
  }

  function onMessageReceived(event, ctx) {
    _log.info(`human-engine: message_received fired sk=${ctx?.sessionKey} isGroup=${ctx?.isGroup} agent=${ctx?.agentId}`);
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
    _log.info(`human-engine: before_agent_run fired sk=${ctx?.sessionKey} agent=${ctx?.agentId}`);
    try {
      if (!isEnabled(cfg)) return;
      if (!isScopedAgent(cfg, ctx?.agentId)) return;

      const prompt = event?.prompt || event?.content || event?.body || "";
      if (!prompt) return;
      if (isCommand(prompt)) return;

      const sk = ctx?.sessionKey || event?.sessionKey;
      if (!sk) return;

      if (ctx?.isGroup === true) {
        state.chatTypeBySession.set(sk, "group");
        capMap(state.chatTypeBySession, 4096);
      }

      const senderName = ctx?.senderName || ctx?.senderId || event?.senderName || event?.senderId || "User";

      pushTranscriptPeek(sk, "[" + senderName + "] " + prompt);

      if (socialMemory) {
        const scope = (ctx.agentId || "?") + "::" + sk;
        socialMemory.ingest(scope, { speaker: senderName, text: prompt, ts: Date.now() });
      }

      const messages = toServiceMessages([{ text: prompt, senderName }]);
      const isDM = !isGroup(sk);
      const hasMedia = false;

      const systemPrompt = persona?.buildPersonaPrompt(cfg, sk);

      const transcriptLines = typeof event?.transcript === "string" && event.transcript
        ? event.transcript.split("\n").filter(Boolean).slice(-20).map((line) => ({ speaker: "", text: line }))
        : [{ speaker: senderName, text: prompt }];

      const engineResult = await engine.decide({
        sessionKey: sk,
        messages,
        systemPrompt: systemPrompt || undefined,
        isDM,
        hasMedia,
        prompt,
        agentName: cfg.agentName,
        transcript: transcriptLines,
        persona: systemPrompt || undefined,
        voiceCard: null,
      });

      const decision = engineResult?.decision;
      const epoch = engineResult?.epoch;
      _log.info(`human-engine: claim sk=${sk} isDM=${isDM} decision=${String(decision)} epoch=${epoch} mid=${event?.messageId || ""}`);

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
          const mem = socialMemory.recall(scope, [senderName, cfg.agentName || "Agent"]);
          if (mem) {
            state.memoryBySession.set(sk, mem);
          }
        }
        return;
      }

      if (decision === "stay_silent") {
        pushObserved(sk, `[${senderName}] ${prompt}`);
        persist(sk, senderName, prompt);
        if (epoch != null) {
          state.silentEpochBySession.set(sk, epoch);
          capMap(state.silentEpochBySession, 4096);
        }
        _log.info(`human-engine: stay_silent marked sk=${sk} epoch=${epoch} (suppress at reply)`);
        return;
      }

      if (engineResult === null) {
        if (isGroup(sk)) {
          pushObserved(sk, `[${senderName}] ${prompt}`);
          persist(sk, senderName, prompt);
          if (epoch != null) {
            state.silentEpochBySession.set(sk, epoch);
            capMap(state.silentEpochBySession, 4096);
          }
          _log.info(`human-engine: group fail-closed marked sk=${sk} epoch=${epoch} (suppress at reply)`);
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

  function onMessageSending(event, ctx) {
    try {
      const content = typeof event === "string" ? event : event?.content || event?.text || "";
      if (content && BLOCK_TEXT_RE.test(content)) {
        _log.info(`human-engine: cancelling user-facing block text delivery (${content.length} chars)`);
        return { cancel: true };
      }
    } catch {}
    return;
  }

  return { onMessageReceived, onBeforeAgentRun, onBeforePromptBuild, onMessageSending };
}
