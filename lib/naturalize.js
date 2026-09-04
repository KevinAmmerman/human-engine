import { isEnabled, isScopedAgent } from "./config.js";
import { isChatSession } from "./gate.js";
import { stripMetaCommentary } from "./anti-tell.js";
import { loadContacts, listContactNames } from "./contacts.js";
import * as state from "./state.js";
import { capMap, getTranscriptPeek, pushTranscriptPeek } from "./state.js";
import { redactSessionKey } from "./redact.js";

export const bubbleTimers = new Map();
const dispatcherBySession = new Map();
const pendingReplyBySession = new Map();
const flushTimerBySession = new Map();

const FLUSH_DEBOUNCE_MS = 1200;
const SPEAK_EPOCH_TTL_MS = 300000;

function scopeFromSessionKey(sk) {
  if (typeof sk !== "string" || !sk.startsWith("agent:")) return null;
  return sk.split(":")[1] || null;
}

function deliverWithRetry(dispatcher, content) {
  let ok;
  try {
    ok = dispatcher.sendBlockReply({ text: content });
  } catch {
    ok = false;
  }
  if (ok === false) {
    try {
      ok = dispatcher.sendBlockReply({ text: content });
    } catch {
      ok = false;
    }
  }
  return ok;
}

export function clearAllBubbleTimers() {
  for (const timers of bubbleTimers.values()) {
    for (const t of timers) clearTimeout(t);
  }
  bubbleTimers.clear();
  for (const t of flushTimerBySession.values()) clearTimeout(t);
  flushTimerBySession.clear();
  dispatcherBySession.clear();
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

export function createNaturalize({ cfg, engine, persona, socialMemory, observedStore, log }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const speakEpochTtlMs = cfg?.naturalize?.speakEpochTtlMs ?? SPEAK_EPOCH_TTL_MS;

  function persistOwnReply(sk, text) {
    if (!observedStore?.appendObserved) return;
    try {
      // Same speaker + capped text as the peek line, so mergeTranscriptLayers tail-dedups the pair without special casing.
      observedStore.appendObserved(sk, {
        speaker: cfg.agentName || "Agent",
        text: String(text).slice(0, 300),
        ts: Date.now(),
      });
    } catch {}
  }

  function onReplyDispatch(event, ctx) {
    // reply_dispatch ctx has no agentId/sessionKey (hook-types d.ts:594-604, dispatch-DXwxohlw.js:1513-1520);
    // sessionKey travels on the EVENT; agentId is derivable from scoped keys "agent:<agentId>:...".
    const sk = event?.sessionKey || ctx?.sessionKey;
    const agentId = ctx?.agentId || scopeFromSessionKey(sk);
    _log.info(`human-engine: reply_dispatch fired sk=${redactSessionKey(sk)} sendPolicy=${event?.sendPolicy}`);
    try {
      if (!isEnabled(cfg)) return;
      if (!isScopedAgent(cfg, agentId)) return;
      if (!sk) return;
      if (!isChatSession(sk)) return;
      if (event?.sendPolicy !== "allow") return;

      // Stash hygiene: armed-but-never-captured entries (silenced turns that arm
      // then emit NO_REPLY, or dispatch-only hooks) must not linger. Overwrite per
      // turn via `set` on every dispatch plus the delete in flush() is sufficient.
      // A dispatcher displaced by a re-arm is completed at that point, so the host
      // does not hold orphaned dispatcher resources until timeout. epoch is null
      // here and bound at capture time (reply_dispatch fires before the speak epoch
      // is stashed by the gate).
      const prev = dispatcherBySession.get(sk);
      if (prev?.dispatcher) {
        try { prev.dispatcher.markComplete(); } catch {}
        _log.info(`human-engine: displaced dispatcher completed sk=${redactSessionKey(sk)} armedAt=${prev.armedAt}`);
      }
      dispatcherBySession.set(sk, {
        dispatcher: ctx.dispatcher || null,
        abortSignal: ctx.abortSignal || null,
        epoch: null,            // bound at capture time
        armedAt: Date.now(),
      });
      capMap(dispatcherBySession, 4096);
      _log.info(`human-engine: dispatch armed sk=${redactSessionKey(sk)} hasDispatcher=${Boolean(ctx.dispatcher)}`);
      return;
    } catch {
      return;
    }
  }

  function onReplyPayloadSending(event, ctx) {
    try {
      if (!isEnabled(cfg)) return;
      const sk = event?.sessionKey || ctx?.sessionKey;
      const agentId = ctx?.agentId || scopeFromSessionKey(sk);
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

      pushTranscriptPeek(sk, "[" + (cfg.agentName || "Agent") + "] " + text.slice(0, 300));
      persistOwnReply(sk, text);

      const age = speakEpochAge(sk);
      if (age != null && age > speakEpochTtlMs) {
        state.speakEpochBySession.delete(sk);
        _log.info(`human-engine: stale speakEpoch expired sk=${redactSessionKey(sk)} age=${age}ms (payload passes through)`);
        return;
      }

      const dstate = dispatcherBySession.get(sk);
      if (!dstate || !dstate.dispatcher) {
        _log.info(`human-engine: no dispatcher stashed sk=${redactSessionKey(sk)} (payload passes through)`);
        return;
      }

      if (dstate.epoch == null) {
        dstate.epoch = entry.epoch; // bind at capture to the epoch that authorized this capture
      }

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
    const dstate = dispatcherBySession.get(sk);
    dispatcherBySession.delete(sk);
    if (!dstate || !dstate.dispatcher) {
      _log.info(`human-engine: flush skipped sk=${redactSessionKey(sk)} (no dispatcher; original payload already flowing)`);
      return;
    }

    const draft = parts.join("\n").trim();
    if (!draft) return;

    const memberNames = listContactNames(loadContacts(cfg.contactsPath));
    const cleaned = stripMetaCommentary(draft, memberNames);
    if (cleaned.stripped) {
      _log.warn(`human-engine: meta-commentary stripped sk=${redactSessionKey(sk)} before=${draft.length} after=${cleaned.text.length}`);
    }
    let finalDraft = cleaned.text;

    const dispatcher = dstate.dispatcher;

    if (socialMemory && cfg.socialMemory?.enabled !== false && isChatSession(sk)) {
      const agentId = sk.startsWith("agent:") ? sk.split(":")[1] : "?";
      const scope = agentId + "::" + sk;
      socialMemory.ingest(scope, { speaker: cfg.agentName || "Agent", text: draft, ts: Date.now() });
    }

    const systemPrompt = persona?.buildPersonaPromptWithMemory?.(cfg, state, sk) || null;
    const isGroup = (typeof sk === "string" && sk.includes(":group:")) || state.chatTypeBySession.get(sk) === "group";

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
        agentName: cfg.agentName,
      });
      if (regen?.text) {
        finalDraft = regen.text;
        _log.warn(`human-engine: regenerated reply after pure-commentary sk=${redactSessionKey(sk)}`);
      } else {
        _log.warn(`human-engine: REPLY SUPPRESSED sk=${redactSessionKey(sk)} (pure commentary, regeneration failed)`);
        return; // do NOT deliver commentary
      }
    }

    let respondResult;
    if (engine) {
      const peek = getTranscriptPeek(sk, 10);
      const lastLine = peek[peek.length - 1] || null;
      const triggerInfo = {
        replyTarget: replyTarget ?? null,
        newestAgeMs: lastLine && typeof lastLine.ts === "number" ? Date.now() - lastLine.ts : null,
        triggerLen: typeof finalDraft.length === "number" ? finalDraft.length : null,
      };
      respondResult = await engine.respond({
        sessionKey: sk,
        draft: finalDraft,
        epoch: dstate.epoch,
        systemPrompt,
        agentName: cfg.agentName,
        transcript: peek,
        persona: systemPrompt,
        voiceCard: null,
        isGroup,
        replyTarget,
        triggerInfo,
      });
    }

    if (!respondResult || respondResult.superseded) {
      deliverRaw(sk, dispatcher, finalDraft, dstate);
      return;
    }

    const scheduled = respondResult.scheduled;
    _log.info(`human-engine: respond sk=${redactSessionKey(sk)} superseded=false bubbles=${scheduled?.length ?? 0} delays=${(scheduled || []).map(b => b.delayMs).join(",")}`);
    if (!scheduled || scheduled.length === 0) {
      deliverRaw(sk, dispatcher, finalDraft, dstate);
      return;
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
        if (abortController.signal.aborted) return;
        const currentEp = engine ? engine.currentEpoch(sk) : 0;
        if (currentEp > dstate.epoch) {
          cancelSessionTimers(sk);
          try { dispatcher.markComplete(); } catch {}
          return;
        }
        const ok = deliverWithRetry(dispatcher, bubble.content);
        if (ok === false) {
          _log.warn(`human-engine: BUBBLE LOST sk=${redactSessionKey(sk)} part=${i + 1}/${scheduled.length} — host aborted delivery`);
        } else {
          _log.info(`human-engine: bubble ${i + 1}/${scheduled.length} sk=${redactSessionKey(sk)} sendBlockReply=${ok} len=${(bubble.content || "").length}`);
        }
        if (i === scheduled.length - 1) {
          cancelSessionTimers(sk);
          try { dispatcher.markComplete(); _log.info(`human-engine: markComplete sk=${redactSessionKey(sk)}`); } catch {}
        }
      }, bubble.delayMs);
      if (typeof timer.unref === "function") timer.unref();
      timers.push(timer);
    }

    bubbleTimers.set(sk, timers);
  }

  function deliverRaw(sk, dispatcher, draft, dstate) {
    const ok = deliverWithRetry(dispatcher, draft);
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

  return { onReplyDispatch, onReplyPayloadSending };
}
