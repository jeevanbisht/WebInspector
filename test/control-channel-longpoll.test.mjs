// Control-channel long-poll transport tests.
//
// Proves the HTTP long-poll fallback carries the same bidirectional flow as the WebSocket
// path, against the REAL ControlPlane server and the REAL supervisor command router:
//   enroll -> push(hello)/poll -> register -> server-dispatched command -> command_result
// and that "auto" transport transparently fails over to long-poll when a WebSocket upgrade
// is refused.

import test from "node:test";
import assert from "node:assert";
import { createControlPlaneServer } from "../control-plane/server/index.mjs";
import { createConnection } from "../control-plane-agent/core/connection.mjs";
import { buildHello } from "../control-plane-agent/core/register.mjs";
import { createCommandRouter } from "../control-plane-agent/commands/index.mjs";

function waitFor(cond, { timeout = 8000, interval = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      let ok = false;
      try {
        ok = cond();
      } catch {
        ok = false;
      }
      if (ok) {
        clearInterval(t);
        resolve(true);
      } else if (Date.now() - start > timeout) {
        clearInterval(t);
        reject(new Error("timeout waiting for condition"));
      }
    }, interval);
  });
}

function fakeSupervisor(connection, identity) {
  const router = createCommandRouter({
    platform: { name: "test" },
    workerManager: { isDraining: () => false, status: () => ({}), runJob: async () => ({ accepted: true }) },
    updater: {},
    connection,
    identity,
  });
  return router;
}

test("control channel (long-poll): register + command round-trip", { timeout: 20000 }, async () => {
  const PORT = 8795;
  const BASE = `http://127.0.0.1:${PORT}`;
  const app = createControlPlaneServer({ server: { port: PORT }, baseUrl: BASE });
  await app.listen(PORT);
  const { registry, dispatcher, enrollment } = app.services;

  const { token } = enrollment.issueToken({ nodeType: "azure_direct" });
  const enr = enrollment.enroll({ enrollmentToken: token, identity: { nodeName: "LP1", nodeType: "azure_direct" } });

  const identity = { nodeName: "LP1", nodeType: "azure_direct", platform: "test", os: "test" };
  let router;
  const connection = createConnection({
    controlPlaneUrl: BASE,
    transport: "longpoll",
    nodeId: enr.nodeId,
    nodeCredential: enr.nodeCredential,
    intervals: { reconnectBaseMs: 25, reconnectMaxMs: 100 },
    onOpen: () => connection.sendUp("hello", buildHello({ identity })),
    onMessage: (msg) => {
      if (msg.type === "command") router.handle(msg);
    },
  });
  router = fakeSupervisor(connection, { nodeName: "LP1", nodeType: "azure_direct" });

  try {
    connection.start();
    assert.equal(connection.transport, "longpoll");

    // Upstream over POST /agent/push: the node registers and becomes ready.
    await waitFor(() => registry.listConnected().some((n) => n.nodeName === "LP1" && n.status === "ready"));

    // Downstream over the held GET /agent/poll: a command is delivered and answered.
    const commandId = await dispatcher.sendCommand("LP1", "ping");
    assert.ok(commandId, "dispatch returns a commandId");
    assert.equal(dispatcher.hasInFlightCommand("LP1", "ping"), true);
    await waitFor(() => dispatcher.hasInFlightCommand("LP1", "ping") === false);
  } finally {
    connection.close();
    await app.close();
  }
});

test("control channel (auto): WebSocket refused -> falls back to long-poll", { timeout: 20000 }, async () => {
  const PORT = 8796;
  const BASE = `http://127.0.0.1:${PORT}`;
  const app = createControlPlaneServer({ server: { port: PORT }, baseUrl: BASE });
  await app.listen(PORT);
  const { registry, enrollment } = app.services;

  const { token } = enrollment.issueToken({ nodeType: "gsa_client" });
  const enr = enrollment.enroll({ enrollmentToken: token, identity: { nodeName: "AF1", nodeType: "gsa_client" } });

  const identity = { nodeName: "AF1", nodeType: "gsa_client", platform: "test", os: "test" };
  const connection = createConnection({
    controlPlaneUrl: BASE,
    controlChannelPath: "/agent/no-such-ws", // upgrade is refused -> triggers failover
    transport: "auto",
    nodeId: enr.nodeId,
    nodeCredential: enr.nodeCredential,
    intervals: { reconnectBaseMs: 25, reconnectMaxMs: 100, wsFailoverAfter: 1 },
    onOpen: () => connection.sendUp("hello", buildHello({ identity })),
  });

  try {
    connection.start();
    await waitFor(() => connection.transport === "longpoll");
    await waitFor(() => registry.listConnected().some((n) => n.nodeName === "AF1" && n.status === "ready"));
  } finally {
    connection.close();
    await app.close();
  }
});
