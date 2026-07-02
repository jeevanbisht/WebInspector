// Node metadata snapshot (worker side).
//
// Combines local network facts with best-effort public-IP and Azure IMDS lookups into the
// snapshot attached to every result. Public IP + Azure lookups are best-effort and never
// throw.

import os from "node:os";
import { getPublicIp } from "./public-ip.mjs";
import { getAzureMetadata } from "./azure-metadata.mjs";

export function getLocalNetwork() {
  const ifaces = os.networkInterfaces();
  const addresses = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list || []) {
      if (!a.internal) addresses.push({ iface: name, family: a.family, address: a.address, mac: a.mac });
    }
  }
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    addresses,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/** Full metadata snapshot (used by the job-runner for every result). */
export async function collectMetadata({ allowPublicIpLookup = true } = {}) {
  const [publicIp, azure] = await Promise.all([
    getPublicIp({ allowLookup: allowPublicIpLookup }).catch(() => ({ publicIp: null })),
    getAzureMetadata().catch(() => null),
  ]);
  return {
    ...getLocalNetwork(),
    publicIp: publicIp.publicIp,
    azure,
    capturedAt: new Date().toISOString(),
  };
}
