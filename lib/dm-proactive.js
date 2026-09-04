import fs from "node:fs";
import path from "node:path";
import { localDayKey, overlapCount, agentIdFromSessionKey, capObject } from "./proactive.js";
import { evaluateDmGate, parseFollowupEnvelope, candidateFromEnvelope, isCare } from "./dm-gate-core.js";
import { dayFitFactor } from "./dayfit.js";
import { buildDmRenderPrompt } from "./local-prompts.js";
import { buildPersonaPrompt } from "./persona.js";
import { getTranscriptPeek } from "./state.js";
import { isScopedAgent } from "./config.js";
import { redactSessionKey } from "./redact.js";

/*
 * Plan 530 / design-dm-proactive-v2 §2.1: dm-proactive is the GATE +
 * RENDERER for followup candidates; hori-wa (followup-cron) is the producer.
 * Candidates arrive as outbound sends whose FIRST line is a `[[fu:{…}]]`
 * envelope (see lib/dm-gate-core.js for the contract). The v1 commitments-
 * store reconciliation is gone (dead since 2026.8.1 — the store reader
 * always returned []). Normal agent text without an envelope is never
 * touched (fail-open, parity #24).
 *
 * SHADOW-V2: `dmProactive.shadow` stays `true` initially. Shadow = gating
 * runs, the cron send itself delivers (envelope stripped via {content}),
 * everything (candidate + gate verdicts + render preview) is logged, and
 * the hook NEVER cancels. Live (`shadow:false`): gate-pass → cancel + own
 * send of the rendered draft via runtime.subagent.run with idempotencyKey;
 * gate-fail or duplicate id → cancel + log (in v2 there is no dist
 * fallback — gate-fail suppresses). sentIds (bounded LRU) in the plugin
 * state gives idempotency across cron retries.
 *
 * ACTIVATION CHECKLIST (operator, before `shadow:false` — design §2.4):
 *  - 7-day shadow log with ≥ 20 delivered candidates (gate-pass deliveries).
 *  - ≥ 80 % answered by Kevin (reply ≤ 48 h).
 *  - 0 gate violations (no despite-fail delivery, no duplicate send).
 *  - Render previews feel human on a 10-item sample.
 *
 * Gate rules live in lib/dm-gate-core.js (ONE implementation, shared with
 * bin/followup-gate.mjs): budget, min-gap, quiet-hours (23-07 hard, deadline
 * exception < 2 h), care anti-annoyance (max 1/day, hard 48 h no-reply
 * rule), double-text, duplicate sentId.
 */

const LOG_ROTATE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 256;
const DM_CHANNEL_RE = /:(whatsapp|telegram|discord|signal|slack|matrix):/;

function isDmSession(sk) {
  if (typeof sk !== "string") return false;
  if (sk.includes(":heartbeat")) return false;
  if (sk.includes(":group:")) return false;
  return DM_CHANNEL_RE.test(sk);
}

function scopeKey(agentId, sk) {
  return (agentId || "?") + "::" + sk;
}

export function createDmProactive({ cfg, llm, socialMemory, runtime, stateDir, log, now, activityFilePath }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const _now = typeof now === "function" ? now : () => Date.now();
  const dcfg = cfg?.dmProactive || {};
  const agentName = cfg?.agentName || "Agent";
  const stateFile = path.join(stateDir || ".", "dm-proactive-state.json");
  const logFile = path.join(stateDir || ".", "dm-proactive.jsonl");
  const _activityFilePath = activityFilePath || null;
  const dayFitCache = { mtimeMs: 0, value: null };

  // scope -> { day, count, careCount, lastSentAt, lastCareSentAt, lastReplyAtMs }
  const budget = {};
  const BUDGET_FLUSH_MS = 2000;
  const SENT_IDS_MAX = 512;
  let budgetDirty = false;
  let budgetTimer = null;
  // sentIds (Plan 530, design §2.1): bounded LRU of delivered followup
  // envelope ids — a cron retry with the same id is a duplicate.
  const sentIds = [];
  const sentIdSet = new Set();

  function loadBudget() {
    try {
      const raw = fs.readFileSync(stateFile, "utf8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object" && data.scopes) {
        Object.assign(budget, data.scopes);
      }
      // v1 state (only `scopes`) loads unchanged; sentIds is additive.
      if (data && typeof data === "object" && Array.isArray(data.sentIds)) {
        for (const id of data.sentIds) {
          if (typeof id !== "string" || sentIdSet.has(id)) continue;
          sentIdSet.add(id);
          sentIds.push(id);
        }
        while (sentIds.length > SENT_IDS_MAX) {
          sentIdSet.delete(sentIds.shift());
        }
      }
    } catch {}
  }

  function saveBudget() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      const tmp = stateFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ scopes: budget, sentIds }), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, stateFile);
    } catch (err) {
      _log.warn(`human-engine: dm-proactive: save error: ${err?.message || err}`);
    }
  }

  function hasSentId(id) {
    return sentIdSet.has(id);
  }

  function recordSentId(id) {
    if (typeof id !== "string" || !id) return;
    if (sentIdSet.has(id)) {
      const i = sentIds.indexOf(id);
      if (i >= 0) sentIds.splice(i, 1);
    } else {
      sentIdSet.add(id);
    }
    sentIds.push(id);
    while (sentIds.length > SENT_IDS_MAX) {
      sentIdSet.delete(sentIds.shift());
    }
    markBudgetDirty();
  }

  function markBudgetDirty() {
    budgetDirty = true;
    if (budgetTimer) return;
    const t = setTimeout(() => {
      budgetTimer = null;
      flushBudget();
    }, BUDGET_FLUSH_MS);
    if (typeof t.unref === "function") t.unref();
    budgetTimer = t;
  }

  function flushBudget() {
    if (!budgetDirty) return;
    budgetDirty = false;
    if (budgetTimer) {
      clearTimeout(budgetTimer);
      budgetTimer = null;
    }
    saveBudget();
  }

  function appendLog(entry) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
      try {
        const st = fs.statSync(logFile);
        if (st.size > LOG_ROTATE_BYTES) {
          fs.renameSync(logFile, logFile + ".old");
        }
      } catch {}
      fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch (err) {
      _log.warn(`human-engine: dm-proactive: log append error: ${err?.message || err}`);
    }
  }

  function getBudget(scope) {
    const today = localDayKey(_now());
    const b = budget[scope];
    if (!b || b.day !== today) {
      // lastCareSentAt/lastReplyAtMs are "since" markers for the hard 48h care
      // rule and survive day rollover; daily counters reset.
      return { day: today, count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: b?.lastCareSentAt || 0, lastReplyAtMs: b?.lastReplyAtMs || 0 };
    }
    return b;
  }

  function bumpBudget(scope, candidate) {
    const now = _now();
    const today = localDayKey(now);
    const b = budget[scope];
    const care = isCare(candidate);
    if (b && b.day === today) {
      b.count += 1;
      b.lastSentAt = now;
      if (care) {
        b.careCount = (b.careCount || 0) + 1;
        b.lastCareSentAt = now;
      }
    } else {
      budget[scope] = {
        day: today,
        count: 1,
        careCount: care ? 1 : 0,
        lastSentAt: now,
        lastCareSentAt: care ? now : (b?.lastCareSentAt || 0),
        lastReplyAtMs: b?.lastReplyAtMs || 0,
      };
    }
    capObject(budget, MAX_ENTRIES);
    markBudgetDirty();
  }

  // Inbound bookkeeping: a member message after a care send counts as a reply
  // for the hard 48h care rule. Observation-only, never gating the chat itself.
  function onMessageReceived(event, ctx) {
    try {
      if (dcfg.enabled !== true && dcfg.shadow !== true) return;
      const sk = ctx?.sessionKey;
      if (!sk || !isDmSession(sk)) return;
      const agentId = ctx?.agentId || agentIdFromSessionKey(sk);
      if (!isScopedAgent(cfg, agentId)) return;
      const scope = scopeKey(agentId, sk);
      const b = budget[scope] || { day: localDayKey(_now()), count: 0, careCount: 0, lastSentAt: 0, lastCareSentAt: 0, lastReplyAtMs: 0 };
      b.lastReplyAtMs = _now();
      budget[scope] = b;
      capObject(budget, MAX_ENTRIES);
      markBudgetDirty();
    } catch {}
  }

  // Plan 530 (design §2.1 flow 3+4+5): the outbound message is a followup
  // candidate ONLY when its first line is a `[[fu:{…}]]` envelope (the
  // followup-cron is the producer). Normal agent text without an envelope is
  // NEVER touched (fail-open, parity #24). Malformed envelopes warn and pass
  // through unchanged — a broken envelope could still be a normal reply.
  // Shadow-v2: gating runs, the cron send itself delivers (envelope stripped),
  // candidate + verdicts + render preview are logged, never a cancel.
  // Live: gate-pass → cancel + own send of the rendered draft via
  // subagent.run (idempotencyKey); gate-fail/duplicate → cancel + log —
  // in v2 there is no dist fallback, gate-fail suppresses.
  async function onMessageSending(event, ctx) {
    try {
      if (dcfg.enabled !== true && dcfg.shadow !== true) return;
      const sk = ctx?.sessionKey;
      if (!sk || !isDmSession(sk)) return;
      const agentId = ctx?.agentId || agentIdFromSessionKey(sk);
      if (!isScopedAgent(cfg, agentId)) return;
      const content = event?.content || "";
      const parsed = parseFollowupEnvelope(content);
      if (parsed === null) return;               // normal agent text → untouched
      if (!parsed.ok) {
        _log.warn(`human-engine: dm-proactive: malformed followup envelope (${parsed.error}) — pass-through`);
        return;                                  // fail-open, no cancel, no rewrite
      }
      const candidate = candidateFromEnvelope(parsed.envelope, parsed.draftText, sk, agentId);
      const gate = evaluateGate(candidate);
      const shadow = dcfg.shadow === true;
      if (shadow) {
        await handleCandidate(candidate, gate);  // one log entry: candidate + verdicts + render preview
        recordSentId(candidate.id);              // the cron send itself is the delivery
        return { content: parsed.draftText };   // strip the envelope, never cancel
      }
      if (!gate.pass) {
        await handleCandidate(candidate, gate);  // logs the gate failure / duplicate
        return { cancel: true };                 // v2: no fallback — gate-fail suppresses
      }
      if (!runtime?.subagent?.run) {
        await handleCandidate(candidate, gate);  // logs "cannot send"
        recordSentId(candidate.id);             // the stripped raw draft below IS the delivery
        return { content: parsed.draftText };    // fail-open: deliver rather than lose the send
      }
      await handleCandidate(candidate, gate);   // renders + sends + records sentId + bumps budget
      return { cancel: true };                  // suppress the original outbound
    } catch {}
  }

  // Thin wrapper over the shared gate-core (Plan 530): injects the plugin's
  // own state (budget counter, transcript peek, sentIds membership) into the
  // ONE gate implementation also used by bin/followup-gate.mjs.
  function evaluateGate(candidate) {
    const scope = scopeKey(candidate.agentId, candidate.sessionKey);
    const peek = getTranscriptPeek(candidate.sessionKey, 5);
    const newest = peek[peek.length - 1];
    return evaluateDmGate(candidate, {
      dcfg,
      now: _now(),
      agentName,
      counter: getBudget(scope),
      newestSpeaker: newest?.speaker,
      duplicate: hasSentId(candidate.id),
      // Plan 531 §2.2: DayFit factor read from kevin-activity.json (mtime-
      // cached ≤ 60 s, fail-safe). Hard reminders pass regardless (isSoftTier).
      dayFit: dayFitFactor({
        now: _now(),
        filePath: _activityFilePath || undefined,
        reduceHours: dcfg.dayFitReduceHours ?? 4,
        pauseHours: dcfg.dayFitPauseHours ?? 12,
        cache: dayFitCache,
        log: _log,
      }),
    });
  }

  // Exactly one concrete fact from social-memory if it fits the suggested
  // text (content-word overlap > 0); otherwise NO reference (anti-hallucination).
  function memoryReferenceFor(candidate) {
    try {
      const scope = scopeKey(candidate.agentId, candidate.sessionKey);
      const profile = socialMemory?.getOrLoadProfile ? socialMemory.getOrLoadProfile(scope) : null;
      const people = profile?.people || {};
      const text = candidate.suggestedText || "";
      let best = null;
      let bestScore = 0;
      for (const [name, p] of Object.entries(people)) {
        for (const fact of (Array.isArray(p?.facts) ? p.facts : []).slice(0, 10)) {
          if (typeof fact !== "string" || !fact.trim()) continue;
          const score = overlapCount(text, fact);
          if (score > bestScore) {
            bestScore = score;
            best = { name, fact: fact.trim() };
          }
        }
      }
      if (!best || bestScore <= 0) return "";
      return best.name + ": " + best.fact;
    } catch {
      return "";
    }
  }

  async function render(candidate, memoryReference) {
    const llmAvailable = llm && typeof llm.complete === "function";
    if (!llmAvailable) return { draft: candidate.suggestedText, llm: "no-llm-fallback", memoryReference };
    let persona = null;
    try {
      persona = buildPersonaPrompt(cfg, candidate.sessionKey);
    } catch {}
    const prompt = buildDmRenderPrompt({
      suggestedText: candidate.suggestedText,
      kind: candidate.kind,
      sensitivity: candidate.sensitivity,
      agentName,
      memoryReference,
      persona,
    });
    try {
      const result = await llm.complete({
        messages: [
          { role: "system", content: prompt.systemPrompt },
          { role: "user", content: prompt.userMessage },
        ],
        temperature: 0.4,
        maxTokens: 200,
        purpose: "dm-proactive-render",
        signal: AbortSignal.timeout(20000),
      });
      const draft = String(result?.text || "").trim();
      if (!draft) return { draft: candidate.suggestedText, llm: "fallback-empty", memoryReference };
      return { draft, llm: "rendered", memoryReference };
    } catch (err) {
      _log.warn(`human-engine: dm-proactive: render error: ${err?.message || err}`);
      return { draft: candidate.suggestedText, llm: "render-error-fallback", memoryReference };
    }
  }

  // `precomputedGate` is supplied by `onMessageSending`'s live path so the
  // cancel decision and the log entry derive from the SAME gate result — the
  // log entry shape is unchanged: exactly one entry per candidate, same fields.
  // Failure semantics: when the live path has already returned `{ cancel:true }`
  // (the original outbound is suppressed) and `subagent.run` then throws, the
  // rendered text is lost — we WARN here, leave the commitment pending, and the
  // next due cycle retries.
  async function handleCandidate(candidate, precomputedGate) {
    const shadow = dcfg.shadow === true;
    const now = _now();
    const entry = {
      ts: now,
      mode: shadow ? "shadow" : "live",
      agentId: candidate.agentId,
      sessionKey: candidate.sessionKey,
      candidate: {
        id: candidate.id,
        kind: candidate.kind,
        sensitivity: candidate.sensitivity,
        confidence: candidate.confidence,
        source: candidate.source,
        dueWindow: candidate.dueWindow,
      },
      suggestedText: candidate.suggestedText,
      gate: { pass: false, reasons: [] },
      render: { llm: "none", memoryReference: null, draft: "" },
      sent: false,
    };

    const gate = precomputedGate || evaluateGate(candidate);
    entry.gate = gate;
    if (!gate.pass) {
      _log.info(`human-engine: dm-proactive SHADOW id=${redactSessionKey(candidate.id)} kind=${candidate.kind} reason=failed:${gate.reasons[0]}`);
      appendLog(entry);
      return { log: entry, sent: false };
    }

    const memoryReference = memoryReferenceFor(candidate);
    const rendered = await render(candidate, memoryReference);
    entry.render = { llm: rendered.llm, memoryReference: memoryReference || null, draft: rendered.draft };

    if (shadow) {
      _log.info(`human-engine: dm-proactive SHADOW id=${redactSessionKey(candidate.id)} kind=${candidate.kind} reason=passed draft=${(rendered.draft || "").slice(0, 80)}`);
      appendLog(entry);
      return { log: entry, sent: false };
    }

    if (!runtime?.subagent?.run) {
      _log.warn(`human-engine: dm-proactive cannot send — api.runtime.subagent.run unavailable id=${redactSessionKey(candidate.id)}`);
      entry.sent = false;
      appendLog(entry);
      return { log: entry, sent: false };
    }

    try {
      await runtime.subagent.run({
        sessionKey: candidate.sessionKey,
        message: rendered.draft,
        deliver: true,
        idempotencyKey: "human-engine-dm-proactive-" + candidate.id,
      });
      entry.sent = true;
      bumpBudget(scopeKey(candidate.agentId, candidate.sessionKey), candidate);
      recordSentId(candidate.id);
      _log.info(`human-engine: dm-proactive SENT id=${redactSessionKey(candidate.id)} kind=${candidate.kind} commitmentId=${redactSessionKey(candidate.id)}`);
    } catch (err) {
      _log.warn(`human-engine: dm-proactive live send failed after cancel id=${redactSessionKey(candidate.id)}: ${err?.message || err}`);
      entry.sent = false;
    }
    appendLog(entry);
    return { log: entry, sent: entry.sent };
  }

  function stop() {
    flushBudget();
  }

  loadBudget();
  return { onMessageReceived, onMessageSending, handleCandidate, evaluateGate, stop };
}