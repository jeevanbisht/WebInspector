// Bootstrap onboarding tests.
//
// The control plane must serve both OS entrypoints (Windows install.ps1, Linux install.sh) and
// the cross-platform orchestrator, so `iwr .../install.ps1 | iex` and
// `curl .../install.sh | sudo -E bash` both onboard a node.

import test from "node:test";
import assert from "node:assert";
import { createControlPlaneServer } from "../control-plane/server/index.mjs";
import { trustedPublisherKeys, assertBundleTrusted } from "../bootstrap/bootstrap.mjs";
import { generateBundleSigningKeypair, signBundle } from "../shared/protocol/bundle-signing.mjs";

test("bootstrap: serves the Windows + Linux entrypoints and the orchestrator", async () => {
  const PORT = 8858;
  const BASE = `http://127.0.0.1:${PORT}`;
  const app = createControlPlaneServer({ server: { port: PORT }, baseUrl: BASE });
  await app.listen(PORT);
  try {
    const ps1 = await fetch(`${BASE}/bootstrap/install.ps1`);
    assert.equal(ps1.status, 200);
    assert.match(await ps1.text(), /install\.ps1 must run as Administrator/);

    const sh = await fetch(`${BASE}/bootstrap/install.sh`);
    assert.equal(sh.status, 200);
    assert.match(sh.headers.get("content-type"), /shellscript/);
    const shBody = await sh.text();
    assert.match(shBody, /must run as root/);
    assert.match(shBody, /WEBINSPECTOR_ENROLLMENT_TOKEN/);
    assert.match(shBody, /bootstrap\.mjs/);
    assert.ok(shBody.startsWith("#!/usr/bin/env bash"), "has a bash shebang");

    const orch = await fetch(`${BASE}/bootstrap/bootstrap.mjs`);
    assert.equal(orch.status, 200);
    assert.match(orch.headers.get("content-type"), /javascript/);

    // the orchestrator reads its supervisor bundle reference from the manifest
    const manifest = await fetch(`${BASE}/bootstrap/manifest`);
    assert.equal(manifest.status, 200);
    assert.ok((await manifest.json()).supervisor, "manifest exposes the supervisor version");
  } finally {
    await app.close();
  }
});

test("bootstrap: assertBundleTrusted enforces the publisher signature only when keys are configured", () => {
  const { publicKeyPem, privateKeyPem } = generateBundleSigningKeypair();
  const other = generateBundleSigningKeypair();
  const base = { component: "control-plane-agent", version: "3.1.0" };
  const bundle = { sha256: "abc123", signature: signBundle({ ...base, sha256: "abc123", privateKey: privateKeyPem }) };

  // no keys configured -> unenforced (SHA-256 already checked on download)
  assert.doesNotThrow(() => assertBundleTrusted({ ...base, bundle: { sha256: "abc123", signature: "AAAA" }, trustedKeys: [] }));
  // valid signature under a trusted key -> ok
  assert.doesNotThrow(() => assertBundleTrusted({ ...base, bundle, trustedKeys: [publicKeyPem] }));
  // wrong key / missing signature -> refuse to install
  assert.throws(() => assertBundleTrusted({ ...base, bundle, trustedKeys: [other.publicKeyPem] }), /signature verification/);
  assert.throws(() => assertBundleTrusted({ ...base, bundle: { sha256: "abc123", signature: null }, trustedKeys: [publicKeyPem] }), /signature verification/);
});

test("bootstrap: trustedPublisherKeys decodes base64 PEMs from the environment", () => {
  const { publicKeyPem } = generateBundleSigningKeypair();
  const b64 = Buffer.from(publicKeyPem, "utf8").toString("base64");
  assert.deepEqual(trustedPublisherKeys({ WEBINSPECTOR_BUNDLE_PUBLISHER_KEYS_B64: b64 }), [publicKeyPem]);
  assert.deepEqual(trustedPublisherKeys({}), []);
});
