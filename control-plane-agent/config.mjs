// Supervisor configuration: install paths + timing. Identity (URL/credential) comes from
// state/node-identity.json, not from here.

import { join } from "node:path";

export function defaultInstallRoot() {
  return process.platform === "win32" ? "C:\\WebInspector" : "/opt/webinspector";
}

export function loadSupervisorConfig(installRoot = defaultInstallRoot(), overrides = {}) {
  const root = installRoot;
  return {
    installRoot: root,
    paths: {
      installRoot: root,
      stateDir: join(root, "state"),
      identityFile: join(root, "state", "node-identity.json"),
      agentDir: join(root, "agent"),
      agentVersionsDir: join(root, "agent", "versions"),
      agentCurrent: join(root, "agent", "current"),
      supervisorCurrent: join(root, "control-plane-agent", "current"),
    },
    intervals: {
      heartbeatMs: 30000,
      reconnectBaseMs: 1000,
      reconnectMaxMs: 30000,
      workerRestartBackoffMs: 2000,
    },
    healthGateMs: 60000, // new worker must be healthy within this window or roll back
    ...overrides,
  };
}
