const CHANNEL_RE = /:(whatsapp|telegram|discord|signal|slack|matrix):/;

// Key-hygiene for state-dir filenames: any string → safe file/segment chars.
export function pathSafe(s) {
  if (!s || typeof s !== "string") return "_";
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Composite scope `agentId::sessionKey`. This is the SINGLE source of truth
// for splitting that pair (Plan 014) — other modules must import it instead of
// hand-splitting with indexOf("::")/lastIndexOf("::").
export function parseAgentScope(composite) {
  if (typeof composite !== "string" || !composite) return null;
  const last = composite.lastIndexOf("::");
  if (last < 0) return null;
  return { agentId: composite.slice(0, last), sessionKey: composite.slice(last + 2) };
}

// agent:<agentId>:<rest…> — rest ist "whatsapp:group:1203@g.us" o. ä.
export function parseSessionKey(sk) {
  if (typeof sk !== "string" || !sk.startsWith("agent:")) return null;
  const cut = sk.indexOf(":");
  const rest = sk.slice(cut + 1);
  const agentId = rest.slice(0, rest.indexOf(":")) || null;
  return { agentId, rest, raw: sk };
}

export function agentIdFromSessionKey(sk) {
  const p = parseSessionKey(sk);
  return p ? p.agentId : null;
}

// Returns { agentId, channel, kind, rest } or null.
// kind: zweites Segment nach dem Channel ("direct"/"group"/…), falls vorhanden.
export function parseScope(sk) {
  if (typeof sk !== "string" || !sk.startsWith("agent:")) return null;
  const parts = sk.split(":");          // ["agent", agentId, channel, kind, …rest]
  if (parts.length < 3) return { agentId: parts[1] || null, channel: null, kind: null, rest: null };
  const [, agentId, channel, kind = null, ...restArr] = parts;
  return { agentId: agentId || null, channel, kind, rest: restArr.length ? restArr.join(":") : null };
}

export function isChatSession(sk) {
  if (typeof sk !== "string") return false;
  if (sk.includes(":heartbeat")) return false;
  return CHANNEL_RE.test(sk);
}

export function isGroupSessionKey(sk) {
  return typeof sk === "string" && sk.includes(":group:");
}

// Identisch zu naturalize/dm-proactive isDmSession: chat-channel, kein
// heartbeat, keine Gruppe.
export function isDmSessionKey(sk) {
  if (typeof sk !== "string") return false;
  if (sk.includes(":heartbeat")) return false;
  if (sk.includes(":group:")) return false;
  return CHANNEL_RE.test(sk);
}

// naturalize.js TTS-Kanal: alles NACH "agent:<agentId>:" unverändert.
export function channelAndRestFromSessionKey(sk) {
  if (typeof sk !== "string" || !sk.startsWith("agent:")) return null;
  return sk.split(":").slice(2).join(":") || null;
}
