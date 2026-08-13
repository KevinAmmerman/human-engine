export function planConfigChanges(cfg, openclawConfigJson) {
  const changes = [];
  const warnings = [];

  warnings.push(
    "Local engine: no API key needed \u2014 the plugin uses the host\u2019s built-in llm.complete.",
  );

  const ahc = openclawConfigJson?.hooks?.allowConversationAccess;
  if (ahc === undefined || ahc === null) {
    warnings.push("hooks.allowConversationAccess is not set \u2014 the plugin may not have access to conversation context");
  }

  warnings.push(
    "Telegram reminder: ensure @BotFather has Privacy Mode disabled for your bot " +
    "(or the plugin won't see group messages).",
  );

  return { changes, warnings };
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
