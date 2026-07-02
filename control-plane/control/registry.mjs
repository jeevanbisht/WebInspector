// Connected-agent registry (ControlPlane side).
//
// Tracks every node that has a control-channel session: identity, versions, metadata,
// status, heartbeats, and the transport session used to push commands. Feeds the
// reconciler (desired-state), the dispatcher (where to send), and the Portal (visibility).

import { NODE_STATUSES } from "../../shared/contracts/nodes.mjs";

export function createRegistry({ store = null, heartbeatStaleMs = 120000 } = {}) {
  const nodes = new Map(); // nodeId -> record
  const sessions = new Map(); // nodeId -> transport session { send(envelope), close() }

  function idOf(nodeName, nodeType) {
    return `${nodeType}:${nodeName}`;
  }

  function upsert(nodeId, patch) {
    const prev = nodes.get(nodeId) || { nodeId, status: "unregistered", versions: {}, metadata: {} };
    const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    nodes.set(nodeId, next);
    // TODO: store?.putNode(next)
    return next;
  }

  return {
    /** Attach a transport session when a control channel opens. */
    attachSession(nodeId, session) {
      sessions.set(nodeId, session);
      return upsert(nodeId, { status: "connected", connectedAt: new Date().toISOString() });
    },
    detachSession(nodeId) {
      sessions.delete(nodeId);
      return upsert(nodeId, { status: "disconnected" });
    },
    getSession(nodeId) {
      return sessions.get(nodeId) || null;
    },

    /** Push an envelope down the channel to a node. */
    send(nodeName, envelope, nodeType) {
      const nodeId = nodeName.includes(":") ? nodeName : idOf(nodeName, nodeType || nodes.get(nodeName)?.nodeType);
      const session = sessions.get(nodeId) || [...sessions.entries()].find(([id]) => id.endsWith(`:${nodeName}`))?.[1];
      if (!session) throw new Error(`no live session for ${nodeName}`);
      return session.send(envelope);
    },

    /** Record a hello (registration). */
    register(hello) {
      const nodeId = idOf(hello.nodeName, hello.nodeType);
      return upsert(nodeId, {
        nodeName: hello.nodeName,
        nodeType: hello.nodeType,
        versions: hello.versions || {},
        metadata: hello.metadata || {},
        capabilities: hello.capabilities || {},
        status: "ready",
        registeredAt: new Date().toISOString(),
      });
    },

    heartbeat(nodeName, payload = {}) {
      const nodeId = idOf(nodeName, payload.nodeType);
      return upsert(nodeId, {
        lastHeartbeatAt: new Date().toISOString(),
        status: payload.status && NODE_STATUSES.includes(payload.status) ? payload.status : nodes.get(nodeId)?.status,
        versions: payload.versions || nodes.get(nodeId)?.versions,
        metadata: payload.metadata || nodes.get(nodeId)?.metadata,
      });
    },

    setStatus(nodeId, status) {
      if (!NODE_STATUSES.includes(status)) throw new Error(`invalid node status: ${status}`);
      return upsert(nodeId, { status });
    },

    get(nodeId) {
      return nodes.get(nodeId) || null;
    },
    listAll() {
      return [...nodes.values()];
    },
    /** Nodes with a live session — the reconciler + dispatcher operate on these. */
    listConnected() {
      return [...nodes.values()].filter((n) => sessions.has(n.nodeId));
    },

    /** Watchdog: flag nodes whose heartbeat is stale. */
    sweepStaleHeartbeats(now = Date.now()) {
      for (const n of nodes.values()) {
        if (!n.lastHeartbeatAt) continue;
        if (now - Date.parse(n.lastHeartbeatAt) > heartbeatStaleMs && n.status === "ready") {
          upsert(n.nodeId, { status: "heartbeat_missing" });
        }
      }
    },
  };
}
