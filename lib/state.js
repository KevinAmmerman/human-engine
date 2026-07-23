export const sessions = new Map();
export const routes = new Map();
export const epochByMessageId = new Map();
export const metaByMessageId = new Map();
export const latestEpochByChat = new Map();
export const memoryBySession = new Map();
export const observedBySession = new Map();
export const transcriptPeekBySession = new Map();

export const chatTypeBySession = new Map();
export const speakEpochBySession = new Map();
export const draftBySession = new Map();
export const metaBySession = new Map();

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
}

export function pushTranscriptPeek(sessionKey, line, max = 50) {
  if (!transcriptPeekBySession.has(sessionKey)) {
    transcriptPeekBySession.set(sessionKey, []);
  }
  const arr = transcriptPeekBySession.get(sessionKey);
  arr.push(line);
  if (arr.length > max) {
    arr.splice(0, arr.length - max);
  }
}
