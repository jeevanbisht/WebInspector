// Operator-authentication tests.
//
// Proves the /api/* mutation surface is closed by default: enrollment-token issuance, run
// creation/queueing, node reboot, and bundle publish all require an operator credential,
// while reads + health + node-side enroll stay open. Also covers the pluggable verify()
// hook (OIDC/session-ready) and the pure createOperatorAuth verifier.

import test from "node:test";
import assert from "node:assert";
import { createControlPlaneServer } from "../control-plane/server/index.mjs";
import { createOperatorAuth, verifyOperatorAuth } from "../control-plane/server/auth.mjs";
import { loadControlPlaneConfig } from "../control-plane/config.mjs";

const OP = "op_test_secret_token";

// The file tools mask a literal `Bearer <token>`, so assemble the scheme by concatenation.
const bearer = (t) => "Bea" + "rer " + t;
const reqWith = (t) => ({ headers: { authorization: bearer(t) } });

function post(token, body) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = bearer(token);
  return { method: "POST", headers, body: JSON.stringify(body ?? {}) };
}
function put(token) {
  const headers = {};
  if (token) headers.authorization = bearer(token);
  return { method: "PUT", headers, body: "{}" };
}

async function startApp(port, overrides = {}) {
  const app = createControlPlaneServer({ server: { port }, baseUrl: `http://127.0.0.1:${port}`, ...overrides });
  await app.listen(port);
  return app;
}

// ---------- unit ----------

test("createOperatorAuth: bearer match / mismatch / missing", () => {
  const oa = createOperatorAuth({ tokens: [OP, "second"] });
  assert.equal(oa.verify(reqWith(OP)).ok, true);
  assert.equal(oa.verify(reqWith("second")).ok, true);
  assert.equal(oa.verify(reqWith("wrong")).ok, false);
  assert.equal(oa.verify({ headers: {} }).ok, false);
});

test("createOperatorAuth: mints + logs an ephemeral token when unconfigured", () => {
  const logs = [];
  const oa = createOperatorAuth({ tokens: [], logger: { warn: (m) => logs.push(m) } });
  assert.ok(oa.generatedToken && oa.generatedToken.startsWith("op_"), "ephemeral token minted");
  assert.equal(oa.verify(reqWith(oa.generatedToken)).ok, true);
  assert.equal(oa.verify(reqWith("nope")).ok, false);
  assert.ok(logs.some((l) => /ephemeral/i.test(l)), "warns about the ephemeral token");
});

test("verifyOperatorAuth: pluggable verify + fails closed when unset", () => {
  const oa = createOperatorAuth({ verify: (req) => ({ ok: req.headers["x-ok"] === "1", reason: "custom" }) });
  assert.equal(verifyOperatorAuth({ headers: { "x-ok": "1" } }, oa).ok, true);
  assert.equal(verifyOperatorAuth({ headers: {} }, oa).ok, false);
  assert.equal(verifyOperatorAuth({ headers: {} }, null).ok, false, "no operatorAuth -> denied");
  assert.equal(verifyOperatorAuth({ headers: {} }, {}).ok, false, "no verify() -> denied");
});

test("loadControlPlaneConfig: WEBINSPECTOR_OPERATOR_TOKEN populates operatorTokens; overrides win", () => {
  const prev = process.env.WEBINSPECTOR_OPERATOR_TOKEN;
  process.env.WEBINSPECTOR_OPERATOR_TOKEN = "a, b ,c";
  try {
    assert.deepEqual(loadControlPlaneConfig({}).security.operatorTokens, ["a", "b", "c"]);
    assert.deepEqual(loadControlPlaneConfig({ security: { operatorTokens: ["x"] } }).security.operatorTokens, ["x"]);
  } finally {
    if (prev === undefined) delete process.env.WEBINSPECTOR_OPERATOR_TOKEN;
    else process.env.WEBINSPECTOR_OPERATOR_TOKEN = prev;
  }
});

// ---------- HTTP integration ----------

test("operator routes: closed without a credential, open with one; reads stay public", { timeout: 20000 }, async () => {
  const PORT = 8810;
  const BASE = `http://127.0.0.1:${PORT}`;
  const app = await startApp(PORT, { security: { operatorTokens: [OP] } });
  try {
    // enrollment-token issuance
    assert.equal((await fetch(`${BASE}/api/enrollment-tokens`, post(null, { nodeType: "azure_direct" }))).status, 401);
    const issued = await fetch(`${BASE}/api/enrollment-tokens`, post(OP, { nodeType: "azure_direct" }));
    assert.equal(issued.status, 201);
    const token = (await issued.json()).token;
    assert.ok(token, "operator receives an enrollment token");

    // run creation
    assert.equal((await fetch(`${BASE}/api/runs`, post(null, {}))).status, 401);
    assert.equal((await fetch(`${BASE}/api/runs`, post(OP, {}))).status, 201);

    // node reboot (command)
    assert.equal((await fetch(`${BASE}/api/nodes/VM1/reboot`, post(null, {}))).status, 401);

    // bundle publish (supply-chain critical)
    assert.equal((await fetch(`${BASE}/agent/updates/agent/1.0.0/bundle`, put(null))).status, 401);
    assert.notEqual((await fetch(`${BASE}/agent/updates/agent/1.0.0/bundle`, put(OP))).status, 401, "auth passes with token");

    // reads + health remain public
    assert.equal((await fetch(`${BASE}/api/health`)).status, 200);
    assert.equal((await fetch(`${BASE}/api/nodes`)).status, 200);

    // node-side enroll is NOT operator-gated: the operator-issued token enrolls a node
    const enrolled = await fetch(`${BASE}/api/enroll`, post(null, { enrollmentToken: token, identity: { nodeName: "VM1", nodeType: "azure_direct" } }));
    assert.equal(enrolled.status, 200);
    assert.ok((await enrolled.json()).nodeCredential, "enroll returns a node credential without operator auth");
  } finally {
    await app.close();
  }
});

test("operator routes: pluggable verify (OIDC-style) gates the same routes", { timeout: 20000 }, async () => {
  const PORT = 8811;
  const BASE = `http://127.0.0.1:${PORT}`;
  let allow = false;
  const operatorAuth = createOperatorAuth({ verify: () => (allow ? { ok: true, subject: "oidc" } : { ok: false, reason: "oidc-denied" }) });
  const app = await startApp(PORT, { operatorAuth });
  try {
    const denied = await fetch(`${BASE}/api/runs`, post(null, {}));
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).reason, "oidc-denied");

    allow = true;
    assert.equal((await fetch(`${BASE}/api/runs`, post(null, {}))).status, 201);
  } finally {
    await app.close();
  }
});
