// Control-channel client (supervisor side).
//
// Maintains ONE persistent, authenticated, bidirectional connection to the ControlPlane
// over its single port. WebSocket preferred; long-poll fallback for restrictive networks.
// Reconnects with exponential backoff and re-sends `hello` on every (re)connect so the
// ControlPlane always has a live session — this is what survives worker updates + reboots.
//
// TODO: real WS client (ws) + long-poll fallback (GET /agent/poll, POST /agent/push).

import WebSocket from "ws";
import { upMessage, assertEnvelope } from "../../shared/protocol/control-channel.mjs";

export function createConnection({ controlPlaneUrl, controlChannelPath = "/agent/channel", nodeId, nodeCredential, intervals = {}, onMessage, onOpen, onClose, logger = console } = {}) {
  const wsUrl = toWs(`${controlPlaneUrl}${controlChannelPath}`);
  const headers = { authorization: `Bearer ${nodeCredential}`, "x-node-id": nodeId };
  const outbox = [];
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
    const ws = new WebSocket(wsUrl, { headers });
    socket = ws;
    ws.on("open", () => {
      attempt = 0;
      flush();
      onOpen?.();
    });
    ws.on("message", (data) => {
      let msg;
      try {
        msg = assertEnvelope(JSON.parse(data.toString()));
      } catch {
        return;
      }
      onMessage?.(msg);
    });
    ws.on("close", () => {
      socket = null;
      onClose?.();
      if (!closed) setTimeout(connect, backoff());
    });
    ws.on("error", (e) => logger.warn?.(`[connection] ws error: ${e.message}`));
  }

  function flush() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (outbox.length) socket.send(JSON.stringify(outbox.shift()));
  }

  return {
    start() {
      closed = false;
      connect();
    },
    /** Send an UP envelope. */
    send(envelope) {
      assertEnvelope(envelope);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(envelope));
        return true;
      }
      if (outbox.length < 1000) outbox.push(envelope); // bounded buffer until (re)connect
      return false;
    },
    sendUp(type, payload, opts) {
      return this.send(upMessage(type, payload, { nodeName: nodeId, ...opts }));
    },
    close() {
      closed = true;
      socket?.close?.();
      socket = null;
    },
    get headers() {
      return headers;
    },
  };
}

function toWs(httpUrl) {
  return httpUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
}
