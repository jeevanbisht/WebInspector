// Portal-facing endpoints: node lifecycle actions + git-based onboarding routes.

import test from "node:test";
import assert from "node:assert";
import { createControlPlaneServer } from "../control-plane/server/index.mjs";

const bearer = (t) => "Bea" + "rer " + t;

test("node actions: drain/undrain/restart-worker are operator-gated and dispatch commands", async () => {
  const PORT = 8862;
  const BASE = `http://127.0.0.1:${PORT}`;
  const OP = "op_actions_secret";
  const app = createControlPlaneServer({ server: { port: PORT }, baseUrl: BASE, security: { operatorTokens: [OP] } });
  await app.listen(PORT);
  try {
    // Unauthenticated → 401.
    assert.equal((await fetch(`${BASE}/api/nodes/n1/drain`, { method: "POST" })).status, 401);

    // Authenticated but the node has no live control-channel session → 409.
    const noSession = await fetch(`${BASE}/api/nodes/ghost/drain`, { method: "POST", headers: { authorization: bearer(OP) } });
    assert.equal(noSession.status, 409);

    // Attach a fake session that records the DOWN envelopes it receives, and register the node.
    const sent = [];
    const nodeId = "azure_direct:n1";
    app.services.registry.attachSession(nodeId, { send: (env) => sent.push(env), close() {} });
    app.services.registry.register({ nodeName: "n1", nodeType: "azure_direct", versions: {} });

    for (const [action, verb] of [
      ["drain", "drain"],
      ["undrain", "undrain"],
      ["restart-worker", "restart_worker"],
    ]) {
      const r = await fetch(`${BASE}/api/nodes/n1/${action}`, { method: "POST", headers: { authorization: bearer(OP) } });
      assert.equal(r.status, 202, `${action} accepted`);
      const body = await r.json();
      assert.equal(body.action, verb);
      assert.ok(body.commandId, "returns a commandId");
    }

    // The dispatcher sent exactly those command verbs down the channel.
    const verbs = sent.map((e) => e.payload?.command);
    assert.deepEqual(verbs, ["drain", "undrain", "restart_worker"]);
  } finally {
    await app.close();
  }
});

test("bootstrap: git-based install scripts are served; ca.pem reflects TLS config", async () => {
  const PORT = 8863;
  const BASE = `http://127.0.0.1:${PORT}`;
  const app = createControlPlaneServer({ server: { port: PORT }, baseUrl: BASE });
  await app.listen(PORT);
  try {
    const sh = await fetch(`${BASE}/bootstrap/install-agent.sh`);
    assert.equal(sh.status, 200);
    assert.match(await sh.text(), /install-agent/);

    const ps1 = await fetch(`${BASE}/bootstrap/install-agent.ps1`);
    assert.equal(ps1.status, 200);
    assert.match(await ps1.text(), /install-agent/);

    // No TLS configured in this test server → the CA endpoint reports 404 (plain HTTP).
    assert.equal((await fetch(`${BASE}/bootstrap/ca.pem`)).status, 404);
  } finally {
    await app.close();
  }
});
