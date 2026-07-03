// Browser-validation tests.
//
// Two layers:
//   1. Hermetic unit tests for the pure decision helpers (no browser needed).
//   2. One real integration test that drives bundled chromium (headless) against a local HTTP
//      server. It skips gracefully when no browser binary is installed.

import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import os from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  browserValidate,
  classifyOutcome,
  detectChallenge,
  analyzeHeaders,
  abckState,
  extractReferenceIds,
  mapNetworkError,
  PAGE_CLASSIFICATIONS,
} from "../agent/browser/browser-validation.mjs";

// ---------- pure unit tests ----------

test("classifyOutcome: timeout > network > challenge > http_error > ok", () => {
  assert.equal(classifyOutcome({ timedOut: true }).pageClassification, "timeout");
  assert.equal(classifyOutcome({ navError: "net::ERR_NAME_NOT_RESOLVED" }).pageClassification, "network_failure");
  assert.equal(
    classifyOutcome({ status: 403, challenge: { isChallenge: true, reason: "AKAMAI_BLOCK" } }).pageClassification,
    "challenge_or_block",
  );
  assert.equal(classifyOutcome({ status: 404 }).specificReason, "HTTP_404");
  const ok = classifyOutcome({ status: 200 });
  assert.equal(ok.ok, true);
  assert.equal(ok.pageClassification, "user_visible_ok");
  assert.equal(ok.specificReason, "OK");
});

test("classifyOutcome: response with no status is a browser_error", () => {
  assert.equal(classifyOutcome({}).pageClassification, "browser_error");
});

test("detectChallenge: Cloudflare 'Just a moment' interstitial", () => {
  const c = detectChallenge({
    status: 403,
    title: "Just a moment...",
    bodyText: "Checking your browser before accessing the site.",
    headers: { "cf-mitigated": "challenge", server: "cloudflare" },
  });
  assert.equal(c.isChallenge, true);
  assert.equal(c.vendor, "Cloudflare");
  assert.equal(c.reason, "CLOUDFLARE_CHALLENGE");
});

test("detectChallenge: Akamai access-denied block with reference id", () => {
  const c = detectChallenge({
    status: 403,
    title: "Access Denied",
    bodyText: "You don't have permission to access. Reference #18.abcd1234",
    headers: { server: "AkamaiGHost" },
  });
  assert.equal(c.isChallenge, true);
  assert.equal(c.vendor, "Akamai");
  assert.equal(c.reason, "AKAMAI_BLOCK");
});

test("detectChallenge: a healthy Cloudflare-fronted 200 is NOT a challenge", () => {
  const c = detectChallenge({
    status: 200,
    title: "Home",
    bodyText: "welcome to the store",
    headers: { "cf-ray": "7a1b-SJC", server: "cloudflare" },
  });
  assert.equal(c.isChallenge, false);
  assert.equal(c.reason, null);
});

test("detectChallenge: generic WAF block on 429", () => {
  const c = detectChallenge({ status: 429, title: "Blocked", bodyText: "unusual traffic detected", headers: {} });
  assert.equal(c.isChallenge, true);
  assert.equal(c.reason, "WAF_BLOCK");
});

test("analyzeHeaders: vendor detection + curated non-sensitive subset", () => {
  const a = analyzeHeaders({ server: "cloudflare", "cf-ray": "7a-SJC", "content-type": "text/html", "set-cookie": "secret=1" });
  assert.equal(a.vendor, "Cloudflare");
  assert.equal(a.curated["content-type"], "text/html");
  assert.ok(!("set-cookie" in a.curated), "sensitive headers are not surfaced");
});

test("abckState: passed / blocked / absent", () => {
  assert.equal(abckState([{ name: "_abck", value: "AAA~0~-1~-1~sensor" }]).verdict, "passed");
  assert.equal(abckState([{ name: "_abck", value: "AAA~-1~-1~-1~sensor" }]).verdict, "blocked");
  assert.equal(abckState([{ name: "other", value: "x" }]).verdict, "absent");
});

test("extractReferenceIds: header ids + Akamai/Incapsula/Ray body ids", () => {
  const ids = extractReferenceIds({
    headers: { "cf-ray": "7a1b-SJC" },
    bodyText: "Access Denied Reference #18.abcd1234 — Incapsula incident ID: 1234-5678 — Ray ID: deadbeef99",
  });
  assert.equal(ids["cf-ray"], "7a1b-SJC");
  assert.equal(ids.akamaiReference, "18.abcd1234");
  assert.equal(ids.incapsulaIncident, "1234-5678");
});

test("mapNetworkError: chromium net:: codes map to layered reasons", () => {
  assert.equal(mapNetworkError("net::ERR_NAME_NOT_RESOLVED"), "DNS_FAILURE");
  assert.equal(mapNetworkError("net::ERR_CERT_AUTHORITY_INVALID"), "TLS_FAILURE");
  assert.equal(mapNetworkError("net::ERR_CONNECTION_REFUSED"), "TCP_FAILURE");
  assert.equal(mapNetworkError("net::ERR_TIMED_OUT"), "TIMEOUT");
  assert.equal(mapNetworkError("weird unknown thing"), "NETWORK_FAILURE");
});

test("PAGE_CLASSIFICATIONS exposes the six page states", () => {
  assert.deepEqual(
    [...PAGE_CLASSIFICATIONS].sort(),
    ["browser_error", "challenge_or_block", "http_error", "network_failure", "timeout", "user_visible_ok"],
  );
});

// ---------- real-browser integration test (skips if no binary) ----------

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}
const closeServer = (srv) => new Promise((r) => srv.close(r));

test("browserValidate: real chromium — ok page and Akamai block page", { timeout: 120000 }, async (t) => {
  const { srv, port } = await startServer((req, res) => {
    if (req.url === "/blocked") {
      res.writeHead(403, { "content-type": "text/html", server: "AkamaiGHost" });
      res.end(
        "<html><head><title>Access Denied</title></head><body>You don't have permission to access. Reference #18.abcd1234</body></html>",
      );
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>OK Home</title></head><body>hello world</body></html>");
    }
  });
  const dir = await mkdtemp(join(os.tmpdir(), "wi-bv-"));
  try {
    // channel:null forces the bundled-chromium fallback so no Edge install is required.
    const okRes = await browserValidate(`http://127.0.0.1:${port}/`, { channel: null, artifactDir: dir, timeoutMs: 30000 });
    if (okRes.pageClassification === "browser_error" && /playwright|launch|executable|not installed/i.test(okRes.evidence?.note || "")) {
      t.skip(`no usable browser binary: ${okRes.evidence.note}`);
      return;
    }

    assert.equal(okRes.ok, true, JSON.stringify(okRes));
    assert.equal(okRes.pageClassification, "user_visible_ok");
    assert.equal(okRes.evidence.status, 200);
    assert.ok(okRes.evidence.title.includes("OK Home"));
    assert.ok(okRes.artifacts.some((a) => a.kind === "screenshot" && a.sha256 && a.sizeBytes > 0), "screenshot captured");
    assert.ok(!okRes.artifacts.some((a) => a.kind === "har"), "no HAR kept on success");

    const blockRes = await browserValidate(`http://127.0.0.1:${port}/blocked`, { channel: null, artifactDir: dir, timeoutMs: 30000 });
    assert.equal(blockRes.ok, false);
    assert.equal(blockRes.pageClassification, "challenge_or_block");
    assert.equal(blockRes.specificReason, "AKAMAI_BLOCK");
    assert.equal(blockRes.evidence.vendor, "Akamai");
    assert.equal(blockRes.evidence.referenceIds.akamaiReference, "18.abcd1234");
    assert.ok(blockRes.artifacts.some((a) => a.kind === "har" && a.sizeBytes > 0), "HAR kept on failure");
  } finally {
    await closeServer(srv);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
