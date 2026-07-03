// Probe tests — the layered initial probe against local servers (hermetic).

import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { initialTest } from "../agent/probe/initial-test.mjs";

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}
const close = (srv) => new Promise((r) => srv.close(r));

test("probe: 200 OK -> ok with dns + tcp layers", async () => {
  const { srv, port } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello");
  });
  try {
    const r = await initialTest(`http://127.0.0.1:${port}/`);
    assert.equal(r.ok, true);
    assert.equal(r.reason, "OK");
    assert.equal(r.http.status, 200);
    assert.equal(r.dns.ok, true);
    assert.equal(r.tcp.ok, true);
    assert.equal(r.tls, null); // plain http
    assert.ok(r.contentLength >= 5);
  } finally {
    await close(srv);
  }
});

test("probe: redirect chain is captured", async () => {
  const { srv, port } = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(302, { location: "/final" });
      res.end();
    } else {
      res.writeHead(200);
      res.end("done");
    }
  });
  try {
    const r = await initialTest(`http://127.0.0.1:${port}/`);
    assert.equal(r.ok, true);
    assert.equal(r.redirectChain.length, 1);
    assert.equal(r.redirectChain[0].status, 302);
    assert.ok(r.finalUrl.endsWith("/final"));
  } finally {
    await close(srv);
  }
});

test("probe: 403 with edge headers -> vendor + reference ids", async () => {
  const { srv, port } = await startServer((req, res) => {
    res.writeHead(403, { server: "cloudflare", "cf-ray": "7a1b2c3d4e5f-SJC" });
    res.end("blocked");
  });
  try {
    const r = await initialTest(`http://127.0.0.1:${port}/`);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "HTTP_403");
    assert.equal(r.vendor, "Cloudflare");
    assert.equal(r.referenceIds["cf-ray"], "7a1b2c3d4e5f-SJC");
  } finally {
    await close(srv);
  }
});

test("probe: connection refused -> TCP_FAILURE at the tcp layer", async () => {
  const { srv, port } = await startServer(() => {});
  await close(srv); // free the port so connects are refused
  const r = await initialTest(`http://127.0.0.1:${port}/`, { timeoutMs: 3000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "TCP_FAILURE");
  assert.equal(r.failureLayer, "tcp");
  assert.equal(r.dns.ok, true);
});
