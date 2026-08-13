export function defaultConfig() {
  return {
    enabled: true,
    agents: [],
    agentName: "OpenClaw",
    soulPath: "",
    contactsPath: "",
    soulAutoEnhance: true,
    antiTell: true,
    styleStats: true,
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
    },
    autoconfig: false,
    decide: {
      temperature: 0.2,
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
      speakEpochTtlMs: 300000,
    },
    proactive: {
      enabled: false,
      shadow: true,
      budgetPerDay: 2,
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
      },
    },
  };
}

const NESTED_KEYS = ["socialLearning", "socialMemory", "decide", "humanize", "timing", "naturalize", "proactive"];

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
