import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localDayKey, isQuietHour, overlapCount, agentIdFromSessionKey, contentWords, capObject, STOPWORDS } from "./proactive.js";
import { buildDmRenderPrompt } from "./local-prompts.js";
import { buildPersonaPrompt } from "./persona.js";
import { getTranscriptPeek } from "./state.js";
import { isScopedAgent } from "./config.js";
import { redactSessionKey } from "./redact.js";

/*
 * Plan 412: DM proactive path — the moment-engine (Plan 409, in the runner)
 * stays the SELECTION instance; this module is the RENDER + fine-timing
 * instance for the DM. It observes the runner's due-commitment delivery
 * (`message_sending` + commitments-store reconciliation), then renders the
 * candidate through the same social intelligence the group already uses:
 * persona/voice, one concrete memory reference (never invented), German
 * understatement, and a hard anti-annoyance gate.
 *
 * SHADOW-FIRST: `dmProactive.shadow` stays `true` for this plan. In shadow
 * mode this module only logs to state/dm-proactive.jsonl and never sends,
 * rewrites, or blocks — the dist fallback (Plan 407/409) keeps delivering.
 * Activation (`shadow:false`) is a later operator decision after a 7-day
 * review of that log.
 *
 * ACTIVATION CHECKLIST (operator, before `shadow:false`):
 *  - Render drafts feel human on a 10-item sample (specificity, restraint).
 *  - Gate blocks are plausible (budget, quiet hours, 48h no-reply care rule).
 *  - No double delivery with the dist fallback (same commitmentId twice) —
 *    HANDLED: on live sends that own this send, `onMessageSending` returns
 *    `{ cancel: true }` to suppress the original outbound (see the live path).
 *  - KPI ground truth (Plan 410) is observing reply warmth to these sends.
 *
 * Gate rules reused from proactive.js: budget, min-gap, quiet-hours,
 * double-text. DM-only rules: max 1 care send/day, and after a care send
 * without a reply for >=48h no further care send (VAIL: care frequency must
 * never rise in reaction to a member's silence — this 48h rule is hard).
 * Quiet hours 23-07 are hard, with the same deadline exception as Plan 409
 * (latestMs - now < 2h). The random "probability" gate is intentionally NOT
 * carried over: the moment-engine already scores candidates deterministically,
 * random rejection would be incoherent on top of it.
 */

const DEADLINE_GRACE_MS = 2 * 60 * 60 * 1000;
const CARE_NO_REPLY_COOLDOWN_MS = 48 * 60 * 60 * 1000;
const LOG_ROTATE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 256;
const DM_CHANNEL_RE = /:(whatsapp|telegram|discord|signal|slack|matrix):/;
const CARE_KINDS = new Set(["care_check_in", "care_checkin"]);

function isDmSession(sk) {
  if (typeof sk !== "string") return false;
  if (sk.includes(":heartbeat")) return false;
  if (sk.includes(":group:")) return false;
  return DM_CHANNEL_RE.test(sk);
}

function scopeKey(agentId, sk) {
  return (agentId || "?") + "::" + sk;
}

function isCare(candidate) {
  const kind = String(candidate?.kind || "").toLowerCase();
  const sensitivity = String(candidate?.sensitivity || "").toLowerCase();
  return CARE_KINDS.has(kind) || sensitivity === "care";
}

export function createDmProactive({ cfg, llm, socialMemory, runtime, stateDir, log, now, commitmentsPath }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const _now = typeof now === "function" ? now : () => Date.now();
  const dcfg = cfg?.dmProactive || {};
  const agentName = cfg?.agentName || "Agent";
  const stateFile = path.join(stateDir || ".", "dm-proactive-state.json");
  const logFile = path.join(stateDir || ".", "dm-proactive.jsonl");
  const storeFile = commitmentsPath || path.join(os.homedir(), ".openclaw", "commitments", "commitments.json");

  // scope -> { day, count, careCount, lastSentAt, lastCareSentAt, lastReplyAtMs }
  const budget = {};
  const BUDGET_FLUSH_MS = 2000;
  let budgetDirty = false;
  let budgetTimer = null;
  let commitmentsCache = null; // { mtimeMs, size, commitments }
  let commitmentsKey = null;

  function loadBudget() {
    try {
      const raw = fs.readFileSync(stateFile, "utf8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object" && data.scopes) {
        Object.assign(budget, data.scopes);
      }
    } catch {}
  }

  function saveBudget() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      const tmp = stateFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ scopes: budget }), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, stateFile);
    } catch (err) {
      _log.warn(`human-engine: dm-proactive: save error: ${err?.message || err}`);
    }
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

  // Entry from the runner's due-commitment delivery flow. The runner emits no
  // plugin hook carrying the candidate itself, so we observe the outbound
  // delivery (`message_sending`) and reconcile the text against the
  // commitments store to recover the full candidate metadata. In shadow mode
  // this only logs — the dist fallback keeps delivering.
  async function onMessageSending(event, ctx) {
    try {
      if (dcfg.enabled !== true && dcfg.shadow !== true) return;
      const sk = ctx?.sessionKey;
      if (!sk || !isDmSession(sk)) return;
      const agentId = ctx?.agentId || agentIdFromSessionKey(sk);
      if (!isScopedAgent(cfg, agentId)) return;
      const content = event?.content || "";
      const candidate = reconcileCandidate(agentId, sk, content);
      if (!candidate) return;                     // not ours → dist fallback delivers
      const gate = evaluateGate(candidate);
      const shadow = dcfg.shadow === true;
      if (shadow) {
        await handleCandidate(candidate, gate);   // log-only path (unchanged)
        return;
      }
      if (!gate.pass) {
        await handleCandidate(candidate, gate);   // logs the gate failure, no send
        return;                                   // dist fallback delivers
      }
      // live, gate passed, runtime present → WE own this send
      if (!runtime?.subagent?.run) {
        await handleCandidate(candidate, gate);   // logs "cannot send"
        return;                                   // let dist fallback deliver
      }
      await handleCandidate(candidate, gate);
      return { cancel: true };                    // suppress the original outbound
    } catch {}
  }

  function loadCommitments() {
    try {
      const st = fs.statSync(storeFile);
      const key = st.mtimeMs + ":" + st.size;
      if (commitmentsKey === key && commitmentsCache) return commitmentsCache;
      const data = JSON.parse(fs.readFileSync(storeFile, "utf8"));
      const commitments = data && Array.isArray(data.commitments) ? data.commitments : [];
      commitmentsKey = key;
      commitmentsCache = commitments;
      return commitments;
    } catch {
      return [];
    }
  }

  function reconcileCandidate(agentId, sk, content) {
    const target = String(content || "").trim();
    if (!target) return null;
    const store = loadCommitments();
    const matches = store.filter((c) =>
      c?.agentId === agentId &&
      c?.sessionKey === sk &&
      String(c?.suggestedText || "").trim() === target &&
      c?.status !== "dismissed" &&
      c?.status !== "expired"
    );
    if (matches.length === 0) return null;
    matches.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
    const c = matches[0];
    return {
      id: c.id,
      kind: c.kind,
      sensitivity: c.sensitivity,
      confidence: c.confidence,
      source: c.source,
      suggestedText: c.suggestedText,
      dueWindow: c.dueWindow,
      sessionKey: sk,
      agentId,
    };
  }

  function evaluateGate(candidate) {
    const now = _now();
    const scope = scopeKey(candidate.agentId, candidate.sessionKey);
    const reasons = [];

    if (dcfg.enabled !== true) reasons.push("disabled");

    const counter = getBudget(scope);
    const budgetPerDay = dcfg.budgetPerDay ?? 2;
    if (counter.day === localDayKey(now) && counter.count >= budgetPerDay) reasons.push("budget");
    if (counter.lastSentAt && now - counter.lastSentAt < (dcfg.minGapMinutes ?? 180) * 60000) reasons.push("min-gap");
    if (isCare(candidate) && counter.day === localDayKey(now) && (counter.careCount || 0) >= (dcfg.careBudgetPerDay ?? 1)) reasons.push("care-budget");
    if (isCare(candidate) && counter.lastCareSentAt) {
      const repliedSinceCare = (counter.lastReplyAtMs || 0) >= counter.lastCareSentAt;
      if (!repliedSinceCare && now - counter.lastCareSentAt >= CARE_NO_REPLY_COOLDOWN_MS) reasons.push("care-no-reply-48h");
    }

    const latestMs = candidate.dueWindow?.latestMs || 0;
    const deadlineClose = latestMs > 0 && now < latestMs && (latestMs - now) < DEADLINE_GRACE_MS;
    if (isQuietHour(now, dcfg.quietStart ?? "23:00", dcfg.quietEnd ?? "07:00") && !deadlineClose) reasons.push("quiet-hours");

    const peek = getTranscriptPeek(candidate.sessionKey, 5);
    const newest = peek[peek.length - 1];
    if (newest && newest.speaker === agentName) reasons.push("double-text");

    return { pass: reasons.length === 0, reasons };
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