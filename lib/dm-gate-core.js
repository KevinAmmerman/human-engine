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
// Plan 546 [AMENDMENT 4]: normalize `kind` before validation so the real-world
// `care`/`care-check-in`/`care_checkin` variants collapse onto the canonical
// `care_check_in`, and `soft-followup`/`softfollowup` collapse onto
// `soft_followup`. Case-insensitive + trimmed. Unknown kinds stay invalid
// (→ the caller's malformed policy).
export function normalizeFollowupKind(kind) {
  if (typeof kind !== "string") return kind;
  const k = kind.trim().toLowerCase();
  if (k === "care" || k === "care-check-in" || k === "care_checkin" || k === "care_check_in") return "care_check_in";
  if (k === "soft-followup" || k === "softfollowup" || k === "soft_followup") return "soft_followup";
  return kind;
}
// Plan 534 / design §3 Q3: Open-Loop age gates the soft-tier by how long since
// the last user reference (lastUserRefMs, from the envelope). ≤ 7 days: normal
// soft-tier. 7–14 days: allowed ONLY at full DayFit (1.0). > 14 days: excluded
// (open-loop-stale). Hard reminders (reminder/event) are not Open-Loop-gated.
export const OPEN_LOOP_STALE_DAYS = 14;
export const OPEN_LOOP_RESTRICT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// Returns the Open-Loop age in days since `lastUserRefMs` at `now`, or null
// when the candidate carries no usable reference (fail-open — no restriction).
export function openLoopAgeDays(candidate, now) {
  if (!candidate || typeof candidate?.lastUserRefMs !== "number" || !Number.isFinite(candidate.lastUserRefMs) || candidate.lastUserRefMs <= 0) return null;
  return (now - candidate.lastUserRefMs) / DAY_MS;
}

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
  // Plan 532 §2.3 (AP c): byKind cadence state injected via ctx.byKind —
  // { budgetMultiplier, paused } resolved by the plugin from ignoreStreak.
  // Effective soft cap per scope/day:
  //   ceil(inferredCapPerDay × dayFitFaktor × budgetMultiplier(kind))
  // `paused: true` blocks the soft-tier of the kind entirely (cadence-paused).
  // Hard reminders (reminder/event) are NOT cadence-gated — they use the DoS
  // fallback budgetPerDay (Default 4, design §7.3) and ignore cadence/ignores.
  const byKind = ctx?.byKind && typeof ctx.byKind === "object" ? ctx.byKind : null;
  // When byKind is absent (CLI layer-1, no cadence state) default to full
  // multiplier 1.0 and not paused so the convention never over-blocks.
  const budgetMultiplier =
    byKind && typeof byKind.budgetMultiplier === "number" && byKind.budgetMultiplier > 0 ? byKind.budgetMultiplier : 1.0;
  const cadencePaused = byKind?.paused === true;

  if (counter) {
    const today = localDayKey(now);
    if (soft) {
      // Paused soft-tier of the kind blocks outright (design §2.3).
      if (cadencePaused) {
        check("cadence-paused", false);
      } else if (dayFitBlocked) {
        // DayFit already blocks this soft-tier (dayfit-stale/unknown, below) —
        // skip the budget check so only the DayFit reason is reported.
      } else {
        const inferredCap = dcfg.inferredCapPerDay ?? 2;
        const softCap = Math.ceil(inferredCap * dfValue * budgetMultiplier);
        check("budget", !(counter.day === today && counter.count >= softCap));
      }
    } else {
      // Hard reminders run through the same gates but are exempt from the
      // inferred-cap AND cadence throttling (design §2.3 / §3 Q2).
      const hardCap = dcfg.budgetPerDay ?? 4;
      check("budget", !(counter.day === today && counter.count >= hardCap));
    }
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

  // Plan 534 / design §3 Q3 (Open-Loop age): only for soft-tier. Hard reminders
  // (reminder/event) are exempt — they always fire. No usable lastUserRefMs →
  // fail-open (no restriction). 7–14 days only at full DayFit (1.0); > 14 days
  // excluded outright (open-loop-stale).
  if (soft) {
    const ageDays = openLoopAgeDays(candidate, now);
    if (ageDays !== null) {
      if (ageDays > OPEN_LOOP_STALE_DAYS) {
        check("open-loop-stale", false);
        check("open-loop-dayfit", true);
      } else if (ageDays > OPEN_LOOP_RESTRICT_DAYS) {
        const dayFitOk = dfValue === 1.0;
        check("open-loop-stale", true);
        check("open-loop-dayfit", dayFitOk);
      } else {
        check("open-loop-stale", true);
        check("open-loop-dayfit", true);
      }
    } else {
      check("open-loop-stale", true);
      check("open-loop-dayfit", true);
    }
  } else {
    check("open-loop-stale", true);
    check("open-loop-dayfit", true);
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
  // Plan 546 [AMENDMENT 4]: normalize the kind on the parsed envelope so the
  // returned candidate always carries a canonical kind and validation accepts
  // the real-world variants (`care` → `care_check_in`, etc.).
  if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.kind === "string") {
    raw.kind = normalizeFollowupKind(raw.kind);
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
    lastUserRefMs: typeof envelope.lastUserRefMs === "number" ? envelope.lastUserRefMs : undefined,
    sessionKey,
    agentId,
  };
}
