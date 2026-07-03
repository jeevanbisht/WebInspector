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
    // TLS: set cert+key file paths (or WEBINSPECTOR_TLS_CERT_FILE / WEBINSPECTOR_TLS_KEY_FILE)
    // to serve the single port over HTTPS. Empty = plain HTTP (credentials travel in cleartext).
    tls: { certFile: null, keyFile: null },
  },
  security: {
    // Node credentials authenticate the control channel + data plane. Operator auth for
    // /api/* mutations is separate. mTLS is the target; token-based to start.
    requireNodeCredential: true,
    enrollmentTokenTtlMs: 15 * 60 * 1000,
    // Operator bearer tokens (PATs) for /api/* mutations. Empty here (never store secrets in
    // config): supply via WEBINSPECTOR_OPERATOR_TOKEN or overrides; the server generates an
    // ephemeral one at startup if none is configured.
    operatorTokens: [],
    // Update-bundle signing. Configure publisher public key(s) (ed25519 PEM) to REQUIRE a
    // valid signature on publish; supply via WEBINSPECTOR_BUNDLE_PUBLISHER_KEYS_B64 (comma-
    // separated base64 PEMs) or overrides. Empty = unenforced. requireSignature fails closed.
    bundleSigning: {
      publisherPublicKeys: [],
      requireSignature: false,
    },
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
  state: {
    // Persist runs/results/comparisons to disk so they survive a restart. The CLI enables this
    // by default (writes to `${paths.stateDir}/db`); embedded/test usage stays in-memory unless
    // a dir is configured (WEBINSPECTOR_STATE_DIR) or persist is turned on.
    persist: false,
    dir: null,
  },
});

export function loadControlPlaneConfig(overrides = {}) {
  const merged = deepMerge(DEFAULT_CONTROL_PLANE_CONFIG, overrides || {});
  // Operator tokens: explicit overrides win; otherwise read from the environment (comma-
  // separated). Left empty means the server mints an ephemeral token at startup.
  if (!overrides?.security?.operatorTokens && process.env.WEBINSPECTOR_OPERATOR_TOKEN) {
    merged.security = {
      ...merged.security,
      operatorTokens: process.env.WEBINSPECTOR_OPERATOR_TOKEN.split(",").map((t) => t.trim()).filter(Boolean),
    };
  }
  // Bundle publisher public keys: base64-encoded PEMs, comma-separated.
  if (!overrides?.security?.bundleSigning?.publisherPublicKeys && process.env.WEBINSPECTOR_BUNDLE_PUBLISHER_KEYS_B64) {
    const keys = process.env.WEBINSPECTOR_BUNDLE_PUBLISHER_KEYS_B64.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((b64) => Buffer.from(b64, "base64").toString("utf8"));
    merged.security = { ...merged.security, bundleSigning: { ...merged.security.bundleSigning, publisherPublicKeys: keys } };
  }
  // TLS cert/key file paths from the environment.
  if (!overrides?.server?.tls?.certFile && (process.env.WEBINSPECTOR_TLS_CERT_FILE || process.env.WEBINSPECTOR_TLS_KEY_FILE)) {
    merged.server = {
      ...merged.server,
      tls: {
        ...merged.server.tls,
        certFile: process.env.WEBINSPECTOR_TLS_CERT_FILE || merged.server.tls.certFile,
        keyFile: process.env.WEBINSPECTOR_TLS_KEY_FILE || merged.server.tls.keyFile,
      },
    };
  }
  // Durable state: a configured dir (or explicit flag) turns persistence on.
  if (!overrides?.state?.dir && process.env.WEBINSPECTOR_STATE_DIR) {
    merged.state = { ...merged.state, dir: process.env.WEBINSPECTOR_STATE_DIR, persist: true };
  }
  if (overrides?.state?.persist === undefined && process.env.WEBINSPECTOR_STATE_PERSIST) {
    merged.state = { ...merged.state, persist: process.env.WEBINSPECTOR_STATE_PERSIST !== "0" };
  }
  return merged;
}

function deepMerge(base, overlay) {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return overlay ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(base?.[k] || {}, v) : v;
  }
  return out;
}
