export function defaultConfig() {
  return {
    enabled: true,
    agents: [],
    agentName: "OpenClaw",
    soulPath: "",
    soulAutoEnhance: true,
    antiTell: true,
    styleStats: true,
    socialLearning: {
      enabled: true,
      perSessionCard: false,
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
      model: "",
      temperature: 0.2,
    },
    humanize: {
      model: "",
      maxBubbles: 5,
      temperature: 0.9,
    },
    timing: {
      typingWpm: 40,
      maxTypingMs: 60000,
      nightMode: true,
    },
  };
}

export function resolveConfig(api) {
  const cfg = {
    ...defaultConfig(),
    ...(api?.pluginConfig ??
      api?.config?.plugins?.entries?.["human-engine"]?.config ??
      {}),
  };
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
