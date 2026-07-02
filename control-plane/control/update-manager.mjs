// Update manager (ControlPlane side).
//
// Owns the DESIRED versions and turns "actual vs desired" drift into safe, staged update
// commands. Best practices baked in: canary-first rollout, bounded in-flight updates,
// health-gated progression, and automatic halt on failure.

import { updatePlan } from "../../shared/contracts/versions.mjs";
import { makeCommand } from "../../shared/contracts/commands.mjs";

export function createUpdateManager({ bundleRegistry, desiredVersions = {}, rollout = {} } = {}) {
  const desired = { ...desiredVersions };
  const policy = {
    canary: rollout.canary ?? 1, // update this many nodes first, then gate on health
    batchSize: rollout.batchSize ?? 1, // nodes updated per wave after canary passes
    maxInFlight: rollout.maxInFlight ?? 1,
    ...rollout,
  };
  // rolloutState keyed by `${component}@${version}`: { phase, canaryOk, failed, inFlight:Set }
  const rolloutState = new Map();

  function stateFor(component, version) {
    const k = `${component}@${version}`;
    if (!rolloutState.has(k)) {
      rolloutState.set(k, { phase: "canary", canaryOk: false, failed: false, inFlight: new Set() });
    }
    return rolloutState.get(k);
  }

  return {
    setDesired(next = {}) {
      Object.assign(desired, next);
      return { ...desired };
    },
    getDesired() {
      return { ...desired };
    },

    /** What (if anything) should this node update? */
    planForNode(node) {
      return updatePlan(node.versions || {}, desired);
    },

    /**
     * Given eligible nodes needing a given component@version, return the subset to update
     * now, honoring canary + batch + maxInFlight + halt-on-failure.
     */
    pickRolloutBatch(component, version, nodesNeeding = []) {
      const st = stateFor(component, version);
      if (st.failed) return []; // halted; operator must clear
      const capacity = Math.max(0, policy.maxInFlight - st.inFlight.size);
      if (capacity === 0) return [];
      const eligible = nodesNeeding.filter((n) => !st.inFlight.has(n.nodeName));
      const limit = st.phase === "canary" ? Math.min(policy.canary, capacity) : Math.min(policy.batchSize, capacity);
      const batch = eligible.slice(0, limit);
      batch.forEach((n) => st.inFlight.add(n.nodeName));
      return batch;
    },

    /** Build the update_agent (or supervisor) command carrying the bundle data-ref. */
    makeUpdateCommand(component, version, { requestedBy = "reconciler" } = {}) {
      const command = component === "control-plane-agent" ? "update_control_plane_agent" : "update_agent";
      const dataRef = bundleRegistry.dataRef(component, version);
      return makeCommand(command, { component, version, bundle: dataRef }, { requestedBy, reason: `roll to ${component}@${version}` });
    },

    /** Record the outcome reported by a node; advances or halts the rollout. */
    recordOutcome(component, version, nodeName, status) {
      const st = stateFor(component, version);
      st.inFlight.delete(nodeName);
      if (status === "failed") {
        st.failed = true; // halt rollout; requires operator action / rollback
        return { halted: true };
      }
      if (status === "succeeded" && st.phase === "canary") {
        st.canaryOk = true;
        st.phase = "rolling"; // canary passed → proceed in batches
      }
      return { halted: false, phase: st.phase };
    },

    clearHalt(component, version) {
      const st = stateFor(component, version);
      st.failed = false;
    },
  };
}
