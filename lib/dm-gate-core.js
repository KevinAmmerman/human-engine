import { localDayKey, isQuietHour } from "./proactive.js";

/*
 * Plan 530 / design-dm-proactive-v2 §2.1 + §5 AP (a): the ONE shared gate
 * implementation for DM-proactive followup candidates. Consumed by the
 * plugin hook (lib/dm-proactive.js) AND the layer-1 CLI (bin/followup-gate.mjs)
 * so cron-side pre-checks and the authoritative hook verdict can never drift.
 *
 * `evaluateDmGate(candidate, ctx)` is pure: all mutable state (budget
 * counter, newest transcript speaker, sentIds membership) is injected via
 * ctx: { dcfg, now, counter, agentName, newestSpeaker, duplicate }.
 * `verdicts` keys mirror the reason strings; value true = check passed.
 *
 * Envelope contract (§2.1, first line of the cron send):
 *   [[fu:{"id":"fu-<yyyymmdd>-<slug>","kind":"soft_followup|reminder|event|
 *     care_check_in","sensitivity":"normal|care","confidence":0.0-1.0,
 *     "dueWindow":{"earliestMs":n,"latestMs":n},"lastUserRefMs":n,
 *     "source":"followup-cron"}]]
 * Unknown fields are tolerated (ignored, §7.1). Malformed/parse-broken
 * envelopes are reported as { ok:false } — callers must pass through and
 * only warn (fail-open: a non-envelope could be a normal agent reply).
 */

export const DEADLINE_GRACE_MS = 2 * 60 * 60 * 1000;
export const CARE_NO_REPLY_COOLDOWN_MS = 48 * 60 * 60 * 1000;

const CARE_KINDS = new Set(["care_check_in", "care_checkin"]);
export const FOLLOWUP_KINDS = new Set(["soft_followup", "reminder", "event", "care_check_in"]);
export const FOLLOWUP_SENSITIVITIES = new Set(["normal", "care"]);
export const ENVELOPE_PREFIX = "[[fu:";
export const ENVELOPE_SUFFIX = "]]";
const ENVELOPE_ID_RE = /^fu-\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Plan 531 §2.2: DayFit applies only to soft-tier followups. Hard reminders
// (reminder/event) are DayFit-independent — they must always fire. A
// care_check_in counts as soft ONLY at normal sensitivity (care has its own
// §2.1 anti-annoyance rules and must not be DayFit-blocked).
export function isSoftTier(candidate) {
  const kind = String(candidate?.kind || "").toLowerCase();
  if (kind === "reminder" || kind === "event") return false;
  if (kind === "care_check_in" || kind === "care_checkin") {
    return String(candidate?.sensitivity || "").toLowerCase() !== "care";
  }
  return kind === "soft_followup";
}

export function isCare(candidate) {
  const kind = String(candidate?.kind || "").toLowerCase();
  const sensitivity = String(candidate?.sensitivity || "").toLowerCase();
  return CARE_KINDS.has(kind) || sensitivity === "care";
}

export function evaluateDmGate(candidate, ctx) {
  const dcfg = ctx?.dcfg || {};
  const now = typeof ctx?.now === "number" ? ctx.now : Date.now();
  const counter = ctx?.counter || null;
  const reasons = [];
  const verdicts = {};
  const check = (name, pass) => {
    verdicts[name] = pass === true;
    if (verdicts[name] === false) reasons.push(name);
  };

  check("disabled", dcfg.enabled === true);

  const care = isCare(candidate);
  const soft = isSoftTier(candidate);
  // Plan 531 §2.2: DayFit factor injected by the caller (plugin hook reads
  // kevin-activity.json via lib/dayfit.js; the CLI has no DayFit input and
  // defaults to full so the layer-1 convention never over-blocks).
  const dayFit = ctx?.dayFit && typeof ctx.dayFit === "object" ? ctx.dayFit : null;
  const hasDayFitValue = dayFit && Object.prototype.hasOwnProperty.call(dayFit, "value");
  const dfValue = hasDayFitValue ? dayFit.value : 1.0;
  const dfReason = dayFit && typeof dayFit.reason === "string" ? dayFit.reason : "dayfit-full";
  const dayFitBlocked = soft && dfValue === null;
  const softCapFactor = soft && !dayFitBlocked && dfValue === 0.5 ? 0.5 : 1.0;

  if (counter) {
    const today = localDayKey(now);
    const baseBudget = dcfg.budgetPerDay ?? 2;
    const cap = soft ? Math.ceil(baseBudget * softCapFactor) : baseBudget;
    check("budget", !(counter.day === today && counter.count >= cap));
    check("min-gap", !(counter.lastSentAt && now - counter.lastSentAt < (dcfg.minGapMinutes ?? 180) * 60000));
    check("care-budget", !(care && counter.day === today && (counter.careCount || 0) >= (dcfg.careBudgetPerDay ?? 1)));
    let careCooldownOk = true;
    if (care && counter.lastCareSentAt) {
      const repliedSinceCare = (counter.lastReplyAtMs || 0) >= counter.lastCareSentAt;
      careCooldownOk = repliedSinceCare || now - counter.lastCareSentAt < CARE_NO_REPLY_COOLDOWN_MS;
    }
    check("care-no-reply-48h", careCooldownOk);
  } else {
    check("budget", true);
    check("min-gap", true);
    check("care-budget", true);
    check("care-no-reply-48h", true);
  }

  if (dayFitBlocked) {
    check(dfReason === "dayfit-unknown" ? "dayfit-unknown" : "dayfit-stale", false);
  }

  const latestMs = candidate?.dueWindow?.latestMs || 0;
  const deadlineClose = latestMs > 0 && now < latestMs && latestMs - now < DEADLINE_GRACE_MS;
  check("quiet-hours", !(isQuietHour(now, dcfg.quietStart ?? "23:00", dcfg.quietEnd ?? "07:00") && !deadlineClose));

  check("double-text", !(typeof ctx?.newestSpeaker === "string" && ctx.newestSpeaker === ctx?.agentName));
  check("duplicate", ctx?.duplicate !== true);

  return { pass: reasons.length === 0, reasons, verdicts };
}

function isFiniteNonNegativeNumber(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

// Returns null when valid, otherwise a short error code (§7.1 tolerance:
// unknown fields are ignored, never rejected).
export function envelopeError(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return "not-an-object";
  if (typeof envelope.id !== "string" || !ENVELOPE_ID_RE.test(envelope.id)) return "bad-id";
  if (typeof envelope.kind !== "string" || !FOLLOWUP_KINDS.has(envelope.kind)) return "bad-kind";
  if (typeof envelope.sensitivity !== "string" || !FOLLOWUP_SENSITIVITIES.has(envelope.sensitivity)) return "bad-sensitivity";
  if (typeof envelope.confidence !== "number" || !Number.isFinite(envelope.confidence) || envelope.confidence < 0 || envelope.confidence > 1) return "bad-confidence";
  const dw = envelope.dueWindow;
  if (!dw || typeof dw !== "object" || !isFiniteNonNegativeNumber(dw.earliestMs) || !isFiniteNonNegativeNumber(dw.latestMs)) return "bad-due-window";
  if (envelope.kind === "soft_followup" && !isFiniteNonNegativeNumber(envelope.lastUserRefMs)) return "missing-last-user-ref";
  if (typeof envelope.source !== "string" || !envelope.source) return "bad-source";
  return null;
}

// Returns null for content without an envelope line (normal agent text —
// never touched by the hook), { ok:false, error } for a malformed envelope
// (caller: warn + pass-through, fail-open), or
// { ok:true, envelope, draftText } for a valid candidate.
export function parseFollowupEnvelope(content) {
  const text = String(content ?? "");
  const nl = text.indexOf("\n");
  const firstLine = (nl === -1 ? text : text.slice(0, nl)).trimEnd();
  if (!firstLine.startsWith(ENVELOPE_PREFIX)) return null;
  if (!firstLine.endsWith(ENVELOPE_SUFFIX)) return { ok: false, error: "unterminated" };
  const draftText = nl === -1 ? "" : text.slice(nl + 1);
  if (!draftText.trim()) return { ok: false, error: "empty-draft" };
  let raw;
  try {
    raw = JSON.parse(firstLine.slice(ENVELOPE_PREFIX.length, firstLine.length - ENVELOPE_SUFFIX.length));
  } catch {
    return { ok: false, error: "json-parse" };
  }
  const err = envelopeError(raw);
  if (err) return { ok: false, error: err };
  return { ok: true, envelope: raw, draftText };
}

export function candidateFromEnvelope(envelope, draftText, sessionKey, agentId) {
  return {
    id: envelope.id,
    kind: envelope.kind,
    sensitivity: envelope.sensitivity,
    confidence: envelope.confidence,
    source: envelope.source || "followup-cron",
    suggestedText: draftText,
    dueWindow: envelope.dueWindow,
    sessionKey,
    agentId,
  };
}
