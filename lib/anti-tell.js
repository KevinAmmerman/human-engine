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
