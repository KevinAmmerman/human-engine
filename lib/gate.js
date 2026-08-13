import { isEnabled, isScopedAgent } from "./config.js";
import { toServiceMessages, isCommand } from "./messages.js";
import * as state from "./state.js";
import { pushObserved, capMap, pushTranscriptPeek, getTranscriptPeek } from "./state.js";
import { loadContacts, resolveContactName, findAgentContactIds } from "./contacts.js";

const OBSERVED_HEADER = "[Observed group context — you stayed silent]";
const BLOCK_TEXT_RE = /^your message could not be sent\b[\s\S]*\bblocked by human[ -]?engine\b/i;
const CHAT_SESSION_RE = /:(whatsapp|telegram|discord|signal|slack|matrix):/;
const SENDER_ID_RE = /^(?:\+?\d{6,}|\d{6,}@lid|@\d{6,})$/;

export function isGroupSessionKey(sk) {
  return typeof sk === "string" && sk.includes(":group:");
}

export function isChatSession(sk) {
  if (typeof sk !== "string") return false;
  if (sk.includes(":heartbeat")) return false;
  return CHAT_SESSION_RE.test(sk);
}

export function createGate({ cfg, state: st, engine, persona, socialMemory, observedStore, readTranscript, log }) {
  const _log = log || { info() {}, warn() {}, debug() {} };

  function resolveSender(...candidates) {
    const named = resolveContactName(loadContacts(cfg.contactsPath), ...candidates);
    if (named) return named;
    for (const c of candidates) {
      if (typeof c === "string" && c) {
        if (SENDER_ID_RE.test(c)) {
          const last4 = c.replace(/^@/, "").replace(/\D/g, "").slice(-4);
          return "member-" + last4;
        }
        return c;
      }
    }
    return "User";
  }

  function isGroup(sk) {
    return isGroupSessionKey(sk) || state.chatTypeBySession.get(sk) === "group";
  }

  function persist(sk, senderName, prompt) {
    if (!observedStore?.appendObserved) return;
    try {
      observedStore.appendObserved(sk, { speaker: senderName, text: prompt, ts: Date.now() });
    } catch {}
  }

  function pushPeekDedup(sk, senderName, text) {
    const peekArr = state.transcriptPeekBySession.get(sk);
    const alreadyPeeked = peekArr && peekArr.length > 0 && peekArr[peekArr.length - 1].endsWith("] " + text);
    if (!alreadyPeeked) {
      pushTranscriptPeek(sk, "[" + senderName + "] " + text);
    }
  }

  function mergeTranscriptLayers(hydrated, ...layers) {
    const merged = Array.isArray(hydrated) ? [...hydrated] : [];
    const tailIsIncluded = (line) => {
      const tail = String(line.text || "").slice(-200);
      return merged.some((m) => String(m.text || "").endsWith(tail));
    };
    for (const layer of layers) {
      if (Array.isArray(layer)) {
        for (const entry of layer) {
          if (!entry || typeof entry.text !== "string") continue;
          if (!tailIsIncluded(entry)) {
            merged.push({ speaker: entry.speaker || "", text: entry.text });
          }
        }
      } else if (layer && typeof layer.text === "string") {
        if (layer.text && !tailIsIncluded(layer)) {
          merged.push({ speaker: layer.speaker || "", text: layer.text });
        }
      }
    }
    return merged.slice(-20);
  }

  async function resolveTranscript(sk, ctx, senderName, prompt) {
    const peek = getTranscriptPeek(sk, 20);
    let hydrated = [];
    if (typeof readTranscript === "function") {
      try {
        const h = await readTranscript(sk, ctx?.sessionId, 20);
        if (Array.isArray(h)) hydrated = h;
      } catch {}
    }
    const observed = observedStore ? observedStore.readObserved(sk, 20) : [];
    return mergeTranscriptLayers(hydrated, observed, peek, { speaker: senderName, text: prompt });
  }

  function ingestSocial(sk, agentId, speaker, text) {
    if (!socialMemory || !isChatSession(sk)) return;
    const scope = (agentId || "?") + "::" + sk;
    socialMemory.ingest(scope, { speaker, text, ts: Date.now() });
  }

  function markStaySilent(sk, senderName, prompt, epoch, reason) {
    pushObserved(sk, `[${senderName}] ${prompt}`);
    persist(sk, senderName, prompt);
    _log.info(`human-engine: stay_silent handled sk=${sk} epoch=${epoch} reason=${reason} (turn silenced pre-run)`);
    return { handled: true };
  }

  function markSpeak(sk, agentId, senderName, epoch) {
    if (epoch != null) {
      state.speakEpochBySession.set(sk, { epoch, ts: Date.now() });
      capMap(state.speakEpochBySession, 4096);
    }
    if (socialMemory && isChatSession(sk)) {
      const scope = (agentId || "?") + "::" + sk;
      const mem = socialMemory.recall(scope, [senderName, cfg.agentName || "Agent"]);
      if (mem) {
        state.memoryBySession.set(sk, mem);
      }
    }
  }

  function onMessageReceived(event, ctx) {
    _log.info(`human-engine: message_received fired sk=${ctx?.sessionKey} isGroup=${ctx?.isGroup} agent=${ctx?.agentId}`);
    try {
      const sk = ctx?.sessionKey;
      if (!sk) return;
      state.chatTypeBySession.set(sk, isGroupSessionKey(sk) || ctx?.isGroup === true ? "group" : "dm");
      capMap(state.chatTypeBySession, 4096);

      const text = typeof event === "string" ? event : event?.text || event?.content || "";
      const senderName = resolveSender(event?.metadata?.senderName, ctx?.senderName, ctx?.senderId);
      state.senderBySession.set(sk, senderName);
      capMap(state.senderBySession, 4096);
      if (text) {
        pushTranscriptPeek(sk, "[" + senderName + "] " + text);
      }

      if (isEnabled(cfg) && isScopedAgent(cfg, ctx?.agentId)) {
        ingestSocial(sk, ctx?.agentId, senderName, text);
      }
    } catch {
    }
  }

  async function onBeforeAgentReply(event, ctx) {
    _log.info(`human-engine: before_agent_reply fired sk=${ctx?.sessionKey} bodyLen=${(event?.cleanedBody || "").length}`);
    try {
      if (!isEnabled(cfg)) return;
      if (!isScopedAgent(cfg, ctx?.agentId)) return;
      const sk = ctx?.sessionKey;
      if (!sk) return;
      if (ctx?.trigger === "heartbeat") return;

      const prompt = event?.cleanedBody || "";
      if (!prompt) return;
      if (isCommand(prompt)) return;

      const senderName = resolveSender(ctx?.senderName, ctx?.senderId, state.senderBySession.get(sk));
      state.senderBySession.set(sk, senderName);
      capMap(state.senderBySession, 4096);
      pushPeekDedup(sk, senderName, prompt);
      ingestSocial(sk, ctx?.agentId, senderName, prompt);

      const messages = toServiceMessages([{ text: prompt, senderName }]);
      const isDM = !isGroup(sk);
      const hasMedia = false;

      const systemPrompt = persona?.buildPersonaPrompt(cfg, sk);
      const decidePersona = persona?.buildSoulPrompt ? persona.buildSoulPrompt(cfg) : null;
      const transcriptLines = await resolveTranscript(sk, ctx, senderName, prompt);
      const agentContactIds = findAgentContactIds(loadContacts(cfg.contactsPath), cfg.agentName);

      const engineResult = await engine.decide({
        sessionKey: sk,
        messages,
        systemPrompt: systemPrompt || undefined,
        isDM,
        hasMedia,
        prompt,
        agentName: cfg.agentName,
        transcript: transcriptLines,
        persona: decidePersona || undefined,
        voiceCard: null,
        agentContactIds,
      });

      const decision = engineResult?.decision;
      const epoch = engineResult?.epoch;
      const path = engineResult?.path || (engineResult === null ? "engine-null" : "?");
      _log.info(`human-engine: claim sk=${sk} isDM=${isDM} decision=${String(decision)} path=${path} epoch=${epoch}`);

      if (epoch != null) {
        const chatKey = ctx.chatId || ctx.channelId || sk;
        state.latestEpochByChat.set(chatKey, epoch);
        capMap(state.latestEpochByChat, 4096);
      }

      if (decision === "speak") {
        markSpeak(sk, ctx?.agentId, senderName, epoch);
        return;
      }

      if (decision === "stay_silent") {
        return markStaySilent(sk, senderName, prompt, epoch, "decide");
      }

      if (engineResult === null) {
        if (isGroup(sk)) {
          return markStaySilent(sk, senderName, prompt, epoch ?? -1, "group-fail-closed");
        }
        return;
      }

      return;
    } catch (err) {
      _log.warn(`human-engine: before_agent_reply error sk=${ctx?.sessionKey}: ${err?.message || err}`);
      try {
        const sk = ctx?.sessionKey;
        const prompt = event?.cleanedBody || "";
        const senderName = resolveSender(ctx?.senderName, ctx?.senderId, sk ? state.senderBySession.get(sk) : undefined);
        if (sk && isGroup(sk) && prompt && !isCommand(prompt)) {
          return markStaySilent(sk, senderName, prompt, -1, "gate-error-fail-closed");
        }
      } catch {}
      return;
    }
  }

  function onBeforeAgentRun(event, ctx) {
    _log.info(`human-engine: before_agent_run fired sk=${ctx?.sessionKey} agent=${ctx?.agentId}`);
    try {
      if (!isEnabled(cfg)) return;
      if (!isScopedAgent(cfg, ctx?.agentId)) return;

      const prompt = event?.prompt || event?.content || event?.body || "";
      const sk = ctx?.sessionKey || event?.sessionKey;
      if (!sk) return;

      if (ctx?.isGroup === true) {
        state.chatTypeBySession.set(sk, "group");
        capMap(state.chatTypeBySession, 4096);
      }

      const senderName = resolveSender(ctx?.senderName, ctx?.senderId, event?.senderName, event?.senderId, state.senderBySession.get(sk));
      state.senderBySession.set(sk, senderName);
      capMap(state.senderBySession, 4096);
      if (prompt) {
        pushPeekDedup(sk, senderName, prompt);
        ingestSocial(sk, ctx?.agentId, senderName, prompt);
      }
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

  return { onMessageReceived, onBeforeAgentReply, onBeforeAgentRun, onBeforePromptBuild, onMessageSending };
}
