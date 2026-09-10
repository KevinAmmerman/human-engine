import { createInitiativeStore } from "./initiative-store.js";

// Initiative — phase 0 shell.
//
// This module is the Phase-0 skeleton for the proactive task & memory engine
// (plan 613). It only wires the durable per-agent x scope store and exposes
// the hook surface. Every exported function is a NO-OP unless
// cfg.initiative.enabled === true (default false), so with the feature off it
// creates no files, injects no context, and changes no behavior.
//
// Later phases add: capture/extract of tasks & directives, context injection,
// the per-scope tick that decides on due tasks, dispatch, and parity rows.
export function createInitiative({ cfg, stateDir, log }) {
  const store = createInitiativeStore({ stateDir, log });
  const enabled = cfg?.initiative?.enabled === true;

  async function onMessageReceived() {
    if (!enabled) return;
    // Phase 1+: capture/extract tasks & directives from the message.
  }

  async function onBeforePromptBuild() {
    if (!enabled) return;
    // Phase 1+: inject open tasks/directives into the agent context.
  }

  async function tick() {
    if (!enabled) return;
    // Phase 2+: heartbeat-like per-scope cadence that acts on due tasks.
  }

  function stop() {
    store.stop();
  }

  return { onMessageReceived, onBeforePromptBuild, tick, stop, __store: store };
}
