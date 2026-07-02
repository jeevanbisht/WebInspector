// Update applier (supervisor side) — the safe, central-update workhorse.
//
// applyBundle:
//   1. download the bundle over the DATA plane and VERIFY its SHA-256 (platform.downloadFile)
//   2. (TODO) verify signature against the ControlPlane's trusted public key
//   3. extract into versions/<version> and write the VERSION marker
//   4. worker updates: drain → stop → atomic swap `current` → start → HEALTH-GATE → rollback on fail
//      supervisor updates: swap `current` → restart the service (re-exec into new code)
//
// Because the supervisor owns the control channel, worker updates happen with zero loss of
// central connectivity. Supervisor self-updates re-exec, then re-register on reconnect.

import { join } from "node:path";
import { rm } from "node:fs/promises";
import { writeVersionMarker, readInstalledVersion } from "./version.mjs";
import { rollbackTo } from "./rollback.mjs";
import { waitForHealthy } from "../worker-manager/health.mjs";

export function createUpdater({ platform, paths, workerManager, healthGateMs = 60000, controlPlaneUrl = "", logger = console } = {}) {
  function layout(component) {
    if (component === "agent") {
      return { versionsDir: paths.agentVersionsDir, currentLink: paths.agentCurrent };
    }
    // control-plane-agent (supervisor)
    const base = join(paths.installRoot, "control-plane-agent");
    return { versionsDir: join(base, "versions"), currentLink: paths.supervisorCurrent };
  }

  return {
    async applyBundle({ component, version, bundle, onProgress }) {
      const { versionsDir, currentLink } = layout(component);
      const versionDir = join(versionsDir, version);
      const previousVersion = await readInstalledVersion(currentLink);
      const tmp = join(versionsDir, `_${version}.zip`);

      onProgress?.(`downloading ${component}@${version}`);
      const bundleUrl = bundle.url.startsWith("http") ? bundle.url : `${controlPlaneUrl || ""}${bundle.url}`;
      await platform.downloadFile(bundleUrl, tmp, { sha256: bundle.sha256 });
      // TODO: verify bundle.signature against the trusted public key before extract.

      onProgress?.("extracting");
      await platform.extractBundle(tmp, versionDir);
      await writeVersionMarker(versionDir, version);
      await rm(tmp, { force: true }).catch(() => {});

      if (component === "control-plane-agent") {
        // Self-update: swap then re-exec via the service manager. Report success now; the
        // service restart happens out-of-band and the supervisor re-registers on reconnect.
        await platform.swapCurrent(currentLink, versionDir);
        onProgress?.("restarting supervisor service");
        setTimeout(() => platform.restartService?.("WebInspectorControlPlaneAgent").catch(() => {}), 250);
        return { status: "succeeded", component, version, previousVersion, restarting: true };
      }

      // Worker update: drain → swap → restart → health-gate → rollback on failure.
      onProgress?.("draining worker");
      workerManager.setDraining(true);
      await workerManager.stop();
      await platform.swapCurrent(currentLink, versionDir);
      workerManager.setVersion(version);
      await workerManager.start(version);
      workerManager.setDraining(false);

      onProgress?.("health-gating new worker");
      const health = await waitForHealthy({ workerManager, timeoutMs: healthGateMs });
      if (!health.healthy) {
        logger.warn?.(`[update] health gate failed for ${version}; rolling back to ${previousVersion}`);
        await rollbackTo({ platform, paths, workerManager, component, toVersion: previousVersion });
        const err = new Error(`update ${component}@${version} failed health gate; rolled back to ${previousVersion}`);
        err.rolledBackTo = previousVersion;
        throw err;
      }

      return { status: "succeeded", component, version, previousVersion };
    },
  };
}
