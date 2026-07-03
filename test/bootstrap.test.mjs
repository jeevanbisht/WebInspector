// Bootstrap onboarding tests.
//
// The control plane must serve both OS entrypoints (Windows install.ps1, Linux install.sh) and
// the cross-platform orchestrator, so `iwr .../install.ps1 | iex` and
// `curl .../install.sh | sudo -E bash` both onboard a node.

import test from "node:test";
import assert from "node:assert";
import { createControlPlaneServer } from "../control-plane/server/index.mjs";

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
