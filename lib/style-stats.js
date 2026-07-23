const EMOJI_RE = /[\p{Emoji}]/u;

const CONTRACTION_RE = /\b(?:don't|doesn't|didn't|isn't|aren't|wasn't|weren't|won't|wouldn't|shouldn't|couldn't|can't|hasn't|haven't|hadn't|it's|that's|what's|who's|here's|there's|let's|i'm|you're|we're|they're|i've|you've|we've|they've|i'd|you'd|we'd|they'd|i'll|you'll|we'll|they'll)\b/i;

export function computeStyleStats(lines) {
  if (!lines || lines.length === 0) {
    return { avgLen: 0, capsRate: 0, emojiRate: 0, contractionRate: 0, exclaimRate: 0 };
  }

  const texts = lines.map((l) => l.replace(/^\[[^\]]*\]\s*/, ""));

  const totalLen = texts.reduce((s, t) => s + t.length, 0);
  const avgLen = texts.length > 0 ? Math.round(totalLen / texts.length) : 0;

  const capsCount = texts.filter((t) => /[A-Z]/.test(t)).length;
  const capsRate = texts.length > 0 ? capsCount / texts.length : 0;

  const emojiCount = texts.filter((t) => EMOJI_RE.test(t)).length;
  const emojiRate = texts.length > 0 ? emojiCount / texts.length : 0;

  const contractionCount = texts.filter((t) => CONTRACTION_RE.test(t)).length;
  const contractionRate = texts.length > 0 ? contractionCount / texts.length : 0;

  const exclaimCount = texts.filter((t) => t.includes("!")).length;
  const exclaimRate = texts.length > 0 ? exclaimCount / texts.length : 0;

  return { avgLen, capsRate, emojiRate, contractionRate, exclaimRate };
}

export function styleConstraintText(stats) {
  if (!stats || stats.avgLen === 0) return "";

  const parts = [];

  if (stats.avgLen <= 30) {
    parts.push("short (~" + stats.avgLen + " chars)");
  } else if (stats.avgLen <= 80) {
    parts.push("medium length (~" + stats.avgLen + " chars)");
  } else {
    parts.push("long (~" + stats.avgLen + " chars)");
  }

  if (stats.capsRate < 0.3) parts.push("mostly lowercase");
  else if (stats.capsRate > 0.7) parts.push("mostly capitalized");

  if (stats.emojiRate < 0.1) parts.push("rarely uses emoji");
  else if (stats.emojiRate > 0.5) parts.push("uses many emoji");

  if (stats.contractionRate > 0.3) parts.push("heavy contractions");

  return "This group writes " + parts.join(", ") + ".";
}
