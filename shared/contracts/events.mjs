// Event vocabulary for the ControlPlane's append-only event log. Extends the TestingInfra
// v2 lifecycle events with control-channel, update, and reboot events so operator
// visibility covers management actions as well as test execution.

export const EVENT_TYPES = Object.freeze([
  // control channel + registry
  "agent_connected",
  "agent_registered",
  "agent_heartbeat",
  "agent_status_changed",
  "agent_disconnected",
  // command dispatch
  "command_issued",
  "command_accepted",
  "command_succeeded",
  "command_failed",
  // central updates
  "update_offered",
  "update_started",
  "update_completed",
  "update_failed",
  "update_rolled_back",
  // reboot / lifecycle
  "reboot_requested",
  "reboot_started",
  "agent_reconnected",
  "worker_restarted",
  // test lifecycle (carried over from v2)
  "run_created",
  "url_queued",
  "url_blocked",
  "job_dispatched",
  "initial_test_started",
  "initial_test_completed",
  "browser_validation_required",
  "browser_validation_started",
  "browser_validation_completed",
  "result_recorded",
  "comparison_completed",
  "packet_generated",
  "url_completed",
  "run_completed",
  "artifact_uploaded",
  // recovery
  "recovery_started",
  "recovery_completed",
]);

export function isEventType(value) {
  return EVENT_TYPES.includes(value);
}

/** Build an event log record. */
export function makeEvent(type, fields = {}) {
  if (!isEventType(type)) throw new Error(`unknown event type: ${type}`);
  return {
    eventId: fields.eventId || `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    nodeName: fields.nodeName || null,
    nodeType: fields.nodeType || null,
    runId: fields.runId || null,
    urlId: fields.urlId || null,
    jobId: fields.jobId || null,
    commandId: fields.commandId || null,
    message: fields.message || "",
    data: fields.data || {},
    timestamp: fields.timestamp || new Date().toISOString(),
  };
}
