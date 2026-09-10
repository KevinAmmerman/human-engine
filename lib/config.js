import { agentIdFromSessionKey } from "./scope.js";

export function defaultConfig() {
  return {
    enabled: true,
    agents: [],
    agentName: "OpenClaw",
    agentAliases: [],
    language: "de",
    soulPath: "",
    contactsPath: "",
    agentProfiles: {},
    soulAutoEnhance: true,
    antiTell: true,
    styleStats: true,
    selfVoice: {
      enabled: false,
      refreshMinutes: 60,
      minVolume: 30,
    },
    socialLearning: {
      enabled: true,
      perSessionCard: true,
      refreshEvery: 5,
      refreshMinutes: 0,
      window: 100,
      logRequests: false,
    },
    socialMemory: {
      enabled: true,
      extractEvery: 25,
      extractMinutes: 0,
      maxPeople: 50,
      recallLimit: 800,
      personStore: false,
      schemaV2: false,
    },
    autoconfig: false,
    decide: {
      temperature: 0.2,
      v2Contract: false,
    },
    humanize: {
      maxBubbles: 5,
      temperature: 0.9,
    },
    timing: {
      typingWpm: 40,
      maxTypingMs: 60000,
      maxBubbleGapMs: 3000,
      nightMode: true,
    },
    naturalize: {
      disableDM: false,
      speakEpochTtlMs: 300000,
    },
    proactive: {
      enabled: false,
      shadow: true,
      budgetPerDay: 2,
      recognitionBudgetPerDay: 1,
      returnGreetingBudgetPerDay: 1,
      threadCallbackMinAgeHours: 20,
      minGapMinutes: 180,
      quietStart: "23:00",
      quietEnd: "07:00",
      probability: 0.5,
      cooldownBaseMinutes: 180,
      triggers: {
        unansweredQuestion: true,
        stalledExchange: true,
        contextMatch: true,
        followUpCommitment: true,
        outcomeCelebration: true,
        checkInOnPromise: true,
        returnGreeting: false,
        threadCallback: false,
      },
    },
    dmProactive: {
      agents: [],
      enabled: false,
      shadow: true,
      budgetPerDay: 2,
      minGapMinutes: 180,
      quietStart: "23:00",
      quietEnd: "07:00",
      careBudgetPerDay: 1,
      dayFitReduceHours: 4,
      dayFitPauseHours: 12,
      dayFitActivityPath: "",
      inferredCapPerDay: 2,
    },
    mood: {
      enabled: false,        // master switch, default OFF (shadow-first)
      groupsEnabled: false,  // second switch: group mood, default OFF
      groupsRefreshEvery: 10,// appraisal alle N empfangenen Gruppen-Nachrichten
      refreshEvery: 5,       // appraisal alle N empfangenen DM-Nachrichten
      refreshMinutes: 0,     // 0 = nur message-count-basiert
      decayHours: 6,         // ohne Update Richtung neutral zerfallen
      maxShiftPerUpdate: 1,  // |Δvalence|/|Δenergy| pro Appraisal geklemmt
    },
    threads: {
      enabled: false,            // master switch, default OFF (zero files, zero injection)
      absenceThresholdHours: 24, // Gap > diesem Wert → Absence-Kontextzeile
      topicExpiryDays: 14,       // openTopics älter als das → verfallen
    },
  };
}

const NESTED_KEYS = ["selfVoice", "socialLearning", "socialMemory", "decide", "humanize", "timing", "naturalize", "proactive", "dmProactive", "mood", "threads"];

export function resolveConfig(api) {
  const overrides =
    api?.pluginConfig ??
    api?.config?.plugins?.entries?.["human-engine"]?.config ??
    {};
  const cfg = { ...defaultConfig(), ...overrides };
  for (const key of NESTED_KEYS) {
    if (overrides[key] && typeof overrides[key] === "object") {
      cfg[key] = { ...(defaultConfig()[key] || {}), ...overrides[key] };
    }
  }
  return cfg;
}

export function isEnabled(cfg) {
  return cfg.enabled === true;
}

export function isScopedAgent(cfg, agentId) {
  const { agents } = cfg;
  if (!Array.isArray(agents) || agents.length === 0) return true;
  if (typeof agentId !== "string" || agentId.length === 0) return false;
  return agents.includes(agentId);
}

// Plan 002: per-agent profile overlay. Resolution order per key:
//   agentProfiles[agentId][key]  →  global cfg[key]  →  undefined
// Nested objects inside a profile merge ONE level over the global
// object (same semantics as resolveConfig's NESTED_KEYS), so a profile
// override like { proactive: { shadow: false } } keeps the global
// budgetPerDay default. The allowlist (cfg.agents) is NOT affected —
// profiles only override values, they never widen scoping.
const PROFILE_MERGE_KEYS = NESTED_KEYS;

export function resolveAgentConfig(cfg, agentId) {
  if (!agentId || typeof agentId !== "string") return cfg;
  const profile = cfg?.agentProfiles?.[agentId];
  if (!profile || typeof profile !== "object") return cfg;
  const out = { ...cfg };
  for (const [k, v] of Object.entries(profile)) {
    if (PROFILE_MERGE_KEYS.includes(k) && v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = { ...(cfg[k] || {}), ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Convenience: resolve for a session context. Falls back to the global
// cfg when the sessionKey carries no agentId (Plan 536-class contexts).
export function resolveAgentConfigForSession(cfg, sessionKey, ctxAgentId) {
  return resolveAgentConfig(cfg, ctxAgentId || agentIdFromSessionKey(sessionKey));
}

// Plan 005 (adopted from Plan 586): dmProactive.agents OVERRIDES the
// global allowlist for the DM-proactive subtree only. Non-empty list
// wins; otherwise fall back to the global cfg.agents (backward compat).
export function dmProactiveAgents(cfg) {
  const list = cfg?.dmProactive?.agents;
  if (Array.isArray(list) && list.length > 0) return list;
  return Array.isArray(cfg?.agents) ? cfg.agents : [];
}

export function isScopedDmAgent(cfg, agentId) {
  return isScopedAgent({ agents: dmProactiveAgents(cfg) }, agentId);
}
