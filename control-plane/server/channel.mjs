// Control-channel WebSocket transport (ControlPlane side).
//
// Terminates the single-port control channel: authenticates the upgrade with the node
// credential, binds a session into the registry, and routes inbound UP messages to the
// registry / dispatcher / reboot manager. Outbound DOWN messages are sent through the
// session the registry holds.
//
// WebSocket only for now; a long-poll fallback (GET /agent/poll + POST /agent/push) can be
// added behind the same auth without touching callers.

import { WebSocketServer } from "ws";
import { downMessage, assertEnvelope } from "../../shared/protocol/control-channel.mjs";
import { verifyNodeAuth } from "./auth.mjs";

export function attachControlChannel(server, services, { baseUrl = "http://localhost" } = {}) {
  const { registry } = services;
  const wss = new WebSocketServer({ noServer: true });

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

  return {
    wss,
    close() {
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
