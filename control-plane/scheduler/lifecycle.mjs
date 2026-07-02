// Per-URL lifecycle state machine (ControlPlane side).
//
// A URL is never "complete" until all required selected-node results exist, comparison is
// done, and the evidence packet is generated. This module owns the legal transitions and
// the completion gate.

export const URL_STATES = Object.freeze([
  "queued",
  "initial_tests_running",
  "initial_tests_completed",
  "browser_validation_running", // only if any initial test was not OK
  "browser_validation_completed",
  "comparison_running",
  "packet_generation",
  "completed",
  "failed",
  "cancelled",
]);

const LEGAL = {
  queued: ["initial_tests_running", "cancelled"],
  initial_tests_running: ["initial_tests_completed", "failed", "cancelled"],
  initial_tests_completed: ["browser_validation_running", "comparison_running", "cancelled"],
  browser_validation_running: ["browser_validation_completed", "failed", "cancelled"],
  browser_validation_completed: ["comparison_running", "cancelled"],
  comparison_running: ["packet_generation", "failed"],
  packet_generation: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function assertTransition(from, to) {
  if (!URL_STATES.includes(to)) throw new Error(`unknown url state: ${to}`);
  if (!(LEGAL[from] || []).includes(to)) throw new Error(`illegal transition ${from} -> ${to}`);
  return to;
}

export function createLifecycle({ store, comparison, reporting } = {}) {
  return {
    /** Have all required selected nodes produced a terminal result for this stage? */
    isStageComplete(jobs = [], stage) {
      const stageJobs = jobs.filter((j) => j.stage === stage);
      return stageJobs.length > 0 && stageJobs.every((j) => ["completed", "failed", "timed_out", "cancelled"].includes(j.status));
    },

    /** Does any initial test come back not-OK (→ browser validation required on all)? */
    needsBrowserValidation(results = []) {
      return results.some((r) => r.stage === "initial_test" && r.ok === false);
    },

    async transition(urlRecord, to) {
      assertTransition(urlRecord.status, to);
      const next = { ...urlRecord, status: to, updatedAt: new Date().toISOString() };
      await store?.put("urls", urlRecord.id, next);
      return next;
    },

    /** Completion gate — refuses to complete without comparison + packet. */
    async tryComplete(urlRecord, { jobs, results }) {
      if (!this.isStageComplete(jobs, "initial_test")) return { completed: false, reason: "initial tests pending" };
      if (this.needsBrowserValidation(results) && !this.isStageComplete(jobs, "browser_validation")) {
        return { completed: false, reason: "browser validation pending" };
      }
      // TODO: run comparison + generate packet, then transition to completed
      return { completed: false, reason: "comparison/packet not yet implemented" };
    },
  };
}
