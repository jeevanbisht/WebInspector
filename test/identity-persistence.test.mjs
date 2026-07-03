// Node-identity persistence tests.
//
// A restarted ControlPlane must still recognize already-enrolled nodes: credentials +
// enrollment tokens are written through to the store and re-hydrated on startup, so agents
// reconnect without re-enrolling. Node inventory is likewise recovered (as last-known).

import test from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStateStore } from "../control-plane/state/store.mjs";
import { memoryAdapter } from "../control-plane/state/adapters/memory.mjs";
import { createEnrollmentService } from "../control-plane/control/enrollment.mjs";
import { createRegistry } from "../control-plane/control/registry.mjs";
import { createControlPlaneServer } from "../control-plane/server/index.mjs";

test("enrollment: credential + single-use token survive a fresh service (restart)", async () => {
  const store = createStateStore(memoryAdapter());
  await store.init();

  const a = createEnrollmentService({ store });
  const { token } = a.issueToken({ nodeType: "azure_direct" });
  const enr = a.enroll({ enrollmentToken: token, identity: { nodeName: "VM1", nodeType: "azure_direct" } });

  // A brand-new service on the SAME store = a restarted ControlPlane.
  const b = createEnrollmentService({ store });
  await b.load();
  assert.equal(b.verifyCredential(enr.nodeId, enr.nodeCredential), true, "credential recovered after restart");
  assert.equal(b.verifyCredential(enr.nodeId, "nodecred_wrong"), false);
  // the consumed enrollment token is still single-use after restart
  assert.throws(() => b.enroll({ enrollmentToken: token, identity: { nodeName: "VM1", nodeType: "azure_direct" } }), /already used/);
});

test("enrollment: revocation persists across a restart", async () => {
  const store = createStateStore(memoryAdapter());
  await store.init();
  const a = createEnrollmentService({ store });
  const { token } = a.issueToken({ nodeType: "gsa_client" });
  const enr = a.enroll({ enrollmentToken: token, identity: { nodeName: "C1", nodeType: "gsa_client" } });
  assert.equal(a.revokeCredential(enr.nodeId), true);

  const b = createEnrollmentService({ store });
  await b.load();
  assert.equal(b.verifyCredential(enr.nodeId, enr.nodeCredential), false, "revoked credential stays revoked after restart");
});

test("registry: last-known node inventory is recovered (as disconnected)", async () => {
  const store = createStateStore(memoryAdapter());
  await store.init();
  const a = createRegistry({ store });
  a.register({ nodeName: "D1", nodeType: "azure_direct", versions: { agentVersion: "3.0.0" }, metadata: { publicIp: "20.0.0.1" } });

  const b = createRegistry({ store });
  await b.load();
  const node = b.listAll().find((n) => n.nodeName === "D1");
  assert.ok(node, "node recovered into inventory");
  assert.equal(node.status, "disconnected", "recovered nodes are disconnected until they reconnect");
  assert.equal(b.listConnected().length, 0, "no live sessions after restart");
});

test("server: a restarted CP (same SQLite dir) still verifies an enrolled node's credential", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wi-id-"));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const cfg = { server: { port: 8842 }, baseUrl: "http://127.0.0.1:8842", state: { driver: "sqlite", dir } };

  const a = createControlPlaneServer(cfg);
  await a.listen(8842);
  const { token } = a.services.enrollment.issueToken({ nodeType: "azure_direct" });
  const enr = a.services.enrollment.enroll({ enrollmentToken: token, identity: { nodeName: "VM9", nodeType: "azure_direct" } });
  await new Promise((r) => setTimeout(r, 150)); // let write-through flush
  await a.close();

  const b = createControlPlaneServer({ ...cfg, server: { port: 8843 }, baseUrl: "http://127.0.0.1:8843" });
  await b.listen(8843); // listen() hydrates identity from the store
  try {
    assert.equal(b.services.enrollment.verifyCredential(enr.nodeId, enr.nodeCredential), true, "enrolled node recognized after CP restart");
  } finally {
    await b.close();
  }
});
