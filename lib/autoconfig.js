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
}
