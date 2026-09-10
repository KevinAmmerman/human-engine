import { isEnabled, isScopedAgent, resolveAgentConfigForSession } from "./config.js";
import { isChatSession } from "./gate.js";
import { stripMetaCommentary, sanitizeTells } from "./anti-tell.js";
import { loadContacts, listContactNames } from "./contacts.js";
import * as state from "./state.js";
import { capMap, getTranscriptPeek, pushTranscriptPeek } from "./state.js";
import { redactSessionKey } from "./redact.js";
import { isDmSessionKey, agentIdFromSessionKey, channelAndRestFromSessionKey, isGroupSessionKey } from "./scope.js";

export const bubbleTimers = new Map();
const dispatcherQueueBySession = new Map();
const pendingReplyBySession = new Map();
const flushTimerBySession = new Map();

const FLUSH_DEBOUNCE_MS = 1200;
const DISPATCHER_QUEUE_MAX = 8;
const SPEAK_EPOCH_TTL_MS = 300000;

const NO_VISIBLE_REPLY_FALLBACK_TEXT = "No reply was generated for this message. This is usually a temporary model failure - please try again.";
const QUEUE_CAP_REJECTION_TEXT = "This message was not queued because the session queue is full. Please try again after the current response finishes.";
const AGENT_RUN_FAILED_RE = /^⚠️\s*agent run failed\b/i;

// P0 answer-delivery hotfix: mechanical fact-guard backstop. Extracts numeric
// tokens (times like 15:00/15.00, prices like 12,50 €, multi-digit numbers)
// from the draft and checks whether the split bubbles preserved them.
const NUMERIC_TOKEN_RE = /\d{1,2}[:.]\d{2}\b|\b\d{1,3}(?:[.,]\d{2})\s*(?:€|EUR)?\b|\b\d{2,}\b/g;

function extractNumericTokens(text) {
  const matches = String(text || "").match(NUMERIC_TOKEN_RE) || [];
  return [...new Set(matches)];
}

function joinedBubbleText(scheduled) {
  return (scheduled || []).map((b) => b.content || "").join(" ");
}

// Lazy-loaded TTS applier from the OpenClaw plugin SDK. The plugin loader maps
// "openclaw/plugin-sdk/tts-runtime" onto the gateway dist (sdk-alias resolver);
// in unit-test runs (plain node --test) the local node_modules/openclaw shim
// does not export it, the import fails, and we degrade to text-only bubbles.
let ttsApplierPromise = null;
function loadTtsApplier(log) {
  if (!ttsApplierPromise) {
    ttsApplierPromise = import("openclaw/plugin-sdk/tts-runtime")
      .then((m) => (typeof m?.maybeApplyTtsToPayload === "function" ? m.maybeApplyTtsToPayload : null))
      .catch((err) => {
        (log?.warn || (() => {}))(`human-engine: tts-runtime unavailable: ${err?.message || err}`);
        return null;
      });
  }
  return ttsApplierPromise;
}

/**
 * Apply framework TTS to a bubble payload so the group bubble carries text AND
 * the spoken audio in one delivery (HART: never voice-only, never text-only when
 * the session enables TTS). kind:"final" matches the message-action runner so the
 * synthesis runs regardless of the configured tts.mode; the payload keeps its
 * text and gains mediaUrl + audioAsVoice. Any failure degrades to text-only.
 */
async function applyTtsToDraft(payload, ttsCtx, log) {
  if (!ttsCtx || !ttsCtx.ttsAuto || ttsCtx.ttsAuto === "off") return payload;
  const apply = await loadTtsApplier(log);
  if (!apply) return payload;
  try {
    const applied = await apply({
      payload,
      cfg: ttsCtx.cfg || {},
      channel: ttsCtx.channel,
      kind: "final",
      ttsAuto: ttsCtx.ttsAuto,
      agentId: ttsCtx.agentId,
      accountId: ttsCtx.accountId,
    });
    if (applied && (applied.mediaUrl || applied.mediaUrls?.length)) return applied;
    return payload;
  } catch (err) {
    (log?.warn || (() => {}))(`human-engine: bubble TTS apply failed: ${err?.message || err}`);
    return payload;
  }
}

export async function deliverWithRetry(dispatcher, content, ttsCtx, log, replyToId) {
  const payload = await applyTtsToDraft({ text: content }, ttsCtx, log);
  // Plan 035: quote-reply target id rides on the first bubble payload; the text-only retry
  // KEEPS replyToId (a host reject affects media, not the quote target), so the reply still
  // quotes the right message even when media delivery is dropped.
  if (replyToId) {
    payload.replyToId = replyToId;
  }
  let ok;
  try {
    ok = dispatcher.sendBlockReply(payload);
  } catch {
    ok = false;
  }
  if (ok === false) {
    // Host rejected the (possibly media-carrying) payload — retry text-only so the reply is never lost.
    try {
      const retry = { text: content };
      if (replyToId) retry.replyToId = replyToId;
      ok = dispatcher.sendBlockReply(retry);
    } catch {
      ok = false;
    }
  }
  return ok;
}

function buildTtsContext(event, sk, ctx) {
  const ttsAuto = event?.sessionTtsAuto || null;
  if (!ttsAuto || ttsAuto === "off") return null;
  let channel = event?.ttsChannel;
  if (!channel && typeof sk === "string" && sk.startsWith("agent:")) {
    // "agent:<agentId>:<channel>..." → channel id used by the TTS settings resolver
    channel = channelAndRestFromSessionKey(sk) || channel;
  }
  return {
    cfg: ctx?.cfg || {},
    ttsAuto,
    channel,
    agentId: agentIdFromSessionKey(sk) || ctx?.agentId || undefined,
    accountId: event?.originatingAccountId || undefined,
  };
}

function isSystemFallbackText(text) {
  if (typeof text !== "string") return false;
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  const fallback = NO_VISIBLE_REPLY_FALLBACK_TEXT.replace(/\s+/g, " ").trim().toLowerCase();
  const queueCap = QUEUE_CAP_REJECTION_TEXT.replace(/\s+/g, " ").trim().toLowerCase();
  return normalized.includes(fallback) || normalized.includes(queueCap) || AGENT_RUN_FAILED_RE.test(normalized);
}

function capQueue(queue, max) {
  while (queue.length > max) {
    const dropped = queue.shift();
    if (dropped?.dispatcher) {
      try { dropped.dispatcher.markComplete(); } catch {}
    }
  }
}

export function clearAllBubbleTimers() {
  for (const timers of bubbleTimers.values()) {
    for (const t of timers) clearTimeout(t);
  }
  bubbleTimers.clear();
  for (const t of flushTimerBySession.values()) clearTimeout(t);
  flushTimerBySession.clear();
  dispatcherQueueBySession.clear();
  pendingReplyBySession.clear();
}

function readSpeakEpoch(sk) {
  const entry = state.speakEpochBySession.get(sk);
  if (entry == null) return null;
  if (typeof entry === "number") return { epoch: entry, ts: 0 };
  return entry;
}

function speakEpochAge(sk) {
  const entry = readSpeakEpoch(sk);
  if (!entry || typeof entry.ts !== "number" || entry.ts === 0) return null;
  return Date.now() - entry.ts;
}

export function createNaturalize({ cfg, engine, persona, socialMemory, observedStore, mood, selfVoice, log }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const speakEpochTtlMs = cfg?.naturalize?.speakEpochTtlMs ?? SPEAK_EPOCH_TTL_MS;

  function persistOwnReply(sk, text, agentName) {
    if (!observedStore?.appendObserved) return;
    try {
      // Same speaker + capped text as the peek line, so mergeTranscriptLayers tail-dedups the pair without special casing.
      observedStore.appendObserved(sk, {
        speaker: agentName || "Agent",
        text: String(text).slice(0, 300),
        ts: Date.now(),
      });
    } catch {}
  }

  function onReplyDispatch(event, ctx) {
    // reply_dispatch ctx has no agentId/sessionKey (hook-types d.ts:594-604, dispatch-DXwxohlw.js:1513-1520);
    // sessionKey travels on the EVENT; agentId is derivable from scoped keys "agent:<agentId>:...".
    const sk = event?.sessionKey || ctx?.sessionKey;
    const agentId = ctx?.agentId || agentIdFromSessionKey(sk);
    _log.info(`human-engine: reply_dispatch fired sk=${redactSessionKey(sk)} sendPolicy=${event?.sendPolicy}`);
    try {
      if (!isEnabled(cfg)) return;
      if (!isScopedAgent(cfg, agentId)) return;
      if (!sk) return;
      if (!isChatSession(sk)) return;
      // Kevin-Wunsch (Plan 587): DM-Antworten als EINE normale Nachricht —
      // keine Bubble-Aufteilung, kein Tipp-Timing in Direktchats.
      if (cfg?.naturalize?.disableDM === true && isDmSessionKey(sk)) return;
      if (event?.sendPolicy !== "allow") return;

      // FIFO dispatcher stash (plan 545): each armed dispatcher is pushed onto a
      // per-session queue and stays alive until its bound draft delivers or a
      // silence cleans it up. We do NOT eagerly complete a previous dispatcher on
      // re-arm — a later message's silence must not kill a still-pending reply's
      // route. epoch is null here and bound at capture time (reply_dispatch fires
      // before the speak epoch is stashed by the gate). Unconsumed entries are
      // cleaned up by onSilence, not by displacement.
      const queue = dispatcherQueueBySession.get(sk) || [];
      queue.push({
        dispatcher: ctx.dispatcher || null,
        abortSignal: ctx.abortSignal || null,
        epoch: null,            // bound at capture time
        armedAt: Date.now(),
        consumed: false,
        tts: buildTtsContext(event, sk, ctx),
      });
      dispatcherQueueBySession.set(sk, queue);
      capQueue(queue, DISPATCHER_QUEUE_MAX);
      _log.info(`human-engine: dispatch armed sk=${redactSessionKey(sk)} hasDispatcher=${Boolean(ctx.dispatcher)} queued=${queue.length}`);
      return;
    } catch {
      return;
    }
  }

  function onReplyPayloadSending(event, ctx) {
    try {
      if (!isEnabled(cfg)) return;
      const sk = event?.sessionKey || ctx?.sessionKey;
      const agentId = ctx?.agentId || agentIdFromSessionKey(sk);
      if (!isScopedAgent(cfg, agentId)) return;
      if (!sk) return;
      if (!isChatSession(sk)) return;

      const entry = readSpeakEpoch(sk);
      if (!entry) return;

      const kind = event?.kind;
      if (kind && kind !== "final" && kind !== "text") return;

      const text = event?.payload?.text;
      if (typeof text !== "string" || !text.trim()) return;
      if (text.trim() === "NO_REPLY") return;

      if (isSystemFallbackText(text)) {
        _log.info(`human-engine: suppressed system fallback payload sk=${redactSessionKey(sk)} len=${text.length}`);
        return { cancel: true };
      }

      const agentCfg = resolveAgentConfigForSession(cfg, sk, agentId);
      const agentName = agentCfg.agentName || "Agent";
      pushTranscriptPeek(sk, "[" + agentName + "] " + text.slice(0, 300), undefined, Date.now());
      persistOwnReply(sk, text, agentName);
      try {
        selfVoice?.onOwnReply?.(agentIdFromSessionKey(sk), sk);
      } catch {}

      const age = speakEpochAge(sk);
      if (age != null && age > speakEpochTtlMs) {
        state.speakEpochBySession.delete(sk);
        _log.info(`human-engine: stale speakEpoch expired sk=${redactSessionKey(sk)} age=${age}ms (payload passes through)`);
        return;
      }

      const queue = dispatcherQueueBySession.get(sk) || [];
      let dstate = queue.find((q) => !q.consumed && q.dispatcher);
      if (!dstate && pendingReplyBySession.has(sk)) {
        // A draft is already being assembled for this session — accumulate onto the
        // active (consumed) dispatcher so multi-part payloads merge into one draft.
        dstate = queue.find((q) => q.consumed && q.dispatcher);
      }
      if (!dstate) {
        _log.info(`human-engine: no unconsumed dispatcher stashed sk=${redactSessionKey(sk)} (payload passes through)`);
        return;
      }

      if (dstate.epoch == null) {
        dstate.epoch = entry.epoch; // bind at capture to the epoch that authorized this capture
      }
      dstate.consumed = true;

      if (!pendingReplyBySession.has(sk)) {
        pendingReplyBySession.set(sk, []);
      }
      pendingReplyBySession.get(sk).push(text);
      capMap(pendingReplyBySession, 4096);
      scheduleFlush(sk);
      _log.info(`human-engine: captured reply payload sk=${redactSessionKey(sk)} len=${text.length} parts=${pendingReplyBySession.get(sk).length}`);
      return { cancel: true };
    } catch {
      return;
    }
  }

  function scheduleFlush(sk) {
    const existing = flushTimerBySession.get(sk);
    if (existing) clearTimeout(existing);
    const flushTimer = setTimeout(() => {
      flushTimerBySession.delete(sk);
      flush(sk).catch((err) => {
        _log.warn(`human-engine: flush error sk=${redactSessionKey(sk)}: ${err?.message || err}`);
      });
    }, FLUSH_DEBOUNCE_MS);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
    flushTimerBySession.set(sk, flushTimer);
  }

  async function flush(sk) {
    const parts = pendingReplyBySession.get(sk) || [];
    pendingReplyBySession.delete(sk);
    if (parts.length === 0) return;

    const entry = readSpeakEpoch(sk);
    state.speakEpochBySession.delete(sk);
    const queue = dispatcherQueueBySession.get(sk) || [];
    const dstate = queue.find((q) => q.consumed && q.dispatcher);
    if (!dstate) {
      _log.info(`human-engine: flush skipped sk=${redactSessionKey(sk)} (no consumed dispatcher; original payload already flowing)`);
      return;
    }
    queue.splice(queue.indexOf(dstate), 1);
    if (queue.length === 0) {
      dispatcherQueueBySession.delete(sk);
    } else {
      dispatcherQueueBySession.set(sk, queue);
    }

    const draft = parts.join("\n").trim();
    if (!draft) return;

    const agentCfg = resolveAgentConfigForSession(cfg, sk, agentIdFromSessionKey(sk));
    const agentName = agentCfg.agentName || "Agent";
    const memberNames = listContactNames(loadContacts(agentCfg.contactsPath || ""));
    const cleaned = stripMetaCommentary(draft, memberNames);
    if (cleaned.stripped) {
      _log.warn(`human-engine: meta-commentary stripped sk=${redactSessionKey(sk)} before=${draft.length} after=${cleaned.text.length}`);
    }
    let finalDraft = cleaned.text;

    const dispatcher = dstate.dispatcher;

    if (socialMemory && cfg.socialMemory?.enabled !== false && isChatSession(sk)) {
      const agentId = agentIdFromSessionKey(sk) || "?";
      const scope = agentId + "::" + sk;
      socialMemory.ingest(scope, { speaker: agentName, text: draft, ts: Date.now() });
    }

    const systemPrompt = persona?.buildPersonaPromptWithMemory?.(agentCfg, state, sk, agentIdFromSessionKey(sk)) || null;
    const isGroup = isGroupSessionKey(sk) || state.chatTypeBySession.get(sk) === "group";
    const ttsCtx = isGroup ? (dstate.tts || null) : null;

    const target = state.replyTargetBySession.get(sk) || null;
    state.replyTargetBySession.delete(sk);
    let replyTarget = null;
    if (target && (target.replyToAgent || target.quotedName) && Date.now() - target.ts <= 300000) {
      replyTarget = target;
    }

    const strongOnly = (cleaned.strong ?? 0) >= 1;
    if (cleaned.commentary && !cleaned.stripped && (strongOnly || finalDraft.length > 40) && engine?.regenerateReply) {
      const regen = await engine.regenerateReply({
        sessionKey: sk,
        reasoning: draft,
        transcript: getTranscriptPeek(sk, 10),
        systemPrompt,
        agentName,
        language: agentCfg.language,
      });
      if (regen?.text) {
        finalDraft = regen.text;
        _log.warn(`human-engine: regenerated reply after pure-commentary sk=${redactSessionKey(sk)}`);
      } else {
        _log.warn(`human-engine: REPLY SUPPRESSED sk=${redactSessionKey(sk)} (pure commentary, regeneration failed)`);
        return; // do NOT deliver commentary
      }
    }

    const san = sanitizeTells(finalDraft);
    if (san.tells.length > 0) _log.warn(`human-engine: tells-sanitized sk=${redactSessionKey(sk)} kinds=${san.tells.join(",")}`);
    finalDraft = san.text;

    let respondResult;
    if (engine) {
      const peek = getTranscriptPeek(sk, 10);
      const lastLine = peek[peek.length - 1] || null;
      const speakPath = state.speakPathBySession.get(sk) || null;
      const triggerInfo = {
        replyTarget: replyTarget ?? null,
        newestAgeMs: lastLine && typeof lastLine.ts === "number" ? Date.now() - lastLine.ts : null,
        triggerLen: typeof finalDraft.length === "number" ? finalDraft.length : null,
        wasAddressed: speakPath === "dm" || speakPath === "reply" || speakPath === "hard",
        moodEnergy: (isGroup && mood?.snapshotFor ? mood.snapshotFor(agentIdFromSessionKey(sk) || null, sk)?.energy ?? null : null),
      };
      respondResult = await engine.respond({
        sessionKey: sk,
        draft: finalDraft,
        epoch: dstate.epoch,
        systemPrompt,
        agentName,
        transcript: peek,
        persona: systemPrompt,
        voiceCard: null,
        isGroup,
        replyTarget,
        triggerInfo,
        language: agentCfg.language,
      });
    }

    if (!respondResult || respondResult.superseded) {
      deliverRaw(sk, dispatcher, finalDraft, dstate, ttsCtx, replyTarget);
      return;
    }

    const scheduled = (respondResult.scheduled || [])
      .map((bubble) => {
        const b = sanitizeTells(bubble.content);
        if (b.tells.length > 0) _log.warn(`human-engine: tells-sanitized bubble kinds=${b.tells.join(",")}`);
        bubble.content = b.text;
        return bubble;
      })
      .filter((bubble) => (bubble.content || "").trim().length > 0);
    _log.info(`human-engine: respond sk=${redactSessionKey(sk)} superseded=false bubbles=${scheduled.length} delays=${(scheduled || []).map(b => b.delayMs).join(",")}`);
    if (scheduled.length === 0) {
      await deliverRaw(sk, dispatcher, finalDraft, dstate, ttsCtx, replyTarget);
      return;
    }

    // P0 answer-delivery hotfix: mechanical fact-guard backstop. If the split
    // dropped more than half of the draft's numeric facts, the answer would be
    // lost — deliver the raw draft as one bubble instead. Draft-only (the
    // transcript is never consulted), and skipped on the raw-fallback path
    // (respond returned null/superseded — no bubbles to check).
    {
      const draftTokens = extractNumericTokens(finalDraft);
      if (draftTokens.length >= 2) {
        const bubbleText = joinedBubbleText(scheduled);
        const missing = draftTokens.filter((t) => !bubbleText.includes(t));
        if (missing.length > draftTokens.length / 2) {
          _log.warn(`human-engine: fact-guard fallback sk=${redactSessionKey(sk)} (${missing.length}/${draftTokens.length} facts missing from bubbles)`);
          await deliverRaw(sk, dispatcher, finalDraft, dstate, ttsCtx, replyTarget);
          return;
        }
      }
    }

    cancelSessionTimers(sk);

    const timers = [];
    const abortController = new AbortController();

    if (dstate.abortSignal) {
      dstate.abortSignal.addEventListener("abort", () => {
        abortController.abort();
        cancelSessionTimers(sk);
        try { dispatcher.markComplete(); } catch {}
      }, { once: true });
    }

    for (let i = 0; i < scheduled.length; i++) {
      const bubble = scheduled[i];
      const timer = setTimeout(() => {
        void (async () => {
          if (abortController.signal.aborted) return;
          const currentEp = engine ? engine.currentEpoch(sk) : 0;
          if (currentEp > dstate.epoch) {
            cancelSessionTimers(sk);
            try { dispatcher.markComplete(); } catch {}
            return;
          }
          // Plan 035: the quote-reply target (replyToId) attaches to the FIRST bubble only;
          // later bubbles carry no quote (the reply is anchored to the first delivery).
          const bubbleReplyToId = i === 0 && replyTarget && replyTarget.replyToId ? replyTarget.replyToId : undefined;
          const ok = await deliverWithRetry(dispatcher, bubble.content, ttsCtx, _log, bubbleReplyToId);
          if (ok === false) {
            _log.warn(`human-engine: BUBBLE LOST sk=${redactSessionKey(sk)} part=${i + 1}/${scheduled.length} — host aborted delivery`);
          } else {
            _log.info(`human-engine: bubble ${i + 1}/${scheduled.length} sk=${redactSessionKey(sk)} sendBlockReply=${ok} len=${(bubble.content || "").length}`);
          }
          if (i === scheduled.length - 1) {
            cancelSessionTimers(sk);
            try { dispatcher.markComplete(); _log.info(`human-engine: markComplete sk=${redactSessionKey(sk)}`); } catch {}
          }
        })();
      }, bubble.delayMs);
      if (typeof timer.unref === "function") timer.unref();
      timers.push(timer);
    }

    bubbleTimers.set(sk, timers);
  }

  async function deliverRaw(sk, dispatcher, draft, dstate, ttsCtx, replyTarget) {
    // Plan 035: a single raw fallback IS the first/only delivery, so the quote-reply target
    // (replyToId) rides on it too — the reply is never sent without its quote anchor.
    const replyToId = replyTarget && replyTarget.replyToId ? replyTarget.replyToId : undefined;
    const ok = await deliverWithRetry(dispatcher, draft, ttsCtx || null, _log, replyToId);
    if (ok === false) {
      _log.warn(`human-engine: RAW REPLY LOST sk=${redactSessionKey(sk)} — host aborted delivery`);
    } else {
      _log.info(`human-engine: raw fallback delivery sk=${redactSessionKey(sk)} sendBlockReply=${ok} len=${draft.length}`);
    }
    try { dispatcher.markComplete(); } catch {}
  }

  function cancelSessionTimers(sk) {
    const existing = bubbleTimers.get(sk);
    if (existing) {
      for (const t of existing) clearTimeout(t);
      bubbleTimers.delete(sk);
    }
  }

  function onSilence(sk) {
    const queue = dispatcherQueueBySession.get(sk);
    if (!queue || queue.length === 0) return;
    const kept = queue.filter((q) => {
      if (q.consumed) return true;        // draft already bound & in flight — leave alone
      if (q.dispatcher) {
        try { q.dispatcher.markComplete(); } catch {}
        _log.info(`human-engine: silence completed unconsumed dispatcher sk=${redactSessionKey(sk)} armedAt=${q.armedAt}`);
      }
      return false;
    });
    if (kept.length === 0) {
      dispatcherQueueBySession.delete(sk);
    } else {
      dispatcherQueueBySession.set(sk, kept);
    }
  }

  return { onReplyDispatch, onReplyPayloadSending, onSilence };
}
