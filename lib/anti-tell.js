export const ANTI_TELL_BLOCK = [
  "Writing constraints (HARD RULES):",
  "",
  "NEVER use:",
  "- Em-dash (—) — use a comma or period instead.",
  "- Bullet lists, numbered lists, or any markdown formatting.",
  "- Summary or closing paragraphs ('In conclusion', 'To summarize', 'Overall').",
  "- Sign-offs or customer-service phrases ('Let me know if you have questions', 'How can I help you?').",
  "- Hedging chains ('It might be worth considering', 'I think perhaps we could').",
  "- The 'It\\'s not X, it\\'s Y' correction pattern.",
  "- Rule-of-three lists, 'Firstly/Secondly/Moreover', 'Not only… but also'.",
  "- 'Certainly!' or other exclamatory affirmations.",
  "- These words: delve, tapestry, furthermore, navigate, landscape, realm, paramount, meticulous, underscore, leverage, utilize, facilitate, showcase.",
  "",
  "DO:",
  "- Write like a real person in this chat — match group tone.",
  "- Use contractions, fragments, react-first ('lol', 'nice', 'ja genau').",
  "- Echo vocabulary the group uses.",
  "- Self-correct or admit uncertainty when appropriate ('wait', 'nvm', 'hmm').",
  "- Be concise — one or two short sentences.",
].join("\n");

const BANNED_LEXICON = [
  "delve", "tapestry", "furthermore", "navigate", "landscape",
  "realm", "paramount", "meticulous", "underscore", "leverage",
  "utilize", "facilitate", "showcase",
];

export function detectTells(text) {
  const tells = [];

  if (text.includes("\u2014")) tells.push("em-dash");

  if (/^(?:[\s]*[-*+]\s|\s*\d+[.)]\s)/m.test(text)) tells.push("list");

  if (text.includes("**")) tells.push("bold-markdown");

  if (/^#+\s/m.test(text)) tells.push("header");

  for (const word of BANNED_LEXICON) {
    if (new RegExp("\\b" + word + "\\b", "i").test(text)) {
      tells.push("banned-word:" + word);
    }
  }

  if (/It'?s\s+not\s+.+?,?\s+it'?s\s+/i.test(text)) tells.push("its-not-its");

  if (/Not only[\s\S]{0,30}but also/i.test(text)) tells.push("not-only-but-also");

  if (/\b(In conclusion|To summarize|Overall)[,\s]/i.test(text)) tells.push("summary-closing");

  if (/\b(Firstly|Secondly|Thirdly|Moreover)\b/i.test(text)) tells.push("enumeration");

  if (/^Certainly!/m.test(text)) tells.push("certainly-exclamation");

  if (/How can I help you\?/i.test(text)) tells.push("customer-service");

  return tells;
}

const META_VERB =
  /(?:claims|says|said|is asking|asked|wants|joked|is joking|proposes|is proposing|shared|sent|posted|is being|is clearly|is obviously|'s message|his message|her message)/i;

const NARRATOR_PHRASE =
  /(?:I should|I need to|I'll respond|Let me respond|Keep it|Not defensive|deadpan|countershot|playful way|warm underneath|banter)\b/i;

const EN_FUNCTION_WORD =
  /\b(?:the|this|that|these|those|and|but|or|my|his|her|its|your|our|their|i|he|she|it|we|they|you|me|him|them|us|am|is|are|was|were|be|been|being|will|would|should|could|must|can|do|does|did|have|has|had|to|of|for|with|on|in|at|by|from|as|so|then|now|just|not|no|yes|if|about|very|really|actually)\b/gi;

const GERMAN_STARTER =
  /^(?:Per|Und|Das|Ich|Du|Wir|Also|Ja|Nee|Haha|Okay|Ok|Nicht|Ein|Eine|Der|Die|Den|Wer|Was|Wo|Wann|Warum|Wie|Hori|Yuki)\b|^\p{Extended_Pictographic}/iu;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function englishDensity(chunk) {
  const words = (chunk.trim().match(/\S+/g) || []);
  if (words.length === 0) return 0;
  return (chunk.match(EN_FUNCTION_WORD) || []).length / words.length;
}

function countSignals(chunk, memberNames) {
  let strong = 0;
  let weak = 0;
  const names = (memberNames || []).filter((n) => typeof n === "string" && n.trim());
  const hasName = names.some((n) => new RegExp("\\b" + escapeRegExp(n.trim()) + "\\b", "i").test(chunk));
  const hasNameVerb = names.some((n) => {
    const name = escapeRegExp(n.trim());
    const re = new RegExp(
      "\\b" + name + "\\b[^.!?]{0,40}?(?:" + META_VERB.source + ")|(?:" + META_VERB.source + ")[^.!?]{0,40}?\\b" + name + "\\b",
      "i",
    );
    return re.test(chunk) && englishDensity(chunk) > 0;
  });
  if (NARRATOR_PHRASE.test(chunk)) strong += 1;
  if (hasNameVerb) strong += 1;
  if (hasName) weak += 1;
  if (englishDensity(chunk) > 0.3) weak += 1;
  return { strong, weak };
}

function matchesSignals(chunk, memberNames) {
  const s = countSignals(chunk, memberNames);
  return s.strong >= 1 || s.weak >= 2;
}

function isAcceptableKept(text, memberNames) {
  const t = (text || "").trim();
  if (t.length < 20) return false;
  if (countSignals(t, memberNames).strong >= 1) return false;
  return true;
}

function findInlineSeam(text, memberNames) {
  let result = null;
  let prevEnd = -1;
  const re = /[.!?]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const idx = m.index;
    const sentence = text.slice(prevEnd + 1, idx + 1).trim();
    const remainder = text.slice(idx + 1).replace(/^[\s\u2026\u2013\u2014]+/, "");
    if (matchesSignals(sentence, memberNames) && GERMAN_STARTER.test(remainder)) {
      result = remainder;
    }
    prevEnd = idx;
  }
  return result;
}

export function stripMetaCommentary(text, memberNames = []) {
  if (typeof text !== "string" || !text.trim()) return { text, stripped: false, commentary: false };

  const commentary = matchesSignals(text, memberNames);

  const paras = text.split(/\n\s*\n/);
  if (
    paras.length >= 2 &&
    matchesSignals(paras[0], memberNames) &&
    !matchesSignals(paras[paras.length - 1], memberNames)
  ) {
    let keptStart = paras.length;
    for (let i = paras.length - 1; i >= 0; i--) {
      if (!matchesSignals(paras[i], memberNames)) keptStart = i;
      else break;
    }
    if (keptStart < paras.length) {
      const kept = paras.slice(keptStart).join("\n\n").trim();
      if (isAcceptableKept(kept, memberNames)) return { text: kept, stripped: true, commentary, strong: countSignals(text, memberNames).strong };
    }
  }

  const seam = findInlineSeam(text, memberNames);
  if (seam != null) {
    const kept = seam.trim();
    if (isAcceptableKept(kept, memberNames)) return { text: kept, stripped: true, commentary, strong: countSignals(text, memberNames).strong };
  }

  return { text, stripped: false, commentary, strong: countSignals(text, memberNames).strong };
}
