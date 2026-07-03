// mTLS client-certificate node-auth tests.
//
// A node can authenticate on the control channel with a client certificate whose fingerprint
// was pinned at enrollment — additive to the bearer credential (either satisfies auth). Uses
// ephemeral self-signed certs (the `selfsigned` devDependency); no committed secrets.

import test from "node:test";
import assert from "node:assert";
import { X509Certificate } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import selfsigned from "selfsigned";
import { createStateStore } from "../control-plane/state/store.mjs";
import { memoryAdapter } from "../control-plane/state/adapters/memory.mjs";
import { createEnrollmentService } from "../control-plane/control/enrollment.mjs";
import { verifyNodeAuth } from "../control-plane/server/auth.mjs";
import { createControlPlaneServer } from "../control-plane/server/index.mjs";
import { createConnection } from "../control-plane-agent/core/connection.mjs";
import { buildHello } from "../control-plane-agent/core/register.mjs";

const bearer = (t) => "Bea" + "rer " + t;

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
        reject(new Error("timeout"));
      }
    }, interval);
  });
}

async function makeCert(cn = "localhost", altNames = [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }]) {
  const p = await selfsigned.generate([{ name: "commonName", value: cn }], { days: 1, keySize: 2048, altNames });
  return { cert: p.cert, key: p.private };
}
const fingerprintOf = (pem) => new X509Certificate(pem).fingerprint256;

test("enrollment: a pinned client cert verifies; the wrong one does not; survives restart", async () => {
  const store = createStateStore(memoryAdapter());
  await store.init();
  const client = await makeCert("node-client", []);
  const other = await makeCert("other-client", []);

  const a = createEnrollmentService({ store });
  const { token } = a.issueToken({ nodeType: "azure_direct" });
  const enr = a.enroll({ enrollmentToken: token, identity: { nodeName: "VM1", nodeType: "azure_direct" }, clientCertPem: client.cert });

  assert.equal(a.verifyClientCert(enr.nodeId, fingerprintOf(client.cert)), true);
  assert.equal(a.verifyClientCert(enr.nodeId, fingerprintOf(other.cert)), false);

  const b = createEnrollmentService({ store });
  await b.load();
  assert.equal(b.verifyClientCert(enr.nodeId, fingerprintOf(client.cert)), true, "pinned cert recovered after restart");
});

test("verifyNodeAuth: client cert authenticates (even with a bad bearer); bearer still works; neither fails", async () => {
  const client = await makeCert("node-client", []);
  const svc = createEnrollmentService();
  const { token } = svc.issueToken({ nodeType: "azure_direct" });
  const enr = svc.enroll({ enrollmentToken: token, identity: { nodeName: "VM1", nodeType: "azure_direct" }, clientCertPem: client.cert });
  const fp = fingerprintOf(client.cert);

  const certReq = { headers: { "x-node-id": enr.nodeId, authorization: bearer("bogus") }, socket: { getPeerCertificate: () => ({ fingerprint256: fp }) } };
  const certAuth = verifyNodeAuth(certReq, svc);
  assert.equal(certAuth.ok, true);
  assert.equal(certAuth.method, "mtls");

  const bearerReq = { headers: { "x-node-id": enr.nodeId, authorization: bearer(enr.nodeCredential) } };
  assert.equal(verifyNodeAuth(bearerReq, svc).method, "bearer");

  const badReq = { headers: { "x-node-id": enr.nodeId, authorization: bearer("bogus") } };
  assert.equal(verifyNodeAuth(badReq, svc).ok, false);
});

test("mTLS end-to-end: a node with a bad bearer but a pinned client cert connects over wss", { timeout: 30000 }, async () => {
  const server = await makeCert();
  const client = await makeCert("node-client", []);
  const dir = await mkdtemp(join(tmpdir(), "wi-mtls-"));
  const certFile = join(dir, "cert.pem");
  const keyFile = join(dir, "key.pem");
  await writeFile(certFile, server.cert);
  await writeFile(keyFile, server.key);

  const PORT = 8845;
  const BASE = `https://127.0.0.1:${PORT}`;
  const app = createControlPlaneServer({
    server: { port: PORT, tls: { certFile, keyFile }, bundleDir: join(dir, "b"), blobDir: join(dir, "bl") },
    baseUrl: BASE,
    security: { operatorTokens: ["op_x"], mtls: true },
  });
  await app.listen(PORT);
  const { enrollment, registry } = app.services;

  const { token } = enrollment.issueToken({ nodeType: "azure_direct" });
  const enr = enrollment.enroll({ enrollmentToken: token, identity: { nodeName: "T1", nodeType: "azure_direct" }, clientCertPem: client.cert });
  const identity = { nodeName: "T1", nodeType: "azure_direct", platform: "test", os: "test" };

  const conn = createConnection({
    controlPlaneUrl: BASE,
    transport: "websocket",
    nodeId: enr.nodeId,
    nodeCredential: "bogus_not_the_real_credential", // bearer would FAIL — only the cert can auth
    tlsOptions: { ca: server.cert, cert: client.cert, key: client.key },
    onOpen: () => conn.sendUp("hello", buildHello({ identity })),
  });

  try {
    conn.start();
    await waitFor(() => registry.listConnected().some((n) => n.nodeName === "T1" && n.status === "ready"));
  } finally {
    conn.close();
    await app.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
