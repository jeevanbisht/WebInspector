// Handle restart_worker — bounce the worker Agent without touching the control channel.

export async function handleRestartWorker({ workerManager, progress }) {
  progress?.("restarting worker");
  await workerManager.restart();
  return { restarted: true, worker: workerManager.status() };
}
