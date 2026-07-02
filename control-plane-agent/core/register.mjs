// Build the `hello` registration payload the supervisor sends on every (re)connect.

import { versionSnapshot } from "../../shared/contracts/versions.mjs";

export function buildHello({ identity, installedVersions = {}, metadata = {}, capabilities = {} } = {}) {
  return {
    nodeName: identity.nodeName,
    nodeType: identity.nodeType,
    platform: identity.platform,
    versions: versionSnapshot(installedVersions),
    metadata: {
      os: identity.os,
      machineId: identity.machineId,
      ...metadata,
    },
    capabilities: {
      initialTest: true,
      browserValidation: true,
      screenshots: true,
      har: true,
      ...capabilities,
    },
    registeredAt: new Date().toISOString(),
  };
}
