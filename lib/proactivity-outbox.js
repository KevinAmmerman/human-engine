import fs from "node:fs";
import path from "node:path";

const FLUSH_MS = 2000;
const CAP = 256;

// Shared per-scope "last proactive outbound" store. Both `proactive` and
// `initiative` record here after a successful LIVE send so the two engines
// share a single per-scope minimum-gap budget (no double-pinging a room).
// Fail-open by design: any read error returns 0 and never throws.
export function createProactivityOutbox({ stateDir, log, now }) {
  const _log = log || { info() {}, warn() {}, debug() {} };
  const _now = typeof now === "function" ? now : () => Date.now();
  const file = path.join(stateDir || ".", "proactivity-outbox.json");
  const cache = new Map();
  let loaded = false;
  let dirty = false;
  let flushTimer = null;

  function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
    try { fs.chmodSync(dir, 0o700); } catch {}
  }

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && parsed?.scopes && typeof parsed.scopes === "object") {
        for (const [scope, v] of Object.entries(parsed.scopes)) {
          if (v && typeof v?.lastAt === "number") cache.set(scope, v);
        }
      }
    } catch {}
  }

  function evictToCap() {
    if (cache.size <= CAP) return;
    const byOldest = [...cache.entries()].sort((a, b) => (a[1].lastAt || 0) - (b[1].lastAt || 0));
    const excess = cache.size - CAP;
    for (let i = 0; i < excess; i++) cache.delete(byOldest[i][0]);
  }

  function writeFile() {
    dirty = false;
    ensureDir(path.dirname(file));
    const tmp = file + ".tmp";
    const data = { version: 1, scopes: Object.fromEntries(cache.entries()) };
    try {
      fs.writeFileSync(tmp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      _log.warn(`human-engine: proactivity-outbox: write error: ${err?.message || err}`);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  function scheduleFlush() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (dirty) writeFile();
    }, FLUSH_MS);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }

  function record(scope, source, ts) {
    if (!scope) return;
    load();
    cache.set(scope, { lastAt: ts ?? _now(), source: source || "initiative" });
    evictToCap();
    scheduleFlush();
  }

  function lastOutbound(scope) {
    load();
    return cache.get(scope)?.lastAt || 0;
  }

  function stop() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (dirty) writeFile();
  }

  return { lastOutbound, record, stop, __stateForTests: () => ({ cache, file, loaded }) };
}
