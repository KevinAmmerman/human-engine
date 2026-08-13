export const memoryBySession = new Map();
export const senderBySession = new Map();
export const observedBySession = new Map();
export const transcriptPeekBySession = new Map();

export const chatTypeBySession = new Map();
export const speakEpochBySession = new Map();

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

export function getTranscriptPeek(sessionKey, last = 20) {
  const arr = transcriptPeekBySession.get(sessionKey) || [];
  return arr.slice(-last).map((line) => {
    const m = /^\[([^\]]*)\]\s([\s\S]*)$/.exec(line);
    return m ? { speaker: m[1], text: m[2] } : { speaker: "", text: line };
  });
}
