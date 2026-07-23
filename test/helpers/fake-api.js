export function createFakeApi() {
  const hooks = {};
  let loggerEnabled = false;

  const api = {
    on(name, handler) {
      if (!hooks[name]) hooks[name] = [];
      hooks[name].push(handler);
    },
    get logger() {
      return loggerEnabled
        ? { info() {}, warn() {}, debug() {}, error() {} }
        : undefined;
    },
    setLoggerEnabled(v) {
      loggerEnabled = v;
    },
    pluginConfig: {},
    config: {},
  };

  function getHandlers(name) {
    return hooks[name] || [];
  }

  function clear() {
    Object.keys(hooks).forEach((k) => delete hooks[k]);
  }

  return { api, getHandlers, clear };
}
