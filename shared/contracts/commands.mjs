// Control commands: the verbs the ControlPlane pushes DOWN to a ControlPlane Agent
// over the control channel (envelope type "command", payload shaped by makeCommand).
//
// These give the ControlPlane first-class central control: dispatch work, update the
// worker, reboot the VM, restart the worker, drain, reconfigure, and collect diagnostics.

export const CONTROL_COMMANDS = Object.freeze([
  "dispatch_job",                 // run a probe/browser job on the worker Agent
  "cancel_job",                   // cancel a queued/running job
  "update_agent",                 // pull + apply a new worker Agent bundle (central push update)
  "update_control_plane_agent",   // self-update the supervisor, then reconnect
  "reboot",                       // reboot the VM; supervisor re-registers after boot
  "restart_worker",               // restart the worker Agent process
  "drain",                        // stop accepting new jobs (finish in-flight)
  "undrain",                      // resume accepting jobs
  "set_config",                   // push runtime config to the supervisor/worker
  "collect_diagnostics",          // gather logs/metadata and report back up
  "ping",                         // control-level liveness check
]);

export function isControlCommand(value) {
  return CONTROL_COMMANDS.includes(value);
}

/**
 * Build a command payload for envelope type "command".
 * @param {string} command - one of CONTROL_COMMANDS
 * @param {object} [args] - command-specific arguments
 * @param {{commandId?:string, reason?:string, requestedBy?:string}} [opts]
 */
export function makeCommand(command, args = {}, opts = {}) {
  if (!isControlCommand(command)) throw new Error(`unknown control command: ${command}`);
  return {
    commandId: opts.commandId || `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    args,
    reason: opts.reason || null,
    requestedBy: opts.requestedBy || null,
    issuedAt: new Date().toISOString(),
  };
}

// Terminal states a ControlPlane Agent reports back via "command_result".
export const COMMAND_RESULT_STATUSES = Object.freeze([
  "accepted",
  "in_progress",
  "succeeded",
  "failed",
  "rejected",
  "superseded",
]);

/**
 * Build a command_result payload (sent UP, correlated by commandId).
 * @param {string} commandId
 * @param {string} status - one of COMMAND_RESULT_STATUSES
 * @param {{message?:string, data?:object, error?:string}} [opts]
 */
export function makeCommandResult(commandId, status, opts = {}) {
  if (!COMMAND_RESULT_STATUSES.includes(status)) {
    throw new Error(`unknown command_result status: ${status}`);
  }
  return {
    commandId,
    status,
    message: opts.message || "",
    data: opts.data || {},
    error: opts.error || null,
    reportedAt: new Date().toISOString(),
  };
}
