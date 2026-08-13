import { isEnabled, isScopedAgent } from "./config.js";
import { isChatSession } from "./gate.js";
import * as state from "./state.js";
import { capMap, getTranscriptPeek, pushTranscriptPeek } from "./state.js";

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

export function createNaturalize({ cfg, state: st, engine, persona, socialMemory, log }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const speakEpochTtlMs = cfg?.naturalize?.speakEpochTtlMs ?? SPEAK_EPOCH_TTL_MS;

  function onReplyDispatch(event, ctx) {
    // reply_dispatch ctx has no agentId/sessionKey (hook-types d.ts:594-604, dispatch-DXwxohlw.js:1513-1520);
    // sessionKey travels on the EVENT; agentId is derivable from scoped keys "agent:<agentId>:...".
    const sk = event?.sessionKey || ctx?.sessionKey;
    const agentId = ctx?.agentId || scopeFromSessionKey(sk);
    _log.info(`human-engine: reply_dispatch fired sk=${sk} sendPolicy=${event?.sendPolicy}`);
    try {
      if (!isEnabled(cfg)) return;
      if (!isScopedAgent(cfg, agentId)) return;
      if (!sk) return;
      if (!isChatSession(sk)) return;
      if (event?.sendPolicy !== "allow") return;

      const entry = readSpeakEpoch(sk);
      if (!entry) return;
      const age = speakEpochAge(sk);
      if (age != null && age > speakEpochTtlMs) {
        state.speakEpochBySession.delete(sk);
        _log.info(`human-engine: stale speakEpoch expired sk=${sk} age=${age}ms (reply passes through)`);
        return;
      }

      dispatcherBySession.set(sk, {
        dispatcher: ctx.dispatcher || null,
        abortSignal: ctx.abortSignal || null,
        epoch: entry.epoch,
      });
      capMap(dispatcherBySession, 4096);
      _log.info(`human-engine: dispatch armed sk=${sk} epoch=${entry.epoch} hasDispatcher=${Boolean(ctx.dispatcher)}`);
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

      const age = speakEpochAge(sk);
      if (age != null && age > speakEpochTtlMs) {
        state.speakEpochBySession.delete(sk);
        _log.info(`human-engine: stale speakEpoch expired sk=${sk} age=${age}ms (payload passes through)`);
        return;
      }

      const dstate = dispatcherBySession.get(sk);
      if (!dstate || !dstate.dispatcher) {
        _log.info(`human-engine: no dispatcher stashed sk=${sk} (payload passes through)`);
        return;
      }

      if (!pendingReplyBySession.has(sk)) {
        pendingReplyBySession.set(sk, []);
      }
      pendingReplyBySession.get(sk).push(text);
      capMap(pendingReplyBySession, 4096);
      scheduleFlush(sk);
      _log.info(`human-engine: captured reply payload sk=${sk} len=${text.length} parts=${pendingReplyBySession.get(sk).length}`);
      return { cancel: true };
    } catch {
      return;
    }
  }

  function scheduleFlush(sk) {
    const existing = flushTimerBySession.get(sk);
    if (existing) clearTimeout(existing);
    flushTimerBySession.set(sk, setTimeout(() => {
      flushTimerBySession.delete(sk);
      flush(sk).catch((err) => {
        _log.warn(`human-engine: flush error sk=${sk}: ${err?.message || err}`);
      });
    }, FLUSH_DEBOUNCE_MS));
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
      _log.info(`human-engine: flush skipped sk=${sk} (no dispatcher; original payload already flowing)`);
      return;
    }

    const draft = parts.join("\n").trim();
    if (!draft) return;

    const dispatcher = dstate.dispatcher;

    if (socialMemory && cfg.socialMemory?.enabled !== false && isChatSession(sk)) {
      const agentId = sk.startsWith("agent:") ? sk.split(":")[1] : "?";
      const scope = agentId + "::" + sk;
      socialMemory.ingest(scope, { speaker: cfg.agentName || "Agent", text: draft, ts: Date.now() });
    }

    const systemPrompt = persona?.buildPersonaPromptWithMemory?.(cfg, state, sk) || null;
    const isGroup = (typeof sk === "string" && sk.includes(":group:")) || state.chatTypeBySession.get(sk) === "group";

    let respondResult;
    if (engine) {
      respondResult = await engine.respond({
        sessionKey: sk,
        draft,
        epoch: dstate.epoch,
        systemPrompt,
        agentName: cfg.agentName,
        transcript: getTranscriptPeek(sk, 10),
        persona: systemPrompt,
        voiceCard: null,
        isGroup,
      });
    }

    if (!respondResult || respondResult.superseded) {
      deliverRaw(sk, dispatcher, draft, dstate);
      return;
    }

    const scheduled = respondResult.scheduled;
    _log.info(`human-engine: respond sk=${sk} superseded=false bubbles=${scheduled?.length ?? 0} delays=${(scheduled || []).map(b => b.delayMs).join(",")}`);
    if (!scheduled || scheduled.length === 0) {
      deliverRaw(sk, dispatcher, draft, dstate);
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
          _log.warn(`human-engine: BUBBLE LOST sk=${sk} part=${i + 1}/${scheduled.length} — host aborted delivery`);
        } else {
          _log.info(`human-engine: bubble ${i + 1}/${scheduled.length} sk=${sk} sendBlockReply=${ok} len=${(bubble.content || "").length}`);
        }
        if (i === scheduled.length - 1) {
          cancelSessionTimers(sk);
          try { dispatcher.markComplete(); _log.info(`human-engine: markComplete sk=${sk}`); } catch {}
        }
      }, bubble.delayMs);
      timers.push(timer);
    }

    bubbleTimers.set(sk, timers);
  }

  function deliverRaw(sk, dispatcher, draft, dstate) {
    const ok = deliverWithRetry(dispatcher, draft);
    if (ok === false) {
      _log.warn(`human-engine: RAW REPLY LOST sk=${sk} — host aborted delivery`);
    } else {
      _log.info(`human-engine: raw fallback delivery sk=${sk} sendBlockReply=${ok} len=${draft.length}`);
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
