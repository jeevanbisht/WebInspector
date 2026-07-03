// Portal serving tests.
//
// The static operator UI must be served with the right content type and ship the operator-token
// wiring, and its data calls must be operator-gated (the regression this fixes).

import test from "node:test";
import assert from "node:assert";
import { createControlPlaneServer } from "../control-plane/server/index.mjs";

test("portal: serves index (text/html) + auth-wired app.js; data calls are operator-gated", async () => {
  const PORT = 8852;
  const BASE = `http://127.0.0.1:${PORT}`;
  const OP = "op_portal_secret_token";
  const app = createControlPlaneServer({ server: { port: PORT }, baseUrl: BASE, security: { operatorTokens: [OP] } });
  await app.listen(PORT);
  try {
    const html = await fetch(`${BASE}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type"), /text\/html/, "/ is served as HTML (not octet-stream)");
    const body = await html.text();
    assert.ok(body.includes("op-token"), "operator-token input present");

    const js = await fetch(`${BASE}/assets/app.js`);
    assert.equal(js.status, 200);
    const jsBody = await js.text();
    assert.ok(jsBody.includes("authHeaders"), "app.js wires the operator token into requests");
    assert.ok(jsBody.includes("wi_operator_token"), "token persisted in localStorage");

    // health stays public; the Portal's data calls require the token
    assert.equal((await fetch(`${BASE}/api/health`)).status, 200);
    assert.equal((await fetch(`${BASE}/api/runs`)).status, 401);
    assert.equal((await fetch(`${BASE}/api/runs`, { headers: { authorization: "Bea" + "rer " + OP } })).status, 200);
  } finally {
    await app.close();
  }
});
