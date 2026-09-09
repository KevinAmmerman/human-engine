export function warnStartupConfig(cfg, hostConfig, log) {
  const _log = log || { info() {}, warn() {}, debug() {} };

  _log.warn("Local engine: no API key needed \u2014 the plugin uses the host\u2019s built-in llm.complete.");

  const ahc = hostConfig?.hooks?.allowConversationAccess;
  if (ahc === undefined || ahc === null) {
    _log.warn("hooks.allowConversationAccess is not set \u2014 the plugin may not have access to conversation context");
  }

  _log.warn(
    "Telegram reminder: ensure @BotFather has Privacy Mode disabled for your bot " +
    "(or the plugin won't see group messages).",
  );

  const profiles = cfg.agentProfiles || {};
  const allowlist = Array.isArray(cfg.agents) ? cfg.agents : [];
  const profileIds = Object.keys(profiles);

  for (const id of profileIds) {
    const p = profiles[id] || {};
    if (!p.contactsPath) {
      _log.warn(`no contactsPath in agentProfiles["${id}"] — sender names fall back to member-XXXX and @-mention triggers by contact id stay off`);
    }
    if (!p.soulPath) {
      _log.warn(`no soulPath in agentProfiles["${id}"] — persona falls back to the global SOUL.md`);
    }
    if (allowlist.length > 0 && !allowlist.includes(id)) {
      _log.warn(`profile exists but agent not in agents allowlist — profile is inert`);
    }
  }

  if (allowlist.length > 0 && profileIds.length > 0) {
    for (const id of allowlist) {
      if (!profileIds.includes(id)) {
        _log.warn(`agent "${id}" runs on GLOBAL identity (no profile) — add an agentProfiles entry for full isolation`);
      }
    }
  }

  if (cfg.naturalize?.disableDM && cfg.socialLearning?.perSessionCard === false) {
    _log.warn("naturalize.disableDM + socialLearning.perSessionCard:false — voice card collapses per agent, so per-agent DM nuance is lost; double-check this combination");
  }
}
