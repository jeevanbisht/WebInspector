// Worker Agent lifecycle (supervisor side).
//
// Owns the worker process: start/stop/restart, crash auto-restart with backoff, drain flag,
// and job delivery. The control channel is NOT here, so restarting/updating the worker never
// affects central connectivity.
//
// IPC: jobs are delivered as NDJSON on the worker's stdin; the worker emits NDJSON on stdout
//   { type: "ready" }                 → readiness (drives the health gate)
//   { type: "result", jobId, result } → job result (forwarded up via onResult)
// Bulk bytes (artifacts) go straight to the ControlPlane data plane, not through here.

import { join } from "node:path";
import { createInterface } from "node:readline";

export function createWorkerManager({ platform, paths, intervals = {}, env = {}, onResult = null, logger = console } = {}) {
  const state = {
    handle: null,
    pid: null,
    version: null,
    running: false,
    ready: false,
    draining: false,
    stopping: false,
    restarts: 0,
    currentJob: null,
    stdin: null,
    rl: null,
  };
  const backoffMs = intervals.workerRestartBackoffMs ?? 2000;

  function entrypoint() {
    return join(paths.agentCurrent, "core", "index.mjs");
  }

  function attachIpc(handle) {
    state.stdin = handle?.stdin || null;
    if (!handle?.stdout) return;
    const rl = createInterface({ input: handle.stdout });
    state.rl = rl;
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return; // ignore non-JSON stdout (incidental logs)
      }
      if (msg.type === "ready") {
        state.ready = true;
      } else if (msg.type === "result") {
        if (state.currentJob === msg.jobId) state.currentJob = null;
        onResult?.(msg);
      }
    });
  }

  async function start(version) {
    if (state.running) return state;
    state.stopping = false;
    state.ready = false;
    const proc = await platform.startProcess({ command: process.execPath, args: [entrypoint()], cwd: paths.agentCurrent, env });
    state.handle = proc.handle;
    state.pid = proc.pid;
    state.version = version || state.version;
    state.running = true;
    attachIpc(proc.handle);
    logger.info?.(`[worker] started pid=${state.pid} version=${state.version}`);
    proc.handle?.on?.("exit", (code) => onExit(code));
    return state;
  }

  function onExit(code) {
    state.running = false;
    state.ready = false;
    state.rl?.close?.();
    state.rl = null;
    state.handle = null;
    state.stdin = null;
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
    const handle = state.handle;
    // Force-kill: on Windows a plain taskkill (no /F) won't terminate a Node process, and a
    // lingering worker keeps its stdout pipe open. handle.kill() is a reliable fallback.
    await platform.stopProcess(handle, { force: true });
    try {
      handle?.kill?.();
    } catch {
      /* already gone */
    }
    state.rl?.close?.();
    state.rl = null;
    state.running = false;
    state.ready = false;
    state.handle = null;
    state.stdin = null;
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
    isReady() {
      return state.ready;
    },

    async runJob(job) {
      if (!state.running || !state.stdin) return { accepted: false, reason: "worker not running" };
      if (state.draining) return { accepted: false, reason: "draining" };
      state.currentJob = job?.id || null;
      state.stdin.write(`${JSON.stringify(job)}\n`); // deliver over the worker's stdin (NDJSON)
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
      return { running: state.running, ready: state.ready, pid: state.pid, version: state.version, draining: state.draining, restarts: state.restarts, currentJob: state.currentJob };
    },
  };
}
