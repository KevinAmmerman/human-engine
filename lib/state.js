export const memoryBySession = new Map();
export const senderBySession = new Map();
export const observedBySession = new Map();
export const transcriptPeekBySession = new Map();
export const peekMetaBySession = new Map(); // sessionKey → [{ts}] index-aligned with transcriptPeekBySession

export const chatTypeBySession = new Map();
export const speakEpochBySession = new Map();
export const replyContextQueue = new Map(); // `${sessionKey}|${senderId}` → [{body, sender, textNorm, ts}]
export const mediaBySession = new Map(); // sessionKey → { hasMedia, mediaKind }
export const replyTargetBySession = new Map(); // sessionKey → { quotedName, replyToAgent, textHead, ts }

export function capMap(map, max = 4096) {
  if (map.size <= max) return;
  const keys = [...map.keys()];
  const toDelete = map.size - max;
  for (let i = 0; i < toDelete; i++) {
    map.delete(keys[i]);
  }
}

export function pushObserved(sessionKey, entry, max = 100) {
  if (!observedBySession.has(sessionKey)) {
    observedBySession.set(sessionKey, []);
  }
  const arr = observedBySession.get(sessionKey);
  arr.push(entry);
  if (arr.length > max) {
    arr.splice(0, arr.length - max);
  }
  capMap(observedBySession, 4096);
}

export function pushTranscriptPeek(sessionKey, line, max = 50, ts) {
  if (!transcriptPeekBySession.has(sessionKey)) {
    transcriptPeekBySession.set(sessionKey, []);
    peekMetaBySession.set(sessionKey, []);
  }
  const arr = transcriptPeekBySession.get(sessionKey);
  const meta = peekMetaBySession.get(sessionKey);
  arr.push(line);
  meta.push(typeof ts === "number" ? ts : null);
  if (arr.length > max) {
    const drop = arr.length - max;
    arr.splice(0, drop);
    meta.splice(0, drop);
  }
  capMap(transcriptPeekBySession, 4096);
  capMap(peekMetaBySession, 4096);
}

export function getTranscriptPeek(sessionKey, last = 20) {
  const arr = transcriptPeekBySession.get(sessionKey) || [];
  const meta = peekMetaBySession.get(sessionKey) || [];
  const lines = arr.slice(-last);
  const metas = meta.slice(-last);
  return lines.map((line, i) => {
    const m = /^\[([^\]]*)\]\s([\s\S]*)$/.exec(line);
    const entry = m ? { speaker: m[1], text: m[2] } : { speaker: "", text: line };
    const ts = metas[i];
    if (typeof ts === "number") entry.ts = ts;
    return entry;
  });
}
