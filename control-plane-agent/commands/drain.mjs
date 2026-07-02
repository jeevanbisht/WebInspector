// Handle drain / undrain — stop or resume accepting new jobs. In-flight jobs finish either
// way; drain is used before updates/reboots for graceful transitions.

export async function handleDrain({ workerManager, progress }) {
  progress?.("draining");
  workerManager.setDraining(true);
  return { draining: true };
}

export async function handleUndrain({ workerManager, progress }) {
  progress?.("resuming");
  workerManager.setDraining(false);
  return { draining: false };
}
