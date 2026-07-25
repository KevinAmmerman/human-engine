export function buildExtractPrompt({ transcript }) {
  const list = (transcript || []).slice(-100);
  const transcriptBlock = list
    .map((t) => JSON.stringify({ speaker: t.speaker || "?", text: t.text || "" }))
    .join("\n");

  const systemPrompt = [
    "Analyze how this group talks. Return STRICT JSON only, no other text.",
    "Fields: {",
    '  "summary": "one-line description of group style",',
    '  "register": { "formality": 1-10, "warmth": 1-10, "casing": "lowercase|mixed|proper" },',
    '  "style": { "length": "short|medium|long", "formatting": "clean|markdown|none", "emoji": "few|some|many" },',
    '  "lexicon": ["notable phrase 1", "notable phrase 2"],',
    '  "banned_phrases": ["phrase to avoid 1"],',
    '  "humor": "dry|silly|none|dark|warm",',
    '  "norms": ["norm 1", "norm 2"],',
    '  "in_jokes": ["joke 1"]',
    "}",
  ].join("\n");

  return { systemPrompt, userMessage: transcriptBlock };
}

export function renderPromptBlock(profile) {
  if (!profile || !profile.summary) return "";

  const parts = [];
  parts.push("Voice profile of this group: " + profile.summary);

  if (profile.register) {
    const r = profile.register;
    const tags = [];
    if (r.formality) tags.push("formality: " + r.formality + "/10");
    if (r.warmth) tags.push("warmth: " + r.warmth + "/10");
    if (r.casing) tags.push("casing: " + r.casing);
    if (tags.length > 0) parts.push("Register: " + tags.join(", ") + ".");

    if (r.formality != null && r.formality < 4) parts.push("Very casual — match their informality.");
    if (r.casing === "lowercase") parts.push("Write in lowercase like they do.");
  }

  if (profile.style) {
    const s = profile.style;
    const styleTags = [];
    if (s.length) styleTags.push(s.length);
    if (s.emoji) styleTags.push(s.emoji + " emoji");
    if (styleTags.length > 0) parts.push("Style: " + styleTags.join(", ") + ".");
  }

  if (profile.lexicon && profile.lexicon.length > 0) {
    parts.push("They use: " + profile.lexicon.slice(0, 5).join(", ") + ".");
  }

  if (profile.norms && profile.norms.length > 0) {
    parts.push("Norms: " + profile.norms.slice(0, 3).join("; ") + ".");
  }

  return parts.join("\n");
}

export function buildMemoryExtractPrompt({ existingProfile, newMessages }) {
  const systemPrompt = [
    "You maintain person-centric memory for a group chat. Given the existing profile JSON and new messages, return the UPDATED profile as STRICT JSON:",
    '{ "people": { "<name>": { "facts": [...], "preferences": [...], "situation": "..." } } }',
    "Rules: attribute each fact to the person it is ABOUT (not who said it); keep only durable facts (preferences, history, situation, relationships, plans); drop small talk; never invent; compact duplicates.",
  ].join("\n");

  const userMessage = [
    "Existing profile:",
    existingProfile || "{}",
    "",
    "New messages:",
    ...(newMessages || []).map(m => "[" + m.speaker + "] " + m.text),
  ].join("\n");

  return { systemPrompt, userMessage };
}

export function buildEnhancePrompt({ personaSeed }) {
  const systemPrompt = [
    "You are a persona expansion engine. Expand the given seed into a full character description.",
    "Write in second person ('You are…').",
    "Include: core voice and tone, mannerisms, speech patterns, response tendencies, boundaries.",
    "HARD RULE: never use an em-dash (\u2014) anywhere in the output.",
    "",
    "Seed:",
    personaSeed || "(empty seed)",
  ].join("\n");

  return { systemPrompt };
}

export function buildDecidePrompt({ transcript, persona, voiceCard, agentName }) {
  const systemLines = [
    `You are the turn-taking conscience of ${agentName || "the agent"}, a member of this group chat.`,
    "Decide if the agent speaks now or stays silent.",
    "Speak when directly addressed, when asked something it can answer, or when it clearly adds value.",
    `Lines from ${agentName || "the agent"} are your own previous messages. If the newest message is a reply or follow-up to one of them (question, confirmation, reaction to what you said), lean SPEAK.`,
    "Stay silent during side chatter, already-answered questions, or when speaking would be noise — humans ignore most group messages.",
    'Answer with EXACTLY one token: SPEAK or STAY_SILENT.',
  ];
  if (persona) systemLines.push("\n" + persona);
  if (voiceCard) systemLines.push("\n" + voiceCard);
  const systemPrompt = systemLines.join("\n");

  const transcriptLines = (transcript || []).slice(-20);
  const userMessage = transcriptLines.map((t) => `[${t.speaker || "?"}] ${t.text}`).join("\n") || "(no recent messages)";

  return { systemPrompt, userMessage };
}

export function buildSplitPrompt({ draft, transcript, persona, voiceCard, styleConstraints, maxBubbles }) {
  const antiTell = [
    'BANNED: em-dash (—), bullet lists, numbered lists, headers, markdown formatting.',
    'BANNED: the words "delve", "furthermore", "additionally", "thus", "therefore".',
    'BANNED: the "It\'s not X, it\'s Y" correction pattern.',
    "BANNED: rule-of-three lists, summary endings, sign-offs like 'Let me know if you have questions'.",
    'BANNED: "How can I help you?" or similar customer-service phrases.',
    "ENCOURAGED: match the group's casing and register (lowercase when they do, proper case when they do).",
    "ENCOURAGED: contractions, fragments, react-first bubbles ('lol', 'nice', 'ja genau').",
    "ENCOURAGED: echo of speaker vocabulary.",
  ].join("\n");

  const parts = [
    antiTell,
    ...(persona ? [persona] : []),
    ...(voiceCard ? [voiceCard] : []),
    ...(styleConstraints ? [styleConstraints] : []),
    `Split the reply into 1\u2013${maxBubbles || 5} chat messages the way a person fragments a thought. 1\u20132 short sentences each. First may be a pure reaction.`,
    'Return STRICT JSON: {"messages": ["...", ...]}, nothing else.',
  ];
  const systemPrompt = parts.join("\n\n");

  const transcriptLines = (transcript || []).slice(-10);
  const userMessage =
    "Draft: " + (draft || "") +
    "\n\nContext:\n" +
    (transcriptLines.map((t) => `[${t.speaker || "?"}] ${t.text}`).join("\n") || "(none)");

  return { systemPrompt, userMessage };
}
