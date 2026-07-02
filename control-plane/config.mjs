// ControlPlane configuration. Defaults mirror the current lab; secrets are never stored here.

import { versionSnapshot } from "../shared/contracts/versions.mjs";

export const DEFAULT_CONTROL_PLANE_CONFIG = Object.freeze({
  schemaVersion: "3.0",
  server: {
    port: 8787,
    host: "0.0.0.0",
    portalDir: "../portal",
    bundleDir: "./state/bundles",
    blobDir: "./state/blobs",
  },
  security: {
    // Node credentials authenticate the control channel + data plane. Operator auth for
    // /api/* mutations is separate. mTLS is the target; token-based to start.
    requireNodeCredential: true,
    enrollmentTokenTtlMs: 15 * 60 * 1000,
  },
  // Desired versions the reconciler converges every node to (central update target).
  desiredVersions: versionSnapshot(),
  rollout: {
    canary: 1, // update one node first, gate on health
    batchSize: 1, // then this many per wave
    maxInFlight: 1, // never more than this updating at once
    healthGateMs: 60000, // new worker must be healthy within this window or roll back
  },
  selection: {
    azure_direct: { required: true, quorum: 1 },
    gsa_remotenet: { required: true, quorum: 1 },
    gsa_client: { required: true, quorum: 1 },
    cloudflare_client: { required: false, quorum: 1 },
    external_direct: { required: false, quorum: 1 },
  },
  recovery: {
    heartbeatStaleMs: 120000,
    reconnectGraceMs: 300000, // after reboot, allow this long to reconnect before "offline"
    jobLeaseMaxAttempts: 2,
  },
  paths: {
    stateDir: "./state",
  },
});

export function loadControlPlaneConfig(overrides = {}) {
  return deepMerge(DEFAULT_CONTROL_PLANE_CONFIG, overrides || {});
}

function deepMerge(base, overlay) {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return overlay ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(base?.[k] || {}, v) : v;
  }
  return out;
}
