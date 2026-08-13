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
  if (c.wasAddressed) d *= 0.5;
  if (c.isGroup && !c.wasAddressed) d *= 1.5;
  if (nightMode && c.hourOfDay != null && (c.hourOfDay >= 22 || c.hourOfDay < 7)) d *= 1.4;
  return Math.round(clamp(d, 2000, 30000));
}

export function thinkPauseMs() {
  return Math.round(clamp(lognormalRaw(2500, 0.5), 1000, 5000));
}

export function typingMs(text, wpm, timingCfg) {
  const w = wpm || 40;
  const cps = w * 5 / 60;
  const base = ((text || "").length / cps) * 1000;
  const jitter = lognormalRaw(1, 0.25);
  return Math.round(clamp(base * jitter, 1200, timingCfg?.maxTypingMs || 60000));
}

export function bubbleGapMs(timingCfg) {
  const tc = timingCfg || {};
  return Math.round(clamp(lognormalRaw(1600, 0.4), 800, tc.maxBubbleGapMs || 3000));
}

export function scheduleForBubbles(bubbles, ctx, timingCfg) {
  const tc = timingCfg || {};
  const wpm = tc.typingWpm || 40;
  const result = [];
  let offset = 0;
  for (let i = 0; i < bubbles.length; i++) {
    if (i === 0) {
      offset += readingDelayMs(ctx, tc) + thinkPauseMs() + typingMs(bubbles[i].content, wpm, tc);
    } else {
      offset += bubbleGapMs(tc) + typingMs(bubbles[i].content, wpm, tc);
    }
    result.push({ content: bubbles[i].content, position: i, delayMs: Math.round(offset) });
  }
  return result;
}
