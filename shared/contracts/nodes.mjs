// Node vocabulary shared across components.
//
// A "node" is a VM running a ControlPlane Agent (supervisor) + Agent (worker). Node type
// describes its network arm; carried over from TestingInfra v2 so classification stays
// compatible.

export const NODE_TYPES = Object.freeze([
  "azure_direct",
  "gsa_remotenet",
  "gsa_client",
  "cloudflare_client",
  "external_direct",
]);

export const REQUIRED_NODE_TYPES = Object.freeze(["azure_direct", "gsa_remotenet", "gsa_client"]);
export const OPTIONAL_NODE_TYPES = Object.freeze(["external_direct"]);

// Node status now includes control-channel + supervisor lifecycle states.
export const NODE_STATUSES = Object.freeze([
  "unregistered",
  "connected",          // control channel established
  "ready",              // supervisor + worker healthy, accepting jobs
  "busy",
  "draining",
  "degraded",
  "heartbeat_missing",
  "disconnected",       // control channel dropped
  "updating",           // applying a pushed update
  "update_failed",
  "rebooting",          // reboot command in flight
  "offline",
  "version_mismatch",
  "blocked",
]);

export function isNodeType(value) {
  return NODE_TYPES.includes(value);
}

export function isRequiredNodeType(value) {
  return REQUIRED_NODE_TYPES.includes(value);
}

export function normalizeNodeName(value) {
  return String(value || "").trim();
}

/** Validate + normalize a target URL (scheme defaults to https). Shared by scheduler + agent. */
export function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("url is required");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) {
    throw new Error("url scheme must be http or https");
  }
  const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const withoutScheme = normalized.replace(/^https?:\/\//i, "");
  if (withoutScheme.includes("://")) throw new Error(`invalid URL: ${raw}`);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("url scheme must be http or https");
  if (!parsed.hostname || parsed.username || parsed.password) throw new Error(`invalid URL: ${raw}`);
  return parsed.toString();
}

export function assertNodeIdentity({ nodeName, nodeType } = {}) {
  const name = normalizeNodeName(nodeName);
  if (!name) throw new Error("nodeName is required");
  if (!isNodeType(nodeType)) throw new Error(`nodeType must be one of: ${NODE_TYPES.join(", ")}`);
  return { nodeName: name, nodeType };
}
