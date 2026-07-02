// End-to-end data-plane test.
//
// Proves bulk transfer works both directions on the single port, off the control channel:
//   - publish a bundle (PUT) then stream it back (GET) with matching bytes + SHA-256
//   - upload an artifact (node-authenticated) then serve it back by content hash
//   - integrity: a mismatched SHA-256 is rejected; unauthenticated upload is rejected

import test from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlaneServer } from "../control-plane/server/index.mjs";

const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

test("data plane: publish/stream bundle + upload/serve artifact + integrity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wi-dp-"));
  const app = createControlPlaneServer({ server: { port: PORT, bundleDir: join(dir, "bundles"), blobDir: join(dir, "blobs") }, baseUrl: BASE });
  await app.listen(PORT);
  try {
    // --- bundle publish (PUT) + stream (GET) ---
    const bundleBytes = Buffer.from("PK\u0003\u0004 fake-zip agent 9.9.9");
    const pub = await fetch(`${BASE}/agent/updates/agent/9.9.9/bundle`, { method: "PUT", body: bundleBytes });
    assert.equal(pub.status, 201);
    assert.equal((await pub.json()).sha256, sha(bundleBytes));
    assert.equal(app.services.bundleRegistry.get("agent", "9.9.9")?.sha256, sha(bundleBytes));

    const got = await fetch(`${BASE}/agent/updates/agent/9.9.9/bundle`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("x-bundle-sha256"), sha(bundleBytes));
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), bundleBytes);

    // --- artifact upload (node-authenticated) + serve ---
    const { token } = app.services.enrollment.issueToken({ nodeType: "azure_direct" });
    const enr = app.services.enrollment.enroll({ enrollmentToken: token, identity: { nodeName: "VM1", nodeType: "azure_direct" } });
    const png = Buffer.from("\u0089PNG fake screenshot bytes");
    const up = await fetch(`${BASE}/api/artifacts/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${enr.nodeCredential}`, "x-node-id": enr.nodeId, "x-artifact-kind": "screenshot", "x-artifact-sha256": sha(png), "content-type": "image/png" },
      body: png,
    });
    assert.equal(up.status, 201);
    const upBody = await up.json();
    assert.equal(upBody.artifactId, sha(png));

    const artGot = await fetch(`${BASE}${upBody.url}`);
    assert.equal(artGot.status, 200);
    assert.equal(artGot.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await artGot.arrayBuffer()), png);

    // --- integrity: mismatched SHA-256 is rejected ---
    const bad = await fetch(`${BASE}/api/artifacts/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${enr.nodeCredential}`, "x-node-id": enr.nodeId, "x-artifact-kind": "har", "x-artifact-sha256": "deadbeef", "content-type": "application/json" },
      body: Buffer.from("{}"),
    });
    assert.equal(bad.status, 400);

    // --- unauthenticated upload is rejected ---
    const noauth = await fetch(`${BASE}/api/artifacts/upload`, { method: "POST", body: Buffer.from("x") });
    assert.equal(noauth.status, 401);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
