import { isEnabled, isScopedAgent } from "./config.js";
import { toServiceMessages, isCommand } from "./messages.js";
import * as state from "./state.js";
import { pushObserved, capMap, pushTranscriptPeek, getTranscriptPeek } from "./state.js";
import { loadContacts, resolveContactName, findAgentContactIds } from "./contacts.js";
import { wrapUntrusted } from "./local-prompts.js";
import { hasHardTrigger } from "./local-engine.js";
import { redactSessionKey } from "./redact.js";

const OBSERVED_HEADER = "[Observed group context — you stayed silent]";
const BLOCK_TEXT_RE = /^your message could not be sent\b[\s\S]*\bblocked by human[ -]?engine\b/i;
const CHAT_SESSION_RE = /:(whatsapp|telegram|discord|signal|slack|matrix):/;
const SENDER_ID_RE = /^(?:\+?\d{6,}|\d{6,}@lid|@\d{6,})$/;

const SDK_KIND_TO_PLACEHOLDER = {
  image: "[image]",
  video: "[video]",
  audio: "[audio]",
  document: "[document]",
  sticker: "[sticker]",
  voice: "[voice message]",
};

export function detectInboundMedia(event) {
  const facts = event?.media || event?.originalMedia || [];
  if (facts.length === 0) return null;
  const first = facts[0] || {};
  const kind = first.kind || "";
  const hasMedia = true;
  const mediaKind = kind in SDK_KIND_TO_PLACEHOLDER ? kind : "unknown";
  const marker = SDK_KIND_TO_PLACEHOLDER[mediaKind] || "[media]";
  return { hasMedia, mediaKind, marker };
}

export function normText(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
}

export function isGroupSessionKey(sk) {
  return typeof sk === "string" && sk.includes(":group:");
}

export function isChatSession(sk) {
  if (typeof sk !== "string") return false;
  if (sk.includes(":heartbeat")) return false;
  return CHAT_SESSION_RE.test(sk);
}

export function createGate({ cfg, engine, persona, socialMemory, observedStore, readTranscript, log, proactive }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const decideInflight = new Map();

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

  function pushPeekDedup(sk, senderName, text, ts) {
    const peekArr = state.transcriptPeekBySession.get(sk);
    const alreadyPeeked = peekArr && peekArr.length > 0 && peekArr[peekArr.length - 1].endsWith("] " + text);
    if (!alreadyPeeked) {
      pushTranscriptPeek(sk, "[" + senderName + "] " + text, undefined, ts);
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
            merged.push({ speaker: entry.speaker || "", text: entry.text, ts: entry.ts });
          }
        }
      } else if (layer && typeof layer.text === "string") {
        if (layer.text && !tailIsIncluded(layer)) {
          merged.push({ speaker: layer.speaker || "", text: layer.text, ts: layer.ts });
        }
      }
    }
    const tsOf = (x) => (typeof x?.ts === "number" ? x.ts : Infinity);
    merged.sort((a, b) => tsOf(a) - tsOf(b));
    return merged.slice(-20);
  }

  async function resolveTranscript(sk, ctx, senderName, prompt, media) {
    const peek = getTranscriptPeek(sk, 20);
    let hydrated = [];
    if (typeof readTranscript === "function") {
      try {
        const h = await readTranscript(sk, ctx?.sessionId, 20);
        if (Array.isArray(h)) hydrated = h;
      } catch {}
    }
    const observed = observedStore ? observedStore.readObserved(sk, 20) : [];
    const current = { speaker: senderName, text: prompt };
    if (media?.hasMedia && String(prompt || "").trim().length === 0) {
      current.text = media.marker || "[media]";
    }
    return mergeTranscriptLayers(observed, peek, hydrated, current);
  }

  function ingestSocial(sk, agentId, speaker, text) {
    if (!socialMemory || !isChatSession(sk)) return;
    const scope = (agentId || "?") + "::" + sk;
    socialMemory.ingest(scope, { speaker, text, ts: Date.now() });
  }

  function markStaySilent(sk, senderName, prompt, epoch, reason) {
    pushObserved(sk, `[${senderName}] ${prompt}`);
    persist(sk, senderName, prompt);
    _log.info(`human-engine: stay_silent handled sk=${redactSessionKey(sk)} epoch=${epoch} reason=${reason} (turn silenced pre-run)`);
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
        capMap(state.memoryBySession, 4096);
      }
    }
    if (proactive?.onInbound && isEnabled(cfg) && isScopedAgent(cfg, agentId)) {
      proactive.onInbound(sk, { senderName, text: "", isGroup: isGroup(sk), agentId, ownReply: true });
    }
  }

  function onMessageReceived(event, ctx) {
    const sk = ctx?.sessionKey;
    const agentId = ctx?.agentId || (typeof sk === "string" && sk.startsWith("agent:") ? sk.split(":")[1] : undefined);
    _log.info(`human-engine: message_received fired sk=${redactSessionKey(sk)} isGroup=${ctx?.isGroup} agent=${agentId}`);
    try {
      if (!sk) return;
      state.chatTypeBySession.set(sk, isGroupSessionKey(sk) || ctx?.isGroup === true ? "group" : "dm");
      capMap(state.chatTypeBySession, 4096);

      const text = typeof event === "string" ? event : event?.text || event?.content || "";
      const senderName = resolveSender(event?.metadata?.senderName, ctx?.senderName, ctx?.senderId);
      state.senderBySession.set(sk, senderName);
      capMap(state.senderBySession, 4096);
      const media = detectInboundMedia(event);
      if (media) {
        state.mediaBySession.set(sk, media);
        capMap(state.mediaBySession, 4096);
      }
      if (text) {
        const ts = typeof event?.timestamp === "number" ? event.timestamp : Date.now();
        pushTranscriptPeek(sk, "[" + senderName + "] " + text, undefined, ts);
      }

      const replyToSender = ctx?.replyToSender;
      const replyToBody = typeof ctx?.replyToBody === "string" ? ctx.replyToBody : "";
      if (replyToSender || replyToBody) {
        const senderId = typeof ctx?.senderId === "string" ? ctx.senderId : "";
        const qkey = sk + "|" + senderId;
        const q = state.replyContextQueue.get(qkey) || [];
        q.push({ sender: replyToSender || "", body: replyToBody, textNorm: normText(text), ts: Date.now() });
        while (q.length > 5) q.shift();
        state.replyContextQueue.set(qkey, q);
        capMap(state.replyContextQueue, 1024);
        _log.info(`human-engine: reply-context captured sk=${redactSessionKey(sk)} sender=${String(replyToSender || "").slice(0, 40)} bodyLen=${replyToBody.length}`);
      }

      if (isEnabled(cfg) && isScopedAgent(cfg, agentId)) {
        ingestSocial(sk, agentId, senderName, text);
        if (proactive?.onInbound) {
          proactive.onInbound(sk, { senderName, text, isGroup: isGroup(sk), agentId });
        }
      }
    } catch {
    }
  }

  async function onBeforeAgentReply(event, ctx) {
    _log.info(`human-engine: before_agent_reply fired sk=${redactSessionKey(ctx?.sessionKey)} bodyLen=${(event?.cleanedBody || "").length}`);
    try {
      if (!isEnabled(cfg)) return;
      if (!isScopedAgent(cfg, ctx?.agentId)) return;
      const sk = ctx?.sessionKey;
      if (!sk) return;
      if (ctx?.trigger === "heartbeat") return;

      const prompt = event?.cleanedBody || "";
      const cachedMedia = state.mediaBySession.get(sk) || null;
      if (!prompt && !cachedMedia?.hasMedia) return;
      if (isCommand(prompt)) return;

      const senderName = resolveSender(ctx?.senderName, ctx?.senderId, state.senderBySession.get(sk));
      state.senderBySession.set(sk, senderName);
      capMap(state.senderBySession, 4096);
      const displayText = prompt || (cachedMedia?.marker ? cachedMedia.marker : "");
      if (displayText) pushPeekDedup(sk, senderName, displayText, typeof event?.timestamp === "number" ? event.timestamp : Date.now());
      if (prompt) ingestSocial(sk, ctx?.agentId, senderName, prompt);

      const messages = toServiceMessages([{ text: prompt, senderName }]);
      const isDM = !isGroup(sk);
      const hasMedia = cachedMedia ? cachedMedia.hasMedia : false;
      const mediaKind = cachedMedia ? cachedMedia.mediaKind : undefined;

      const systemPrompt = persona?.buildPersonaPrompt(cfg, sk);
      const decidePersona = persona?.buildSoulPrompt ? persona.buildSoulPrompt(cfg) : null;
      const transcriptLines = await resolveTranscript(sk, ctx, senderName, prompt, cachedMedia);
      const agentContactIds = findAgentContactIds(loadContacts(cfg.contactsPath), cfg.agentName, cfg.agentAliases);

      const senderId = typeof ctx?.senderId === "string" ? ctx.senderId : "";
      const qkey = sk + "|" + senderId;
      const q = state.replyContextQueue.get(qkey) || [];
      const nowTs = Date.now();
      const fresh = q.filter((e) => nowTs - e.ts < 5 * 60 * 1000);
      let replyCtx = null;
      const want = normText(prompt);
      const exact = fresh.findLast((e) => e.textNorm && want.startsWith(e.textNorm.slice(0, 40)));
      if (exact) {
        replyCtx = exact;
        state.replyContextQueue.set(qkey, fresh.filter((e) => e !== exact));
      } else if (fresh.length > 0) {
        replyCtx = fresh[fresh.length - 1];
        state.replyContextQueue.set(qkey, fresh.slice(0, -1));
      } else {
        state.replyContextQueue.delete(qkey);
      }
      let replyToAgent = false;
      const replyCtxSender = replyCtx ? replyCtx.sender : "";
      let quotedName = null;
      if (replyCtx && Date.now() - replyCtx.ts < 5 * 60 * 1000) {
        quotedName = resolveContactName(loadContacts(cfg.contactsPath), replyCtx.sender);
        if (quotedName && cfg.agentName && quotedName.toLowerCase().startsWith(cfg.agentName.toLowerCase())) {
          replyToAgent = true;
        } else if (replyCtx.body) {
          const ownPrefix = "[" + (cfg.agentName || "Agent") + "] ";
          const peekArr = state.transcriptPeekBySession.get(sk) || [];
          const head = replyCtx.body.slice(0, 60);
          const headOk = head.length >= 8;
          replyToAgent =
            (headOk && peekArr.some((l) => l.startsWith(ownPrefix) && l.includes(head))) ||
            (headOk &&
              cfg.agentName &&
              transcriptLines.some((l) => {
                const speaker = String(l.speaker || "");
                return (
                  speaker.toLowerCase().startsWith(cfg.agentName.toLowerCase()) &&
                  String(l.text || "").includes(head)
                );
              }));
        }
      }
      _log.info(`human-engine: reply-resolve sk=${redactSessionKey(sk)} sender=${String(replyCtxSender).slice(0, 40)} quotedName=${quotedName || "-"} replyToAgent=${replyToAgent}`);

      const persistReplyTarget = () => {
        if (quotedName || replyToAgent) {
          state.replyTargetBySession.set(sk, {
            quotedName: quotedName || null,
            replyToAgent,
            textHead: replyCtx ? String(replyCtx.body || "").slice(0, 80) : "",
            ts: Date.now(),
          });
          capMap(state.replyTargetBySession, 4096);
        }
      };

      const applyVerdict = (shared) => {
        const decision = shared.decision;
        const epoch = shared.epoch;
        _log.info(`human-engine: claim sk=${redactSessionKey(sk)} isDM=${isDM} decision=${String(decision)} path=${shared.path} epoch=${epoch}`);
        if (decision === "speak") {
          markSpeak(sk, ctx?.agentId, senderName, epoch);
          persistReplyTarget(sk);
          return;
        }
        if (decision === "stay_silent") {
          return markStaySilent(sk, senderName, prompt, epoch, shared.reason || "decide");
        }
        if (shared.engineNull) {
          if (isGroup(sk)) {
            return markStaySilent(sk, senderName, prompt, epoch ?? -1, "group-fail-closed");
          }
          return;
        }
        return;
      };

      const isTriggerMsg =
        isDM || replyToAgent || hasHardTrigger(prompt, messages, cfg.agentName, agentContactIds, cfg.agentAliases);

      const inflight = decideInflight.get(sk);
      if (!isTriggerMsg && inflight) {
        const shared = await inflight;
        _log.info(`human-engine: decide dedup sk=${redactSessionKey(sk)} verdict=${shared.decision} (burst reuse)`);
        if (shared.decision === "speak") {
          markSpeak(sk, ctx?.agentId, senderName, shared.epoch);
          persistReplyTarget(sk);
          return;
        }
        if (shared.decision === "stay_silent") {
          return markStaySilent(sk, senderName, prompt, shared.epoch, "decide-dedup");
        }
        if (shared.engineNull) {
          if (isGroup(sk)) return markStaySilent(sk, senderName, prompt, -1, "group-fail-closed-dedup");
          return;
        }
        return;
      }

      const decidePromise = (async () => {
        if (isGroup(sk)) {
          const ownNames = [cfg.agentName, ...(cfg.agentAliases || [])]
            .map((n) => String(n || "").toLowerCase())
            .filter(Boolean);
          const ctxLines = transcriptLines || [];
          const lastLine = ctxLines[ctxLines.length - 1] || null;
          const ownCount = ctxLines.filter((l) => ownNames.includes(String(l?.speaker || "").toLowerCase())).length;
          const lastSpeaker = lastLine?.speaker || "-";
          const lastAgeMs = lastLine && typeof lastLine.ts === "number" ? Date.now() - lastLine.ts : "-";
          _log.info(`human-engine: decide-ctx sk=${redactSessionKey(sk)} lines=${ctxLines.length} own=${ownCount} lastSpeaker=${lastSpeaker} lastAgeMs=${lastAgeMs}`);
        }
        const engineResult = await engine.decide({
          sessionKey: sk,
          messages,
          systemPrompt: systemPrompt || undefined,
          isDM,
          hasMedia,
          mediaKind,
          prompt,
          agentName: cfg.agentName,
          agentAliases: cfg.agentAliases,
          transcript: transcriptLines,
          persona: decidePersona || undefined,
          voiceCard: null,
          agentContactIds,
          replyToAgent,
        });
        return {
          decision: engineResult?.decision,
          epoch: engineResult?.epoch,
          path: engineResult?.path || (engineResult === null ? "engine-null" : "?"),
          engineNull: engineResult === null,
          reason: engineResult?.decision === "stay_silent" ? "decide" : undefined,
        };
      })();
      if (!isTriggerMsg) {
        decideInflight.set(sk, decidePromise);
        decidePromise.then(
          () => decideInflight.delete(sk),
          () => decideInflight.delete(sk),
        );
      }
      const shared = await decidePromise;
      return applyVerdict(shared);
    } catch (err) {
      _log.warn(`human-engine: before_agent_reply error sk=${redactSessionKey(ctx?.sessionKey)}: ${err?.message || err}`);
      try {
        const sk = ctx?.sessionKey;
        const prompt = typeof event?.cleanedBody === "string" ? event.cleanedBody : "";
        let senderName = "User";
        try {
          senderName = resolveSender(ctx?.senderName, ctx?.senderId, sk ? state.senderBySession.get(sk) : undefined);
        } catch (innerErr) {
          _log.warn(`human-engine: fail-closed resolveSender error sk=${redactSessionKey(sk)}: ${innerErr?.message || innerErr}`);
        }
        if (sk && isGroup(sk) && prompt && !isCommand(prompt)) {
          return markStaySilent(sk, senderName, prompt, -1, "gate-error-fail-closed");
        }
      } catch (innerErr) {
        _log.warn(`human-engine: fail-closed recovery error sk=${redactSessionKey(ctx?.sessionKey)}: ${innerErr?.message || innerErr}`);
      }
      return;
    }
  }

  function onBeforeAgentRun(event, ctx) {
    _log.info(`human-engine: before_agent_run fired sk=${redactSessionKey(ctx?.sessionKey)} agent=${ctx?.agentId}`);
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
        pushPeekDedup(sk, senderName, prompt, Date.now());
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
        result.appendContext = OBSERVED_HEADER + "\n" + wrapUntrusted(observedLines.join("\n"));
        state.observedBySession.delete(sk);
      }

      const mem = state.memoryBySession.get(sk);
      if (mem) {
        result.appendSystemContext = `What you know about the people here (from memory):\n${wrapUntrusted(mem)}`;
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
