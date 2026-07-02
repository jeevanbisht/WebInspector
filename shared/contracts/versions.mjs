// Version schema + comparison helpers.
//
// Used for two decisions:
//   1. Compatibility — is a connected agent new enough to receive jobs?
//   2. Update — does a connected agent match the desired version, or push an update?
//
// The ControlPlane holds the DESIRED versions; each ControlPlane Agent reports its ACTUAL
// versions in `hello`/`heartbeat`. The update manager diffs them.

export const SCHEMA_VERSION = "3.0";

// Independently versioned so the worker Agent can be updated without touching the
// supervisor, and vice versa.
export const COMPONENT_VERSION_FIELDS = Object.freeze([
  "controlPlaneAgentVersion", // the supervisor
  "agentVersion",             // the worker
  "contractsVersion",
  "protocolVersion",
  "schemaVersion",
]);

export function versionSnapshot(overrides = {}) {
  return {
    controlPlaneAgentVersion: "3.0.0",
    agentVersion: "3.0.0",
    contractsVersion: "3.0.0",
    protocolVersion: "1",
    schemaVersion: SCHEMA_VERSION,
    ...overrides,
  };
}

/** Numeric-segment compare. Returns 1, 0, or -1. */
export function compareVersions(actual, target) {
  const a = String(actual || "").match(/\d+/g)?.map(Number) || [];
  const b = String(target || "").match(/\d+/g)?.map(Number) || [];
  if (!b.length) return 0;
  if (!a.length) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** True if `versions` meets every minimum in `minimums`. */
export function meetsMinimums(versions = {}, minimums = {}) {
  const failures = [];
  for (const [field, min] of Object.entries(minimums)) {
    if (compareVersions(versions[field], min) < 0) {
      failures.push(`${field} ${versions[field] || "missing"} < ${min}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Diff actual vs desired versions to decide what to push.
 * @returns {{ updateAgent:boolean, updateSupervisor:boolean, fields:string[] }}
 */
export function updatePlan(actual = {}, desired = {}) {
  const fields = [];
  for (const field of COMPONENT_VERSION_FIELDS) {
    if (desired[field] && compareVersions(actual[field], desired[field]) < 0) fields.push(field);
  }
  return {
    updateAgent: fields.includes("agentVersion"),
    updateSupervisor: fields.includes("controlPlaneAgentVersion"),
    fields,
  };
}
