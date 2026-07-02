// Node selection (ControlPlane side).
//
// Picks eligible nodes per type for a URL: healthy, connected, version-compatible, not
// draining/updating/rebooting. Enforces per-type quorum + required-type gating before a
// URL can be dispatched.

import { meetsMinimums } from "../../shared/contracts/versions.mjs";

const UNAVAILABLE_STATUSES = new Set([
  "draining",
  "updating",
  "rebooting",
  "offline",
  "disconnected",
  "heartbeat_missing",
  "version_mismatch",
  "blocked",
]);

export function createNodeSelection({ registry, config } = {}) {
  const selectionPolicy = config?.selection || {};
  const minimums = config?.desiredVersions || {};

  function eligible(nodeType) {
    return registry
      .listConnected()
      .filter((n) => n.nodeType === nodeType)
      .filter((n) => !UNAVAILABLE_STATUSES.has(n.status))
      .filter((n) => meetsMinimums(n.versions || {}, pickMinimums(minimums)).ok);
  }

  return {
    eligible,

    /** Select nodes across all configured types; report which required quorums are unmet. */
    selectForUrl() {
      const selected = [];
      const unmet = [];
      for (const [nodeType, policy] of Object.entries(selectionPolicy)) {
        const pool = eligible(nodeType);
        const quorum = policy.quorum ?? 1;
        const picked = pool.slice(0, Math.max(quorum, pool.length && policy.mode === "all" ? pool.length : quorum));
        selected.push(...picked.map((n) => ({ nodeName: n.nodeName, nodeType: n.nodeType, versions: n.versions })));
        if (policy.required && picked.length < quorum) unmet.push({ nodeType, need: quorum, have: picked.length });
      }
      return { selected, unmet, canDispatch: unmet.length === 0 };
    },
  };
}

function pickMinimums(desired = {}) {
  // Compatibility gate: agents must be at least the desired contract/protocol/agent versions.
  const { agentVersion, contractsVersion, protocolVersion, schemaVersion } = desired;
  return { agentVersion, contractsVersion, protocolVersion, schemaVersion };
}
