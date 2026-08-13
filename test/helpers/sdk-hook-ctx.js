export function makeReplyDispatchCtx({ dispatcher } = {}) {
  // OpenClaw 2026.6.11: plugin-sdk/hook-types-YIiTro9N.d.ts:594-604 (PluginHookReplyDispatchContext),
  // construction at dist/dispatch-DXwxohlw.js:1513-1520 — {cfg, dispatcher, abortSignal, onReplyStart,
  // recordProcessed, markIdle}. No agentId, no sessionKey.
  return {
    cfg: {},
    dispatcher: dispatcher || null,
    abortSignal: undefined,
    onReplyStart() {},
    recordProcessed() {},
    markIdle() {},
  };
}

export function makeReplyDispatchEvent({ sessionKey, sendPolicy = "allow" } = {}) {
  // sessionKey + sendPolicy travel on the EVENT (hook-types d.ts:589-593), not the ctx.
  return { sessionKey, sendPolicy };
}

export function makeReplyPayloadCtx({ sessionKey } = {}) {
  // PluginHookMessageContext (hook-types d.ts:143-196): has sessionKey, NO agentId.
  return { sessionKey, channelId: "120363@g.us", accountId: "default" };
}

export function makeMessageReceivedCtx({ sessionKey, senderId } = {}) {
  // message-hook-mappers-kwzGSryO.js:84-102 (toPluginMessageContext): channelId/accountId/conversationId/
  // sessionKey?/senderId? — no isGroup, no agentId, no senderName.
  return {
    channelId: "120363@g.us",
    accountId: "default",
    conversationId: "120363@g.us",
    sessionKey,
    senderId,
  };
}
