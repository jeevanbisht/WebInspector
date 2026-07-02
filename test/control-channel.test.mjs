// End-to-end control-channel transport test.
//
// Proves the single-port WebSocket control plane works both directions:
//   enroll → connect (authenticated) → hello/register → server-dispatched command → command_result
//
// Uses the REAL client (control-plane-agent/core/connection.mjs) and the REAL supervisor
// command router against the REAL ControlPlane server. No mocks on the wire.

import test from "node:test";
import assert from "node:assert";
import { createControlPlaneServer } from "../control-plane/server/index.mjs";
import { createConnection } from "../control-plane-agent/core/connection.mjs";
import { buildHello } from "../control-plane-agent/core/register.mjs";
import { createCommandRouter } from "../control-plane-agent/commands/index.mjs";

const PORT = 8793;
const BASE = `http://127.0.0.1:${PORT}`;

function waitFor(cond, { timeout = 5000, interval = 25 } = {}) {
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

test("control channel: enroll -> connect -> register -> command round-trip", async () => {
  const app = createControlPlaneServer({ server: { port: PORT }, baseUrl: BASE });
  await app.listen(PORT);
  const { registry, dispatcher, enrollment } = app.services;

  // Mint a node credential the same way the bootstrap does.
  const { token } = enrollment.issueToken({ nodeType: "azure_direct" });
  const enr = enrollment.enroll({ enrollmentToken: token, identity: { nodeName: "VM1", nodeType: "azure_direct" } });

  // Client side: real connection + real supervisor command router.
  let router;
  const connection = createConnection({
    controlPlaneUrl: BASE,
    nodeId: enr.nodeId,
    nodeCredential: enr.nodeCredential,
    onOpen: () => connection.sendUp("hello", buildHello({ identity: { nodeName: "VM1", nodeType: "azure_direct", platform: "test", os: "test" } })),
    onMessage: (msg) => {
      if (msg.type === "command") router.handle(msg);
    },
  });
  router = createCommandRouter({
    platform: { name: "test" },
    workerManager: { isDraining: () => false, status: () => ({}), runJob: async () => ({ accepted: true }) },
    updater: {},
    connection,
    identity: { nodeName: "VM1", nodeType: "azure_direct" },
  });

  try {
    connection.start();

    // Upstream: the node registers and becomes ready.
    await waitFor(() => registry.listConnected().some((n) => n.nodeName === "VM1" && n.status === "ready"));
    const node = registry.listConnected().find((n) => n.nodeName === "VM1");
    assert.equal(node.nodeType, "azure_direct");

    // Downstream: server dispatches a command; command_result must clear the in-flight slot.
    const commandId = await dispatcher.sendCommand("VM1", "ping");
    assert.ok(commandId, "dispatch returns a commandId");
    assert.equal(dispatcher.hasInFlightCommand("VM1", "ping"), true);
    await waitFor(() => dispatcher.hasInFlightCommand("VM1", "ping") === false);
  } finally {
    connection.close();
    await app.close();
  }
});

test("control channel: bad credential is rejected", async () => {
  const app = createControlPlaneServer({ server: { port: PORT + 1 }, baseUrl: `http://127.0.0.1:${PORT + 1}` });
  await app.listen(PORT + 1);
  const { registry } = app.services;
  let closedSeen = false;
  const connection = createConnection({
    controlPlaneUrl: `http://127.0.0.1:${PORT + 1}`,
    nodeId: "azure_direct:BOGUS",
    nodeCredential: "nodecred_not_real",
    onClose: () => {
      closedSeen = true;
    },
  });
  try {
    connection.start();
    await waitFor(() => closedSeen === true);
    assert.equal(registry.listConnected().length, 0, "unauthenticated node must not register");
  } finally {
    connection.close();
    await app.close();
  }
});
