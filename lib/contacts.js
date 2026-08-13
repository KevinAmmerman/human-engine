import fs from "node:fs";

const cache = { path: null, mtime: 0, map: new Map() };

function normalizeId(s) {
  return (s || "").trim().replace(/^@/, "").replace(/[\s-]/g, "");
}

export function parseContacts(text) {
  const map = new Map();
  for (const rawLine of (text || "").split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
    if (cells.length < 3) continue;
    if (/^[-:\s]+$/.test(cells[0])) continue;
    if (/^@?lid$/i.test(cells[0]) || /telefon/i.test(cells[1]) || /^name$/i.test(cells[2])) continue;
    const [lid, phone, name] = cells;
    if (!name) continue;
    const lidKey = normalizeId(lid);
    const phoneKey = normalizeId(phone);
    if (lidKey) map.set(lidKey, name);
    if (phoneKey) map.set(phoneKey, name);
  }
  return map;
}

export function loadContacts(filePath) {
  if (!filePath) return null;
  try {
    const st = fs.statSync(filePath);
    if (cache.path === filePath && cache.mtime === st.mtimeMs) {
      return cache.map;
    }
    const text = fs.readFileSync(filePath, "utf8");
    const map = parseContacts(text);
    cache.path = filePath;
    cache.mtime = st.mtimeMs;
    cache.map = map;
    return map;
  } catch {
    return null;
  }
}

export function listContactNames(map) {
  if (!map) return [];
  const names = new Set();
  for (const name of map.values()) {
    if (typeof name === "string" && name.trim()) names.add(name.trim());
  }
  return [...names];
}

export function resolveContactName(map, ...candidates) {
  if (!map) return null;
  for (const cand of candidates) {
    const key = normalizeId(typeof cand === "string" ? cand : "");
    if (key && map.has(key)) return map.get(key);
  }
  return null;
}

export function findAgentContactIds(map, agentName) {
  const ids = new Set();
  if (!map || !agentName) return ids;
  const needle = String(agentName).toLowerCase();
  for (const [id, name] of map.entries()) {
    if (String(name).toLowerCase().startsWith(needle)) ids.add(id);
  }
  return ids;
}
