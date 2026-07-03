// Control-channel WebSocket transport (ControlPlane side).
//
// Terminates the single-port control channel: authenticates the upgrade with the node
// credential, binds a session into the registry, and routes inbound UP messages to the
// registry / dispatcher / reboot manager. Outbound DOWN messages are sent through the
// session the registry holds.
//
// Two transports share one auth check and one inbound router: a WebSocket (preferred) and an
// HTTP long-poll fallback (GET /agent/poll + POST /agent/push) for networks that block WS
// upgrades. Both attach an equivalent `session` into the registry, so the dispatcher / reboot
// manager push DOWN messages the same way regardless of how the node is connected.

import { WebSocketServer } from "ws";
import { downMessage, assertEnvelope } from "../../shared/protocol/control-channel.mjs";
import { verifyNodeAuth } from "./auth.mjs";

export function attachControlChannel(server, services, { baseUrl = "http://localhost", longPollTimeoutMs = 25000, idleMs = 60000 } = {}) {
  const { registry } = services;
  const wss = new WebSocketServer({ noServer: true });
  const lpSessions = new Map(); // nodeId -> long-poll session state

  server.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, baseUrl).pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/agent/channel") {
      socket.destroy();
      return;
    }
    const auth = verifyNodeAuth(req, services.enrollment);
    if (!auth.ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, auth.nodeId));
  });

  function onConnection(ws, nodeId) {
    const [nodeType, ...rest] = nodeId.split(":");
    const nodeName = rest.join(":");
    const session = {
      nodeId,
      nodeName,
      nodeType,
      send(envelope) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(envelope));
      },
      close() {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      },
    };
    registry.attachSession(nodeId, session);
    session.send(downMessage("hello_ack", { sessionId: nodeId, desiredVersions: services.updateManager.getDesired() }, { sessionId: nodeId }));

    ws.on("message", (data) => {
      let msg;
      try {
        msg = assertEnvelope(JSON.parse(data.toString()));
      } catch {
        return; // ignore malformed frames
      }
      handleInbound(services, session, msg);
    });
    ws.on("close", () => registry.detachSession(nodeId));
    ws.on("error", () => {
      /* transport error; close handler will detach */
    });
  }

  // ---- long-poll fallback transport (same auth + inbound router as WS) ----
  //
  // A node that cannot open a WebSocket instead:
  //   - POSTs UP envelopes to /agent/push
  //   - GETs /agent/poll, which is held open until a DOWN message is queued (or it times out)
  // The per-node session buffers DOWN messages and hands them to whichever poll is waiting.
  function getLpSession(nodeId) {
    const existing = lpSessions.get(nodeId);
    if (existing) {
      existing.lastSeen = Date.now();
      return existing;
    }
    const [nodeType, ...rest] = nodeId.split(":");
    const nodeName = rest.join(":");
    const session = {
      nodeId,
      nodeName,
      nodeType,
      transport: "longpoll",
      queue: [],
      waiter: null, // { res, timer } — a held-open GET /agent/poll
      lastSeen: Date.now(),
      send(envelope) {
        this.queue.push(envelope);
        this.flushWaiter();
      },
      flushWaiter() {
        if (this.waiter && this.queue.length) {
          const { res, timer } = this.waiter;
          this.waiter = null;
          clearTimeout(timer);
          respondJson(res, 200, this.queue.splice(0));
        }
      },
      close() {
        if (this.waiter) {
          clearTimeout(this.waiter.timer);
          respondJson(this.waiter.res, 200, []);
          this.waiter = null;
        }
      },
    };
    lpSessions.set(nodeId, session);
    registry.attachSession(nodeId, session);
    session.send(downMessage("hello_ack", { sessionId: nodeId, desiredVersions: services.updateManager.getDesired() }, { sessionId: nodeId }));
    return session;
  }

  function detachLp(nodeId) {
    const session = lpSessions.get(nodeId);
    if (!session) return;
    session.close();
    lpSessions.delete(nodeId);
    registry.detachSession(nodeId);
  }

  async function handlePush(req, res) {
    const auth = verifyNodeAuth(req, services.enrollment);
    if (!auth.ok) return respondJson(res, 401, { error: "invalid node credential" });
    const session = getLpSession(auth.nodeId);
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return respondJson(res, 400, { error: "invalid json" });
    }
    const frames = Array.isArray(body) ? body : [body];
    for (const raw of frames) {
      let msg;
      try {
        msg = assertEnvelope(raw);
      } catch {
        continue; // ignore malformed frames, like the WS path
      }
      handleInbound(services, session, msg);
    }
    return respondJson(res, 202, { ok: true });
  }

  function handlePoll(req, res) {
    const auth = verifyNodeAuth(req, services.enrollment);
    if (!auth.ok) return respondJson(res, 401, { error: "invalid node credential" });
    const session = getLpSession(auth.nodeId);
    if (session.queue.length) return respondJson(res, 200, session.queue.splice(0));
    // Nothing queued: hold the request open until a DOWN message arrives or we time out.
    if (session.waiter) {
      clearTimeout(session.waiter.timer);
      respondJson(session.waiter.res, 200, []);
      session.waiter = null;
    }
    const timer = setTimeout(() => {
      if (session.waiter && session.waiter.res === res) {
        session.waiter = null;
        respondJson(res, 200, []);
      }
    }, longPollTimeoutMs);
    timer.unref?.();
    session.waiter = { res, timer };
    req.on("close", () => {
      if (session.waiter && session.waiter.res === res) {
        clearTimeout(timer);
        session.waiter = null;
      }
    });
  }

  // Long-poll has no socket-close event, so reap sessions that stop polling/pushing.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [nodeId, session] of lpSessions) {
      if (!session.waiter && now - session.lastSeen > idleMs) detachLp(nodeId);
    }
  }, Math.max(5000, Math.floor(idleMs / 2)));
  sweeper.unref?.();

  return {
    wss,
    handlePush,
    handlePoll,
    close() {
      clearInterval(sweeper);
      for (const nodeId of [...lpSessions.keys()]) detachLp(nodeId);
      wss.close();
    },
  };
}

function handleInbound(services, session, msg) {
  const { registry, dispatcher, reboot, store } = services;
  const p = msg.payload || {};
  switch (msg.type) {
    case "hello": {
      registry.register({ nodeName: session.nodeName, nodeType: session.nodeType, versions: p.versions, metadata: p.metadata, capabilities: p.capabilities });
      reboot?.onReconnect?.(session.nodeName);
      break;
    }
    case "heartbeat":
      registry.heartbeat(session.nodeName, { ...p, nodeType: session.nodeType });
      break;
    case "status":
      if (p.status) {
        try {
          registry.setStatus(session.nodeId, p.status);
        } catch {
          /* invalid status ignored */
        }
      }
      break;
    case "command_result":
      dispatcher.onCommandResult(session.nodeName, p);
      break;
    case "result":
      services.orchestrator?.onResult(session.nodeName, p);
      break;
    case "result_ref":
    case "artifact_ref": {
      const pr = store?.put?.("artifacts", `${p.sha256 || Date.now()}-${session.nodeName}`, { ...p, nodeName: session.nodeName });
      pr?.catch?.(() => {});
      break;
    }
    case "bye":
    case "pong":
    default:
      break;
  }
}

// --- long-poll HTTP helpers ---
function respondJson(res, status, body) {
  if (res.writableEnded) return;
  const s = JSON.stringify(body);
  try {
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
    res.end(s);
  } catch {
    /* client already gone */
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
