let _rng = () => Math.random();

export function setRng(fn) {
  _rng = fn;
}

export function resetRng() {
  _rng = () => Math.random();
}

function lognormalRaw(median, sigma) {
  const u = _rng();
  const v = _rng();
  const eps = 1e-10;
  const z = Math.sqrt(-2 * Math.log(Math.max(u, eps))) * Math.cos(2 * Math.PI * v);
  return Math.exp(Math.log(median) + sigma * z);
}

export function lognormal(median, sigma) {
  return lognormalRaw(median, sigma);
}

export function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

export function readingDelayMs(ctx, timingCfg) {
  const c = ctx || {};
  const tc = timingCfg || {};
  const nightMode = tc.nightMode !== false;
  const base = lognormalRaw(4000, 0.7);
  let d = base;
  const isQuestionReply = c.isQuestionReply === true || c.wasAddressed === true;
  if (isQuestionReply) d *= 0.6;
  else if (c.isGroup) d *= 1.5;
  if (c.contentReadMs) d += c.contentReadMs;
  if (c.moodEnergy != null) d *= (1 - 0.06 * c.moodEnergy);
  if (nightMode && c.hourOfDay != null && (c.hourOfDay >= 22 || c.hourOfDay < 7)) d *= 1.4;
  // hot-room compression (P0 answer-delivery hotfix): newest message < 3min old
  // → deliver the answer faster so a follow-up can't supersede late bubbles.
  const hot = typeof c.newestAgeMs === "number" && c.newestAgeMs < 180000;
  if (hot) d *= 0.35;
  return Math.round(clamp(d, 2000, 30000));
}

export function thinkPauseMs(ctx) {
  const c = ctx || {};
  const hot = typeof c.newestAgeMs === "number" && c.newestAgeMs < 180000;
  let d = lognormalRaw(2500, 0.5);
  if (hot) d *= 0.5;
  return Math.round(clamp(d, 1000, 5000));
}

export function typingMs(text, wpm, timingCfg, ctx) {
  const w = wpm || 40;
  const cps = w * 5 / 60;
  const base = ((text || "").length / cps) * 1000;
  const jitter = lognormalRaw(1, 0.25);
  const c = ctx || {};
  const hot = typeof c.newestAgeMs === "number" && c.newestAgeMs < 180000;
  const maxTyping = hot ? 8000 : (timingCfg?.maxTypingMs || 60000);
  return Math.round(clamp(base * jitter, 1200, maxTyping));
}

export function bubbleGapMs(timingCfg, ctx) {
  const tc = timingCfg || {};
  const c = ctx || {};
  const hot = typeof c.newestAgeMs === "number" && c.newestAgeMs < 180000;
  let g = lognormalRaw(1600, 0.4);
  if (hot) g *= 0.5;
  return Math.round(clamp(g, 800, tc.maxBubbleGapMs || 3000));
}

export function scheduleForBubbles(bubbles, ctx, timingCfg) {
  const tc = timingCfg || {};
  const wpm = tc.typingWpm || 40;
  const result = [];
  let offset = 0;
  for (let i = 0; i < bubbles.length; i++) {
    if (i === 0) {
      offset += readingDelayMs(ctx, tc) + thinkPauseMs(ctx) + typingMs(bubbles[i].content, wpm, tc, ctx);
    } else {
      offset += bubbleGapMs(tc, ctx) + typingMs(bubbles[i].content, wpm, tc, ctx);
    }
    result.push({ content: bubbles[i].content, position: i, delayMs: Math.round(offset) });
  }
  return result;
}
