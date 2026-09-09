import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ANTI_TELL_BLOCK } from "./anti-tell.js";
import { computeStyleStats, styleConstraintText } from "./style-stats.js";
import { transcriptPeekBySession } from "./state.js";

const SOUL_CACHE_TTL = 5000;
const soulCacheByPath = new Map();

function readSoul(soulPath) {
  const resolved = soulPath || path.join(os.homedir(), ".openclaw", "SOUL.md");
  if (!resolved) return null;
  try {
    const st = fs.statSync(resolved);
    const hit = soulCacheByPath.get(resolved);
    if (hit && hit.mtime === st.mtimeMs) {
      return hit.content;
    }
    const content = fs.readFileSync(resolved, "utf8").trim();
    soulCacheByPath.set(resolved, { mtime: st.mtimeMs, content: content || null });
    if (soulCacheByPath.size > 32) soulCacheByPath.delete(soulCacheByPath.keys().next().value);
    return soulCacheByPath.get(resolved).content;
  } catch {
    return null;
  }
}

const MEMORY_LABEL = "What you know about the people here (from memory):";
let voiceCardGetter = null;

export function setVoiceCardGetter(fn) {
  voiceCardGetter = fn;
}

export function buildSoulPrompt(cfg) {
  const soul = readSoul(cfg.soulPath);
  return soul || null;
}

export function buildPersonaPrompt(cfg, sessionKey) {
  const soul = readSoul(cfg.soulPath);
  const parts = [];
  if (soul) parts.push(soul);
  const voiceCard = typeof voiceCardGetter === "function" ? voiceCardGetter(sessionKey) : null;
  if (voiceCard) parts.push(voiceCard);
  if (cfg.antiTell !== false) parts.push(ANTI_TELL_BLOCK);
  if (cfg.styleStats !== false && sessionKey) {
    const peek = transcriptPeekBySession.get(sessionKey);
    if (peek && peek.length >= 10) {
      const stats = computeStyleStats(peek);
      const constraint = styleConstraintText(stats);
      if (constraint) parts.push(constraint);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export function buildPersonaPromptWithMemory(cfg, state, sessionKey) {
  const persona = buildPersonaPrompt(cfg, sessionKey);
  const mem = state.memoryBySession?.get(sessionKey);
  const parts = [];
  if (persona) parts.push(persona);
  if (mem) {
    parts.push(MEMORY_LABEL + "\n" + mem);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}
