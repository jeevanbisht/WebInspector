// Rollback (supervisor side).
//
// Flip `current` back to a previously installed version and restart the worker. Invoked
// automatically when a health-gated update fails, or manually via a command.

import { join } from "node:path";

export async function rollbackTo({ platform, paths, workerManager, component, toVersion, logger = console } = {}) {
  if (!toVersion) throw new Error("rollback requires a target version");
  const isAgent = component === "agent";
  const versionsDir = isAgent ? paths.agentVersionsDir : join(paths.installRoot, "control-plane-agent", "versions");
  const currentLink = isAgent ? paths.agentCurrent : paths.supervisorCurrent;
  const targetDir = join(versionsDir, toVersion);

  logger.warn?.(`[rollback] ${component} -> ${toVersion}`);
  if (isAgent) {
    workerManager.setDraining(true);
    await workerManager.stop();
    await platform.swapCurrent(currentLink, targetDir);
    workerManager.setVersion(toVersion);
    await workerManager.start(toVersion);
    workerManager.setDraining(false);
  } else {
    await platform.swapCurrent(currentLink, targetDir);
    setTimeout(() => platform.restartService?.("WebInspectorControlPlaneAgent").catch(() => {}), 250);
  }
  return { rolledBackTo: toVersion };
}
