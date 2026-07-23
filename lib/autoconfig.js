function was(value) {
  if (value === null || value === undefined || value === "") return "(unset)";
  return String(value);
}

export function planConfigChanges(cfg, openclawConfigJson) {
  const changes = [];
  const warnings = [];

  warnings.push(
    "Local engine: no API key needed \u2014 the plugin uses the host\u2019s built-in llm.complete.",
  );

  const targetGroups = cfg.targetGroups || [];

  for (const group of targetGroups) {
    const { channel, chatId } = group;
    if (!channel || !chatId) continue;
    const path = "channels." + channel + ".groups.\"" + chatId + "\".requireMention";
    const current = openclawConfigJson?.channels?.[channel]?.groups?.[chatId]?.requireMention;
    if (current !== false) {
      changes.push({
        path,
        from: was(current),
        to: "false",
        why: "the plugin must see all messages in the group to manage turn-taking",
      });
    }
  }

  const channelsInUse = new Set(targetGroups.map((g) => g.channel).filter(Boolean));
  if (channelsInUse.size === 0 && targetGroups.length > 0) {
    channelsInUse.add("telegram");
  }
  for (const channel of channelsInUse) {
    const path = "channels." + channel + ".streaming";
    const current = openclawConfigJson?.channels?.[channel]?.streaming;
    if (current !== "off") {
      changes.push({
        path,
        from: was(current),
        to: "off",
        why: "the plugin must own the final reply text (naturalization)",
      });
    }
  }

  if (cfg.gateway?.typingMode && cfg.gateway.typingMode !== "disabled") {
    const t = cfg.gateway.typingMode;
    if (t !== "speed" && t !== "disabled") {
      warnings.push("gateway.typingMode is \"" + t + "\" \u2014 recommended: \"speed\" or \"disabled\"");
    }
  }

  const ahc = openclawConfigJson?.hooks?.allowConversationAccess;
  if (ahc === undefined || ahc === null) {
    warnings.push("hooks.allowConversationAccess is not set \u2014 the plugin may not have access to conversation context");
  }

  warnings.push(
    "Telegram reminder: ensure @BotFather has Privacy Mode disabled for your bot " +
    "(or the plugin won't see group messages).",
  );

  const decideModel = cfg.decide?.model;
  const humanizeModel = cfg.humanize?.model;
  if (decideModel || humanizeModel) {
    const allowOverride = openclawConfigJson?.plugins?.entries?.["human-engine"]?.llm?.allowModelOverride;
    if (allowOverride !== true) {
      warnings.push(
        "decide.model / humanize.model is set but plugins.entries[\"human-engine\"].llm.allowModelOverride " +
        "is not true \u2014 the model setting may be ignored.",
      );
    }
  }

  const valid = changes.every((c) => {
    return c.path.startsWith("channels.");
  });
  if (!valid) {
    throw new Error("autoconfig: attempted to emit a non-scoped path");
  }

  const deduped = [];
  const seen = new Set();
  for (const c of changes) {
    if (!seen.has(c.path)) {
      seen.add(c.path);
      deduped.push(c);
    }
  }

  return { changes: deduped, warnings };
}

export function formatReport(plan) {
  const parts = [];
  if (plan.changes.length > 0) {
    parts.push("Autoconfig changes:");
    for (const c of plan.changes) {
      parts.push("  " + c.path + ": " + c.from + " \u2192 " + c.to + " \u2014 " + c.why);
    }
  }
  if (plan.warnings.length > 0) {
    parts.push("Warnings:");
    for (const w of plan.warnings) {
      parts.push("  \u26a0 " + w);
    }
  }
  if (parts.length === 0) {
    parts.push("Autoconfig: no changes needed.");
  }
  return parts.join("\n");
}
