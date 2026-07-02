// Single-port control-channel protocol.
//
// One persistent, bidirectional connection between each ControlPlane Agent (supervisor)
// and the ControlPlane, multiplexed over the ControlPlane's single HTTP port
// (WebSocket, with long-poll fallback). Every frame is a self-describing envelope so the
// same channel carries management commands (down) and telemetry/results (up).
//
// CONTROL PLANE vs DATA PLANE:
//   The control channel carries only SMALL, low-latency messages and REFERENCES.
//   Bulk bytes (full result bodies, screenshots, HAR, update bundles) travel on the
//   separate data plane (see ./data-plane.mjs) so a large upload can never block a
//   reboot/cancel or trip a false "heartbeat missing".
//
// Keep this file dependency-free and transport-agnostic.

export const PROTOCOL_VERSION = 1;

// Messages sent DOWN: ControlPlane -> ControlPlane Agent  (blue arrows).
export const DOWN_MESSAGE_TYPES = Object.freeze([
  "hello_ack",   // accept registration, assign sessionId + desired versions/config
  "command",     // a control command (payload.command is one of CONTROL_COMMANDS)
  "config",      // push updated config
  "ack",         // acknowledge an upstream message (correlationId)
  "ping",        // liveness probe
]);

// Messages sent UP: ControlPlane Agent -> ControlPlane  (green arrows).
export const UP_MESSAGE_TYPES = Object.freeze([
  "hello",          // register: identity, versions, metadata, capabilities
  "heartbeat",      // liveness + supervisor/worker status snapshot
  "status",         // discrete status change (worker started/stopped/updating/…)
  "command_result", // result/ack for a downstream command (correlationId)
  "result",         // SMALL result summary (initial_test / browser_validation); bulk body -> data plane
  "result_ref",     // pointer to a bulk result body uploaded on the data plane
  "telemetry",      // logs / metrics (large batches -> data plane)
  "artifact_ref",   // pointer to a screenshot/HAR uploaded on the data plane
  "bye",            // graceful disconnect (e.g. just before a reboot)
  "pong",           // reply to ping
]);

export const MESSAGE_TYPES = Object.freeze([...DOWN_MESSAGE_TYPES, ...UP_MESSAGE_TYPES]);

/**
 * Build a control-channel envelope.
 * @param {"down"|"up"} dir
 * @param {string} type - one of MESSAGE_TYPES
 * @param {object} [payload]
 * @param {{correlationId?:string, sessionId?:string, nodeName?:string}} [opts]
 */
export function envelope(dir, type, payload = {}, opts = {}) {
  if (!MESSAGE_TYPES.includes(type)) throw new Error(`unknown control message type: ${type}`);
  return {
    v: PROTOCOL_VERSION,
    id: opts.id || `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ts: opts.ts || new Date().toISOString(),
    dir,
    type,
    sessionId: opts.sessionId || null,
    nodeName: opts.nodeName || null,
    correlationId: opts.correlationId || null,
    payload,
  };
}

export const downMessage = (type, payload, opts) => envelope("down", type, payload, opts);
export const upMessage = (type, payload, opts) => envelope("up", type, payload, opts);

export function isDownMessage(msg) {
  return Boolean(msg) && DOWN_MESSAGE_TYPES.includes(msg.type);
}

export function isUpMessage(msg) {
  return Boolean(msg) && UP_MESSAGE_TYPES.includes(msg.type);
}

/** Minimal structural validation for an inbound envelope. */
export function assertEnvelope(msg) {
  if (!msg || typeof msg !== "object") throw new Error("envelope must be an object");
  if (msg.v !== PROTOCOL_VERSION) throw new Error(`unsupported protocol version: ${msg.v}`);
  if (!MESSAGE_TYPES.includes(msg.type)) throw new Error(`unknown message type: ${msg.type}`);
  return msg;
}
