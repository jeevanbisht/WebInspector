// Fast initial probe (worker side).
//
// Layered probe (no browser): DNS -> TCP -> TLS -> HTTP, with per-layer timings, a real
// redirect chain, failure-layer classification, and lightweight edge/WAF vendor detection
// from response headers. Ported + enriched from the original testinginfra probe-runner.
//
// The ControlPlane compares arms; this reports what one node saw.

import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { performance } from "node:perf_hooks";

const USER_AGENT = "WebInspector-Agent/3.0";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function initialTest(url, { timeoutMs = 25000 } = {}) {
  const totalStart = performance.now();
  const parsed = safeParse(url);
  const secure = parsed?.protocol === "https:";
  const port = parsed ? (parsed.port ? Number(parsed.port) : secure ? 443 : 80) : null;

  const out = {
    url,
    host: parsed?.hostname || null,
    port,
    protocol: parsed ? parsed.protocol.replace(":", "") : null,
    dns: null,
    tcp: null,
    tls: null,
    http: null,
    redirectChain: [],
    finalUrl: null,
    latencyMs: null,
    contentLength: null,
    vendor: null,
    referenceIds: {},
    headers: {},
    ok: false,
    reason: "UNKNOWN",
    specificReason: "UNKNOWN",
    failureLayer: null,
    timeoutPhase: null,
    error: null,
    totalMs: null,
  };

  if (!parsed) {
    out.error = "invalid URL";
    out.totalMs = elapsed(totalStart);
    return out;
  }

  try {
    // DNS
    const dnsStart = performance.now();
    const addresses = await dns.lookup(parsed.hostname, { all: true });
    out.dns = { ok: true, ms: elapsed(dnsStart), addresses: addresses.map((a) => a.address) };

    // TCP
    out.tcp = await timeConnect({ host: parsed.hostname, port, secure: false, timeoutMs });
    if (!out.tcp.ok) throw layered("tcp", out.tcp.error || "TCP_FAILURE");

    // TLS (https only)
    if (secure) {
      out.tls = await timeConnect({ host: parsed.hostname, port, secure: true, timeoutMs });
      if (!out.tls.ok) throw layered("tls", out.tls.error || "TLS_FAILURE");
    }

    // HTTP with a real redirect chain
    const httpStart = performance.now();
    const { response, finalUrl, redirectChain, error } = await fetchWithChain(url, { timeoutMs });
    out.redirectChain = redirectChain;
    out.finalUrl = finalUrl;
    out.latencyMs = elapsed(httpStart);
    if (!response) throw layered("http", error || "NETWORK_FAILURE");

    const body = await response.arrayBuffer().catch(() => new ArrayBuffer(0));
    out.http = { status: response.status, statusText: response.statusText };
    out.contentLength = body.byteLength || Number(response.headers.get("content-length") || 0) || null;
    out.vendor = detectVendor(response.headers);
    out.referenceIds = referenceIds(response.headers);
    out.headers = curatedHeaders(response.headers);
    out.ok = response.status >= 200 && response.status < 400;
    out.reason = out.specificReason = out.ok ? "OK" : `HTTP_${response.status}`;
  } catch (err) {
    out.error = String(err?.message || err);
    out.specificReason = err?.specific || reasonFromError(out.error);
    out.reason = out.specificReason;
    out.failureLayer = err?.layer || failureLayerFromReason(out.specificReason);
    if (out.reason === "TIMEOUT") out.timeoutPhase = out.failureLayer || "http";
    out.ok = false;
  } finally {
    out.totalMs = elapsed(totalStart);
  }
  return out;
}

function elapsed(start) {
  return Math.round(performance.now() - start);
}

// Time a raw TCP connect, or a full TLS handshake when secure.
function timeConnect({ host, port, secure, timeoutMs }) {
  const start = performance.now();
  return new Promise((resolve) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
      : net.connect({ host, port });
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ...r, ms: elapsed(start) });
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: "TIMEOUT" }));
    socket.once(secure ? "secureConnect" : "connect", () => finish({ ok: true }));
    socket.once("error", (e) => finish({ ok: false, error: e.code || e.message }));
  });
}

// Follow redirects manually so the full chain is captured as evidence.
async function fetchWithChain(target, { timeoutMs, maxRedirects = 10 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("TIMEOUT")), timeoutMs);
  const redirectChain = [];
  let current = target;
  try {
    for (let i = 0; i <= maxRedirects; i++) {
      const response = await fetch(current, { redirect: "manual", signal: controller.signal, headers: { "user-agent": USER_AGENT } });
      const location = response.headers.get("location");
      if (REDIRECT_STATUSES.has(response.status) && location) {
        const next = new URL(location, current).toString();
        redirectChain.push({ from: current, to: next, status: response.status });
        current = next;
        continue;
      }
      return { response, finalUrl: current, redirectChain };
    }
    return { response: null, finalUrl: current, redirectChain, error: "TOO_MANY_REDIRECTS" };
  } catch (e) {
    const err = e?.name === "AbortError" || /TIMEOUT/i.test(String(e?.message)) ? "TIMEOUT" : e?.cause?.code || e?.code || e?.message || "NETWORK_FAILURE";
    return { response: null, finalUrl: current, redirectChain, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function layered(layer, message) {
  const err = new Error(message);
  err.layer = layer;
  err.specific = layer === "tcp" ? "TCP_FAILURE" : layer === "tls" ? "TLS_FAILURE" : /TIMEOUT/i.test(message) ? "TIMEOUT" : reasonFromError(message);
  return err;
}

function reasonFromError(error) {
  const v = String(error || "");
  if (/ENOTFOUND|EAI_AGAIN|DNS|ERR_NAME/i.test(v)) return "DNS_FAILURE";
  if (/CERT|SSL|TLS|UNABLE_TO_VERIFY|ERR_TLS/i.test(v)) return "TLS_FAILURE";
  if (/TIMEOUT|ABORT/i.test(v)) return "TIMEOUT";
  if (/ECONN|TCP|RESET|REFUSED|EHOSTUNREACH|ENETUNREACH/i.test(v)) return "TCP_FAILURE";
  return "NETWORK_FAILURE";
}

function failureLayerFromReason(reason) {
  return { DNS_FAILURE: "dns", TCP_FAILURE: "tcp", TLS_FAILURE: "tls", TIMEOUT: "timeout" }[reason] || null;
}

// Lightweight edge/WAF vendor inference from response headers.
function detectVendor(headers) {
  const server = (headers.get("server") || "").toLowerCase();
  if (headers.get("cf-ray") || server.includes("cloudflare")) return "Cloudflare";
  if (headers.get("akamai-grn") || headers.get("x-akamai-transformed") || /akamai/.test(server)) return "Akamai";
  if (headers.get("x-iinfo") || /incapsula|imperva/.test(server)) return "Imperva";
  if (headers.get("x-amz-cf-id") || /cloudfront/.test(server)) return "AWS CloudFront";
  if (headers.get("x-served-by") || /fastly/.test(server)) return "Fastly";
  if (headers.get("x-vercel-id") || /vercel/.test(server)) return "Vercel";
  if (headers.get("x-nf-request-id") || /netlify/.test(server)) return "Netlify";
  if (/big-?ip|f5/.test(server)) return "F5 BIG-IP";
  return null;
}

function referenceIds(headers) {
  const ids = {};
  for (const h of ["cf-ray", "x-amz-cf-id", "akamai-grn", "x-served-by", "x-request-id", "x-vercel-id", "x-nf-request-id"]) {
    const v = headers.get(h);
    if (v) ids[h] = v;
  }
  return ids;
}

function curatedHeaders(headers) {
  const out = {};
  for (const h of ["server", "content-type", "content-length", "cache-control", "cf-cache-status", "via", "x-cache", "location"]) {
    const v = headers.get(h);
    if (v) out[h] = v;
  }
  return out;
}

function safeParse(url) {
  try {
    const u = new URL(url);
    return ["http:", "https:"].includes(u.protocol) ? u : null;
  } catch {
    return null;
  }
}
