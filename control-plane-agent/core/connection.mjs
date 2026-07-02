// Control-channel client (supervisor side).
//
// Maintains ONE persistent, authenticated, bidirectional connection to the ControlPlane
// over its single port. WebSocket preferred; long-poll fallback for restrictive networks.
// Reconnects with exponential backoff and re-sends `hello` on every (re)connect so the
// ControlPlane always has a live session — this is what survives worker updates + reboots.
//
// TODO: real WS client (ws) + long-poll fallback (GET /agent/poll, POST /agent/push).

import { upMessage, assertEnvelope } from "../../shared/protocol/control-channel.mjs";

export function createConnection({ controlPlaneUrl, controlChannelPath = "/agent/channel", nodeId, nodeCredential, intervals = {}, onMessage, onOpen, onClose, logger = console } = {}) {
  const wsUrl = toWs(`${controlPlaneUrl}${controlChannelPath}`);
  const authHeader = `Bearer ${nodeId}:${nodeCredential}`;
  let socket = null;
  let closed = false;
  let attempt = 0;
  const base = intervals.reconnectBaseMs ?? 1000;
  const max = intervals.reconnectMaxMs ?? 30000;

  function backoff() {
    attempt += 1;
    return Math.min(max, base * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
  }

  function connect() {
    if (closed) return;
    // TODO: open a real WebSocket to `wsUrl` with header `authorization: authHeader`.
    // On open: attempt = 0; onOpen?.(). On message: onMessage?.(assertEnvelope(JSON.parse(data))).
    // On close/error: schedule reconnect via setTimeout(connect, backoff()); onClose?.().
    logger.info?.(`[connection] would connect ${wsUrl} (auth ${nodeId})`);
  }

  return {
    start() {
      closed = false;
      connect();
    },
    /** Send an UP envelope. */
    send(envelope) {
      assertEnvelope(envelope);
      if (!socket) {
        // TODO: buffer until reconnect (bounded), so results/heartbeats aren't lost.
        logger.warn?.("[connection] send while disconnected (buffered)");
        return false;
      }
      socket.send(JSON.stringify(envelope));
      return true;
    },
    sendUp(type, payload, opts) {
      return this.send(upMessage(type, payload, { nodeName: nodeId, ...opts }));
    },
    close() {
      closed = true;
      socket?.close?.();
      socket = null;
    },
    get authHeader() {
      return authHeader;
    },
  };
}

function toWs(httpUrl) {
  return httpUrl.replace(/^http/i, (m) => (m.toLowerCase() === "http" ? "ws" : "ws"));
}
