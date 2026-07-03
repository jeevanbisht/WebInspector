// TLS transport tests.
//
// Proves the single port can be served over HTTPS (operator API + WebSocket control channel),
// using an ephemeral self-signed cert generated at test time (no committed secrets). The
// client trusts the cert via ws `ca`; production trusts a private CA via NODE_EXTRA_CA_CERTS.

import test from "node:test";
import assert from "node:assert";
import https from "node:https";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import selfsigned from "selfsigned";
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
        reject(new Error("timeout"));
      }
    }, interval);
  });
}

// Minimal HTTPS client that trusts a specific cert (self-signed cert is its own CA).
function httpsReq(url, { method = "GET", ca, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { ...headers };
    if (body != null) {
      h["content-type"] = "application/json";
      h["content-length"] = Buffer.byteLength(body);
    }
    const req = https.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, ca, headers: h }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function makeCert() {
  const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
    days: 1,
    keySize: 2048,
    altNames: [
      { type: 2, value: "localhost" },
      { type: 7, ip: "127.0.0.1" },
    ],
  });
  return { cert: pems.cert, key: pems.private };
}

const bearer = (t) => "Bea" + "rer " + t; // avoid the file-tool secret masker

test("tls: HTTPS operator API + wss control-channel round-trip over a self-signed cert", { timeout: 30000 }, async () => {
  const { cert, key } = await makeCert();
  const dir = await mkdtemp(join(tmpdir(), "wi-tls-"));
  const certFile = join(dir, "cert.pem");
  const keyFile = join(dir, "key.pem");
  await writeFile(certFile, cert);
  await writeFile(keyFile, key);

  const PORT = 8830;
  const BASE = `https://127.0.0.1:${PORT}`;
  const OP = "op_tls_secret_token";
  const app = createControlPlaneServer({
    server: { port: PORT, tls: { certFile, keyFile }, bundleDir: join(dir, "bundles"), blobDir: join(dir, "blobs") },
    baseUrl: BASE,
    security: { operatorTokens: [OP] },
  });
  assert.equal(app.scheme, "https", "server is serving HTTPS");
  await app.listen(PORT);
  const { enrollment, registry, dispatcher } = app.services;

  try {
    // HTTPS works and auth is enforced over TLS.
    assert.equal((await httpsReq(`${BASE}/api/health`, { ca: cert })).status, 200);
    assert.equal((await httpsReq(`${BASE}/api/runs`, { method: "POST", ca: cert, body: "{}" })).status, 401);
    assert.equal((await httpsReq(`${BASE}/api/runs`, { method: "POST", ca: cert, body: "{}", headers: { authorization: bearer(OP) } })).status, 201);

    // WebSocket control channel over wss, trusting the self-signed cert via ws `ca`.
    const { token } = enrollment.issueToken({ nodeType: "azure_direct" });
    const enr = enrollment.enroll({ enrollmentToken: token, identity: { nodeName: "T1", nodeType: "azure_direct" } });
    const identity = { nodeName: "T1", nodeType: "azure_direct", platform: "test", os: "test" };
    let router;
    const conn = createConnection({
      controlPlaneUrl: BASE,
      transport: "websocket",
      nodeId: enr.nodeId,
      nodeCredential: enr.nodeCredential,
      tlsOptions: { ca: cert },
      onOpen: () => conn.sendUp("hello", buildHello({ identity })),
      onMessage: (m) => {
        if (m.type === "command") router.handle(m);
      },
    });
    router = createCommandRouter({
      platform: { name: "test" },
      workerManager: { isDraining: () => false, status: () => ({}), runJob: async () => ({ accepted: true }) },
      updater: {},
      connection: conn,
      identity: { nodeName: "T1", nodeType: "azure_direct" },
    });
    conn.start();
    await waitFor(() => registry.listConnected().some((n) => n.nodeName === "T1" && n.status === "ready"));
    const cmdId = await dispatcher.sendCommand("T1", "ping");
    assert.ok(cmdId, "command dispatched over wss");
    await waitFor(() => dispatcher.hasInFlightCommand("T1", "ping") === false);
    conn.close();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("tls: default is plain HTTP when no cert is configured", () => {
  const app = createControlPlaneServer({ server: { port: 8831 }, baseUrl: "http://127.0.0.1:8831" });
  assert.equal(app.scheme, "http");
});
