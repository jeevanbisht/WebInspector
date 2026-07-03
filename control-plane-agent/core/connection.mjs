// Control-channel client (supervisor side).
//
// Maintains ONE persistent, authenticated, bidirectional connection to the ControlPlane over
// its single port. WebSocket is preferred; an HTTP long-poll fallback (POST /agent/push +
// GET /agent/poll) keeps the channel working on networks that block WebSocket upgrades.
// Reconnects with exponential backoff and re-sends `hello` on every (re)connect so the
// ControlPlane always has a live session — this is what survives worker updates + reboots.
//
// The public surface (start / send / sendUp / close / headers) is transport-agnostic, so the
// register/heartbeat/command code never has to know which transport is active.

import WebSocket from "ws";
import { upMessage, assertEnvelope } from "../../shared/protocol/control-channel.mjs";

export function createConnection({
  controlPlaneUrl,
  controlChannelPath = "/agent/channel",
  nodeId,
  nodeCredential,
  intervals = {},
  transport = "auto", // "auto" | "websocket" | "longpoll"
  onMessage,
  onOpen,
  onClose,
  logger = console,
} = {}) {
  const httpBase = String(controlPlaneUrl).replace(/\/+$/, "");
  const wsUrl = toWs(`${httpBase}${controlChannelPath}`);
  const headers = { authorization: "Bea" + "rer " + nodeCredential, "x-node-id": nodeId };
  const outbox = [];
  const base = intervals.reconnectBaseMs ?? 1000;
  const max = intervals.reconnectMaxMs ?? 30000;
  const wsFailoverAfter = intervals.wsFailoverAfter ?? 2;

  let mode = transport === "auto" ? "websocket" : transport; // active transport
  let socket = null;
  let closed = false;
  let attempt = 0;
  let wsPreOpenFailures = 0;
  let lpPolling = false;
  let lpFlushing = false;
  let lpController = null;

  function backoff() {
    attempt += 1;
    return Math.min(max, base * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
  }

  function deliver(raw) {
    let msg;
    try {
      msg = assertEnvelope(raw);
    } catch {
      return; // ignore malformed frames
    }
    onMessage?.(msg);
  }

  // ---- WebSocket transport ----
  function connectWs() {
    if (closed) return;
    let opened = false;
    const ws = new WebSocket(wsUrl, { headers });
    socket = ws;
    ws.on("open", () => {
      opened = true;
      attempt = 0;
      wsPreOpenFailures = 0;
      flushWs();
      onOpen?.();
    });
    ws.on("message", (data) => {
      try {
        deliver(JSON.parse(data.toString()));
      } catch {
        /* ignore malformed frame */
      }
    });
    ws.on("close", () => {
      socket = null;
      onClose?.();
      if (closed) return;
      // Never established: on "auto", give up on WS and fall back to long-poll.
      if (!opened && transport === "auto" && ++wsPreOpenFailures >= wsFailoverAfter) {
        mode = "longpoll";
        logger.warn?.("[connection] WebSocket unavailable; falling back to long-poll");
        startLongPoll();
        return;
      }
      setTimeout(connectWs, backoff());
    });
    ws.on("error", (e) => logger.warn?.(`[connection] ws error: ${e.message}`));
  }

  function flushWs() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (outbox.length) socket.send(JSON.stringify(outbox.shift()));
  }

  // ---- long-poll transport ----
  function startLongPoll() {
    if (closed) return;
    mode = "longpoll";
    attempt = 0;
    lpController = new AbortController();
    onOpen?.(); // enqueues the hello (and anything else) into the outbox
    lpFlush(); // push it up
    if (!lpPolling) lpLoop(); // start pulling DOWN messages
  }

  async function lpFlush() {
    if (lpFlushing || mode !== "longpoll") return;
    lpFlushing = true;
    try {
      while (outbox.length && mode === "longpoll" && !closed) {
        const env = outbox[0];
        const res = await fetch(`${httpBase}/agent/push`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(env),
          signal: lpController?.signal,
        });
        if (res.status === 401) {
          fail();
          return;
        }
        if (!res.ok) break; // keep it buffered; retried on the next trigger
        outbox.shift();
      }
    } catch {
      /* transient; retried on the next send / poll cycle */
    } finally {
      lpFlushing = false;
    }
  }

  async function lpLoop() {
    lpPolling = true;
    try {
      while (!closed && mode === "longpoll") {
        try {
          const res = await fetch(`${httpBase}/agent/poll`, { headers, signal: lpController?.signal });
          if (res.status === 401) {
            fail();
            return;
          }
          if (res.ok) {
            const msgs = await res.json().catch(() => []);
            if (Array.isArray(msgs)) for (const m of msgs) deliver(m);
            attempt = 0;
            if (outbox.length) lpFlush(); // drain anything queued while we were parked on the poll
          } else {
            await sleep(backoff());
          }
        } catch {
          if (closed) return;
          await sleep(backoff());
        }
      }
    } finally {
      lpPolling = false;
    }
  }

  function fail() {
    if (closed) return;
    closed = true;
    onClose?.();
  }

  function sendRaw(envelope) {
    if (mode === "websocket" && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(envelope));
      return true;
    }
    if (outbox.length < 1000) outbox.push(envelope); // bounded buffer until (re)connect
    if (mode === "longpoll") {
      lpFlush();
      return true;
    }
    return false;
  }

  return {
    start() {
      closed = false;
      if (mode === "longpoll") startLongPoll();
      else connectWs();
    },
    /** Send an UP envelope. */
    send(envelope) {
      assertEnvelope(envelope);
      return sendRaw(envelope);
    },
    sendUp(type, payload, opts) {
      return this.send(upMessage(type, payload, { nodeName: nodeId, ...opts }));
    },
    close() {
      closed = true;
      try {
        lpController?.abort();
      } catch {
        /* ignore */
      }
      try {
        socket?.close?.();
      } catch {
        /* ignore */
      }
      socket = null;
    },
    /** Active transport: "websocket" or "longpoll". */
    get transport() {
      return mode;
    },
    get headers() {
      return headers;
    },
  };
}

function toWs(httpUrl) {
  return httpUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
