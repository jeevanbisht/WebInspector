// Worker Agent lifecycle (supervisor side).
//
// Owns the worker process: start/stop/restart, crash auto-restart with backoff, drain flag,
// and job delivery. The control channel is NOT here, so restarting/updating the worker never
// affects central connectivity.
//
// TODO: real job delivery to the worker (local IPC — stdin NDJSON or a named pipe) and a
// health signal the worker exposes for health-gated updates.

import { join } from "node:path";

export function createWorkerManager({ platform, paths, intervals = {}, logger = console } = {}) {
  const state = {
    handle: null,
    pid: null,
    version: null,
    running: false,
    draining: false,
    stopping: false,
    restarts: 0,
    currentJob: null,
  };
  const backoffMs = intervals.workerRestartBackoffMs ?? 2000;

  function entrypoint() {
    return join(paths.agentCurrent, "core", "index.mjs");
  }

  async function start(version) {
    if (state.running) return state;
    state.stopping = false;
    const proc = await platform.startProcess({ command: "node", args: [entrypoint()], cwd: paths.agentCurrent });
    state.handle = proc.handle;
    state.pid = proc.pid;
    state.version = version || state.version;
    state.running = true;
    logger.info?.(`[worker] started pid=${state.pid} version=${state.version}`);
    proc.handle?.on?.("exit", (code) => onExit(code));
    return state;
  }

  function onExit(code) {
    state.running = false;
    state.handle = null;
    state.pid = null;
    logger.warn?.(`[worker] exited code=${code}`);
    if (!state.stopping) {
      state.restarts += 1;
      setTimeout(() => start(state.version).catch((e) => logger.error?.(`[worker] restart failed: ${e.message}`)), backoffMs);
    }
  }

  async function stop() {
    if (!state.running) return;
    state.stopping = true;
    await platform.stopProcess(state.handle, { force: false });
    state.running = false;
    state.handle = null;
    state.pid = null;
  }

  return {
    async ensureRunning(version) {
      if (!state.running) await start(version);
      return state;
    },
    start,
    stop,
    async restart(version) {
      await stop();
      return start(version || state.version);
    },
    setVersion(v) {
      state.version = v;
    },
    setDraining(v) {
      state.draining = Boolean(v);
    },
    isDraining() {
      return state.draining;
    },
    isRunning() {
      return state.running;
    },

    async runJob(job) {
      if (state.draining) return { accepted: false, reason: "draining" };
      state.currentJob = job?.id || null;
      // TODO: deliver `job` to the worker over local IPC and await its result.
      return { accepted: true, jobId: job?.id || null };
    },
    async cancelJob(jobId) {
      if (state.currentJob === jobId) state.currentJob = null;
      return { cancelled: true, jobId };
    },
    async applyConfig(config) {
      // TODO: hand config to the worker; persist appliedConfigHash for reconciler.
      return { applied: true, keys: Object.keys(config || {}) };
    },

    status() {
      return { running: state.running, pid: state.pid, version: state.version, draining: state.draining, restarts: state.restarts, currentJob: state.currentJob };
    },
  };
}
