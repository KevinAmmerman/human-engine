import fs from "node:fs";
import path from "node:path";

const MAX_LINES = 400;
const KEEP_LINES = 200;

function pathSafe(s) {
  if (!s || typeof s !== "string") return "_";
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function createObservedStore({ stateDir, log }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const lineCount = new Map(); // file -> in-memory line count
  const readCache = new Map(); // file -> { mtimeMs, size, out }

  function fileFor(sessionKey) {
    return path.join(stateDir, "observed", pathSafe(sessionKey) + ".jsonl");
  }

  function countLines(file) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      return raw.split("\n").filter(Boolean).length;
    } catch (err) {
      if (err?.code !== "ENOENT") {
        _log.warn(`human-engine: observed-store: count error for ${file}: ${err?.message || err}`);
      }
      return 0;
    }
  }

  function appendObserved(sessionKey, row = {}) {
    try {
      if (!sessionKey || !row || !row.text) return;
      const { speaker, text, ts } = row;
      const file = fileFor(sessionKey);
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const record = { speaker: String(speaker || ""), text, ts: typeof ts === "number" ? ts : Date.now() };
      fs.appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
      const count = (lineCount.get(file) ?? countLines(file)) + 1;
      if (count > MAX_LINES) {
        rotate(file);
        lineCount.set(file, countLines(file));
      } else {
        lineCount.set(file, count);
      }
    } catch (err) {
      _log.warn(`human-engine: observed-store: append error for ${sessionKey}: ${err?.message || err}`);
    }
  }

  function rotate(file) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const lines = raw.split("\n");
      if (lines.length <= MAX_LINES + 1) return;
      const keep = lines.slice(-(KEEP_LINES + 1)).join("\n");
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, keep, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      _log.warn(`human-engine: observed-store: rotation error for ${file}: ${err?.message || err}`);
    }
  }

  function readObserved(sessionKey, last = 20) {
    const n = Math.max(1, last);
    try {
      const file = fileFor(sessionKey);
      let st = null;
      try { st = fs.statSync(file); } catch { return []; }
      const hit = readCache.get(file);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.out.slice(-n);

      const raw = fs.readFileSync(file, "utf8");
      const out = [];
      const lines = raw.split("\n");
      const tail = lines.slice(-(n * 2));
      for (const line of tail) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          if (row && typeof row.text === "string") {
            out.push({ speaker: typeof row.speaker === "string" ? row.speaker : "", text: row.text, ts: row.ts });
          }
        } catch {
          _log.warn(`human-engine: observed-store: skipping corrupt line in ${sessionKey}: ${String(line).slice(0, 80)}`);
        }
      }
      readCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, out });
      if (readCache.size > 128) readCache.delete(readCache.keys().next().value);
      return out.slice(-n);
    } catch (err) {
      if (err?.code !== "ENOENT") {
        _log.warn(`human-engine: observed-store: read error for ${sessionKey}: ${err?.message || err}`);
      }
      return [];
    }
  }

  return { appendObserved, readObserved };
}
