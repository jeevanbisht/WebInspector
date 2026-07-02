// Worker health probe (supervisor side).
//
// Used to HEALTH-GATE updates: after swapping to a new worker version, the supervisor waits
// for the worker to report healthy within a window. If it doesn't, the update rolls back.
//
// TODO: define the worker's health signal (a local /health, a ready line on stdout, or a
// heartbeat file) and poll it here.

export async function waitForHealthy({ workerManager, timeoutMs = 60000, pollMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isWorkerHealthy(workerManager)) return { healthy: true };
    await sleep(pollMs);
  }
  return { healthy: false, reason: "health gate timed out" };
}

export async function isWorkerHealthy(workerManager) {
  // Real readiness: the worker emitted its `ready` line on stdout after (re)start.
  return workerManager.isReady ? workerManager.isReady() : workerManager.isRunning();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
