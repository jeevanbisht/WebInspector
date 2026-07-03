// Server-hardening tests: security headers, enroll rate limiting, expired-token sweep.

import test from "node:test";
import assert from "node:assert";
import { createControlPlaneServer } from "../control-plane/server/index.mjs";
import { createEnrollmentService } from "../control-plane/control/enrollment.mjs";
import { createRateLimiter } from "../control-plane/server/rate-limit.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("security headers: every response carries CSP + nosniff + frame-deny", async () => {
  const PORT = 8854;
  const BASE = `http://127.0.0.1:${PORT}`;
  const app = createControlPlaneServer({ server: { port: PORT }, baseUrl: BASE });
  await app.listen(PORT);
  try {
    for (const path of ["/", "/api/health"]) {
      const r = await fetch(`${BASE}${path}`);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", path);
      assert.equal(r.headers.get("x-frame-options"), "DENY", path);
      assert.match(r.headers.get("content-security-policy"), /default-src 'self'/, path);
    }
  } finally {
    await app.close();
  }
});

test("rate limiter: allows up to max per key, then denies", () => {
  const rl = createRateLimiter({ max: 3, windowMs: 10000 });
  assert.equal(rl.allow("k"), true);
  assert.equal(rl.allow("k"), true);
  assert.equal(rl.allow("k"), true);
  assert.equal(rl.allow("k"), false);
  assert.equal(rl.allow("other"), true, "limited per key");
});

test("enroll endpoint is rate limited per IP", { timeout: 15000 }, async () => {
  const PORT = 8855;
  const BASE = `http://127.0.0.1:${PORT}`;
  const app = createControlPlaneServer({ server: { port: PORT }, baseUrl: BASE, security: { enrollRateLimit: { max: 3, windowMs: 60000 } } });
  await app.listen(PORT);
  try {
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${BASE}/api/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      statuses.push(r.status);
    }
    assert.ok(statuses.slice(0, 3).every((s) => s !== 429), "first 3 attempts are not rate-limited");
    assert.equal(statuses[3], 429, "4th enroll from the same IP is rate-limited");
  } finally {
    await app.close();
  }
});

test("enrollment: expired tokens are swept from memory", async () => {
  const svc = createEnrollmentService();
  const { token } = svc.issueToken({ nodeType: "azure_direct", ttlMs: 1 });
  await sleep(5);
  assert.equal(svc.sweepExpired(), 1, "expired token swept");
  assert.throws(() => svc.enroll({ enrollmentToken: token, identity: { nodeName: "V", nodeType: "azure_direct" } }), /unknown enrollment token/);
});
