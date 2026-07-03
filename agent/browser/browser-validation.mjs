// Browser validation (worker side).
//
// Playwright using the system Edge channel (msedge) by default — headed with a persistent
// real profile defeats most bot/headless detection. Runs a clean context per URL, classifies
// the page, detects the edge/WAF vendor + reference IDs + Akamai `_abck` cookie state, and
// captures a screenshot ALWAYS plus a HAR ONLY on failure. Ported + enriched from the
// original testinginfra browser-validator.
//
// Returns:
//   { ok, specificReason, pageClassification, evidence, artifacts: [{kind, path, sha256, sizeBytes}] }
//
// The heavy Playwright driving lives in browserValidate(); all decision logic is factored
// into small pure helpers (classifyOutcome, detectChallenge, analyzeHeaders, abckState,
// extractReferenceIds, mapNetworkError) that are unit-tested without a browser.

import os from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { describeFile } from "./screenshot.mjs";
import { HAR_RECORD_OPTIONS, shouldKeepHar } from "./har.mjs";

export const PAGE_CLASSIFICATIONS = Object.freeze([
  "user_visible_ok",
  "challenge_or_block",
  "http_error",
  "network_failure",
  "timeout",
  "browser_error",
]);

// Reduce automation fingerprints; keep sandbox-friendly flags so it launches under CI too.
const HARDENED_ARGS = Object.freeze([
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
]);

export async function browserValidate(url, opts = {}) {
  const {
    channel = "msedge",
    timeoutMs = 45000,
    artifactDir = join(os.tmpdir(), "webinspector-artifacts"),
    headed = false,
    userDataDir = null,
    profileDirectory = null,
    launcher = null, // inject a Playwright browser-type (e.g. chromium) in tests
  } = opts;

  const playwright = launcher ? { chromium: launcher } : await loadPlaywright();
  if (!playwright) {
    return browserError("playwright not installed; run `npx playwright install msedge`");
  }

  await mkdir(artifactDir, { recursive: true }).catch(() => {});
  const stamp = `${slug(url)}-${Date.now()}`;
  const harPath = join(artifactDir, `${stamp}.har`);
  const shotPath = join(artifactDir, `${stamp}.png`);

  const consoleLog = [];
  const networkFailures = [];
  const redirectChain = [];

  let browser = null;
  let context = null;
  try {
    ({ browser, context } = await launchContext(playwright, {
      channel,
      headed,
      userDataDir,
      profileDirectory,
      harPath,
    }));

    const page = await context.newPage();
    page.on("console", (m) => {
      if (consoleLog.length < 50) consoleLog.push({ type: m.type(), text: truncate(m.text(), 300) });
    });
    page.on("requestfailed", (r) => {
      if (networkFailures.length < 50) networkFailures.push({ url: r.url(), error: r.failure()?.errorText || "failed" });
    });
    page.on("response", (resp) => {
      const s = resp.status();
      if (s >= 300 && s < 400) {
        const loc = resp.headers()["location"];
        redirectChain.push({ from: resp.url(), to: loc ? safeResolve(loc, resp.url()) : null, status: s });
      }
    });

    let response = null;
    let navError = null;
    let timedOut = false;
    try {
      response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    } catch (e) {
      navError = String(e?.message || e);
      timedOut = /timeout/i.test(navError);
    }

    const finalUrl = safeUrl(page) || url;
    const title = await page.title().catch(() => "");
    const bodyText = await page
      .evaluate(() => (document.body && document.body.innerText ? document.body.innerText : ""))
      .catch(() => "");
    const status = response ? response.status() : null;
    const headers = response ? lowerKeys(response.headers()) : {};
    const cookies = await context.cookies().catch(() => []);

    const vendorInfo = analyzeHeaders(headers);
    const challenge = detectChallenge({ status, title, bodyText, headers });
    const abck = abckState(cookies);
    const referenceIds = extractReferenceIds({ headers, bodyText });
    const outcome = classifyOutcome({ status, navError, timedOut, challenge });

    let screenshot = null;
    try {
      await page.screenshot({ path: shotPath, fullPage: true });
      screenshot = await describeFile("screenshot", shotPath);
    } catch {
      // screenshot is best-effort; never fail the validation over it
    }

    const evidence = {
      finalUrl,
      title: truncate(title, 300),
      status,
      vendor: challenge.vendor || vendorInfo.vendor || null,
      referenceIds,
      abck,
      redirectChain,
      challengeSignals: challenge.signals,
      headers: vendorInfo.curated,
      consoleSample: consoleLog,
      networkFailures,
      bodySample: truncate(bodyText.replace(/\s+/g, " ").trim(), 600),
      navError: navError || null,
    };

    // Close the context first so the HAR is flushed to disk before we decide to keep it.
    await context.close().catch(() => {});
    context = null;
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }

    const artifacts = [];
    if (screenshot) artifacts.push(screenshot);
    if (shouldKeepHar(outcome.ok)) {
      const har = await describeFile("har", harPath).catch(() => null);
      if (har) artifacts.push(har);
    } else {
      await rm(harPath, { force: true }).catch(() => {});
    }

    return {
      ok: outcome.ok,
      specificReason: outcome.specificReason,
      pageClassification: outcome.pageClassification,
      evidence,
      artifacts,
    };
  } catch (e) {
    return browserError(String(e?.message || e));
  } finally {
    try {
      if (context) await context.close();
    } catch {
      // ignore
    }
    try {
      if (browser) await browser.close();
    } catch {
      // ignore
    }
  }
}

// --- pure decision logic (unit-tested without a browser) ---

// Collapse the gathered evidence into one page classification + specific reason. Order matters:
// a transport-level failure or an active challenge is more informative than a bare HTTP status.
export function classifyOutcome({ status = null, navError = null, timedOut = false, challenge = null } = {}) {
  if (timedOut) return outcome(false, "timeout", "TIMEOUT");
  if (navError && status == null) return outcome(false, "network_failure", mapNetworkError(navError));
  if (challenge && challenge.isChallenge) return outcome(false, "challenge_or_block", challenge.reason || "WAF_BLOCK");
  if (status == null) return outcome(false, "browser_error", "UNKNOWN");
  if (status >= 400) return outcome(false, "http_error", `HTTP_${status}`);
  return outcome(true, "user_visible_ok", "OK");
}

// Detect an interstitial / block page from title, visible text, and headers. Returns a vendor
// and a specific reason. A site merely fronted by an edge (e.g. a healthy Cloudflare 200) is
// deliberately NOT reported as a challenge — only active verification/deny pages are.
export function detectChallenge({ status = null, title = "", bodyText = "", headers = {} } = {}) {
  const h = headers || {};
  const server = String(h["server"] || "").toLowerCase();
  const hay = `${title || ""}\n${bodyText || ""}`.toLowerCase();
  const has = (re) => re.test(hay);
  const signals = [];
  let vendor = null;
  let reason = null;

  // Cloudflare interstitial / managed challenge
  if (h["cf-mitigated"] || has(/just a moment|attention required|checking your browser|cf-browser-verification|challenge-platform|enable javascript and cookies to continue/)) {
    vendor = "Cloudflare";
    reason = has(/captcha|verify you are (?:a )?human|are you a robot/) ? "CAPTCHA" : "CLOUDFLARE_CHALLENGE";
    signals.push("cloudflare_challenge");
  }

  // Akamai "Access Denied" / reference-id block page
  if (!reason) {
    const akamaiEdge = server.includes("akamaighost") || Boolean(h["akamai-grn"]);
    if (has(/access denied/) || has(/reference\s*#\s*\d/) || has(/you don't have permission to access/) || (akamaiEdge && (status === 403 || has(/denied|forbidden/)))) {
      vendor = "Akamai";
      reason = "AKAMAI_BLOCK";
      signals.push("akamai_block");
    }
  }

  // Imperva / Incapsula
  if (!reason && (has(/incapsula incident|_incap_|request unsuccessful\. incapsula|powered by imperva/) || h["x-iinfo"])) {
    vendor = "Imperva";
    reason = "IMPERVA_BLOCK";
    signals.push("incapsula_incident");
  }

  // PerimeterX / HUMAN
  if (!reason && has(/px-captcha|perimeterx|please verify you are a human|press & hold to confirm/)) {
    vendor = "PerimeterX";
    reason = "PX_BLOCK";
    signals.push("perimeterx");
  }

  // DataDome
  if (!reason && (has(/datadome/) || h["x-datadome"] || h["x-dd-b"])) {
    vendor = "DataDome";
    reason = "DATADOME_BLOCK";
    signals.push("datadome");
  }

  // Generic bot/WAF block on a blocking status code
  if (!reason && [403, 429, 503].includes(status) && has(/access denied|request blocked|forbidden|bot detected|are you a robot|unusual traffic|captcha/)) {
    reason = "WAF_BLOCK";
    signals.push("generic_waf_block");
  }

  return { isChallenge: Boolean(reason), vendor, reason, signals };
}

// Map a chromium/network error string to a layered failure reason (aligned with the probe).
export function mapNetworkError(text) {
  const v = String(text || "");
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|\bDNS\b/i.test(v)) return "DNS_FAILURE";
  if (/ERR_CERT|ERR_SSL|ERR_TLS|CERT_|SSL_|handshake/i.test(v)) return "TLS_FAILURE";
  if (/ERR_TIMED_OUT|TIMED?OUT|ABORT/i.test(v)) return "TIMEOUT";
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_CONNECTION_RESET|ECONNRESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_FAILED|ERR_ADDRESS_UNREACHABLE|EHOSTUNREACH|ENETUNREACH/i.test(v)) return "TCP_FAILURE";
  return "NETWORK_FAILURE";
}

// Infer edge/WAF vendor from response headers and return a curated, non-sensitive subset.
export function analyzeHeaders(headers = {}) {
  const h = headers || {};
  const server = String(h["server"] || "").toLowerCase();
  let vendor = null;
  if (h["cf-ray"] || server.includes("cloudflare")) vendor = "Cloudflare";
  else if (h["akamai-grn"] || h["x-akamai-transformed"] || server.includes("akamai")) vendor = "Akamai";
  else if (h["x-iinfo"] || /incapsula|imperva/.test(server)) vendor = "Imperva";
  else if (h["x-amz-cf-id"] || /cloudfront/.test(server)) vendor = "AWS CloudFront";
  else if (h["x-served-by"] || /fastly/.test(server)) vendor = "Fastly";
  else if (h["x-vercel-id"] || /vercel/.test(server)) vendor = "Vercel";
  else if (h["x-nf-request-id"] || /netlify/.test(server)) vendor = "Netlify";
  else if (h["x-datadome"]) vendor = "DataDome";
  else if (/big-?ip|f5/.test(server)) vendor = "F5 BIG-IP";

  const curated = {};
  for (const key of ["server", "content-type", "cache-control", "cf-cache-status", "cf-mitigated", "via", "x-cache", "location"]) {
    if (h[key]) curated[key] = h[key];
  }
  return { vendor, curated };
}

// Classify the Akamai `_abck` bot-manager cookie: token index 1 is "0" once the sensor data
// is accepted (passed) and "-1" while unvalidated/blocked. The long sensor blob is masked.
export function abckState(cookies = []) {
  const c = (cookies || []).find((x) => x && x.name === "_abck");
  if (!c) return { present: false, verdict: "absent" };
  const value = String(c.value || "");
  const token = value.split("~")[1];
  let verdict = "unknown";
  if (token === "0") verdict = "passed";
  else if (token === "-1") verdict = "blocked";
  return { present: true, verdict, sample: mask(value) };
}

// Pull correlation/reference IDs from headers and known block-page body formats.
export function extractReferenceIds({ headers = {}, bodyText = "" } = {}) {
  const h = headers || {};
  const ids = {};
  for (const key of ["cf-ray", "x-amz-cf-id", "akamai-grn", "x-served-by", "x-request-id", "x-vercel-id", "x-nf-request-id", "x-datadome", "x-iinfo"]) {
    if (h[key]) ids[key] = h[key];
  }
  const body = String(bodyText || "");
  const akamai = body.match(/reference\s*#\s*([\w.]+)/i);
  if (akamai) ids.akamaiReference = akamai[1];
  const incap = body.match(/incapsula incident id:?\s*([\w-]+)/i);
  if (incap) ids.incapsulaIncident = incap[1];
  const ray = body.match(/ray id:?\s*([0-9a-f]+)/i);
  if (ray && !ids["cf-ray"]) ids.cloudflareRayId = ray[1];
  return ids;
}

// --- Playwright launch plumbing ---

async function launchContext(pw, { channel, headed, userDataDir, profileDirectory, harPath }) {
  const contextOpts = {
    viewport: { width: 1366, height: 900 },
    recordHar: { ...HAR_RECORD_OPTIONS.recordHar, path: harPath },
  };

  // Persistent real-profile context (only meaningful headed) — best at defeating bot detection.
  if (headed && userDataDir) {
    const args = [...HARDENED_ARGS];
    if (profileDirectory) args.push(`--profile-directory=${profileDirectory}`);
    const context = await pw.chromium.launchPersistentContext(userDataDir, {
      channel: channel || undefined,
      headless: false,
      args,
      ...contextOpts,
    });
    return { browser: null, context };
  }

  const browser = await launchBrowser(pw, { channel, headed });
  const context = await browser.newContext(contextOpts);
  return { browser, context };
}

// Prefer the requested channel (msedge), then fall back to bundled chromium so validation
// still runs on hosts without Edge (e.g. CI / Linux workers).
async function launchBrowser(pw, { channel, headed }) {
  const attempts = [];
  if (channel) attempts.push({ args: [...HARDENED_ARGS], channel, headless: !headed });
  attempts.push({ args: [...HARDENED_ARGS], headless: !headed });
  if (headed) attempts.push({ args: [...HARDENED_ARGS], headless: true }); // no-display fallback
  let lastErr;
  for (const a of attempts) {
    try {
      return await pw.chromium.launch(a);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("failed to launch browser");
}

// --- small pure utilities ---

function outcome(ok, pageClassification, specificReason) {
  return { ok, pageClassification, specificReason };
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[String(k).toLowerCase()] = v;
  return out;
}

function truncate(s, n) {
  const v = String(s ?? "");
  return v.length > n ? v.slice(0, n) : v;
}

function mask(v) {
  return v.length > 24 ? `${v.slice(0, 12)}…${v.slice(-8)}` : v;
}

function slug(url) {
  return (
    String(url)
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .toLowerCase() || "url"
  );
}

function safeResolve(loc, base) {
  try {
    return new URL(loc, base).toString();
  } catch {
    return loc;
  }
}

function safeUrl(page) {
  try {
    return page.url();
  } catch {
    return null;
  }
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    return null;
  }
}

function browserError(note) {
  return {
    ok: false,
    specificReason: "UNKNOWN",
    pageClassification: "browser_error",
    evidence: { note },
    artifacts: [],
  };
}
