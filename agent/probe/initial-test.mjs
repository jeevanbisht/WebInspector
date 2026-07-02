// Fast initial probe (worker side).
//
// Captures layered timings and a coarse outcome without a full browser. The ControlPlane
// compares arms; this only reports what one node saw.
//
// Implemented: DNS timing + HTTP(S) fetch with redirect chain, status, latency, content
// length, and error/timeout classification. TODO: explicit TCP + TLS handshake timing and
// richer failure layering (port the existing probe-core).

import { lookup } from "node:dns/promises";
import { performance } from "node:perf_hooks";

export async function initialTest(url, { timeoutMs = 15000 } = {}) {
  const out = {
    url,
    dns: null,
    tcp: null, // TODO: measure separately
    tls: null, // TODO: measure separately
    http: null,
    redirectChain: [],
    finalUrl: null,
    latencyMs: null,
    contentLength: null,
    ok: false,
    reason: "UNKNOWN",
    timeoutPhase: null,
  };

  const host = safeHost(url);
  // DNS
  try {
    const t0 = performance.now();
    const res = await lookup(host);
    out.dns = { ok: true, address: res.address, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    out.dns = { ok: false, error: e.code || e.message };
    out.reason = "DNS_FAILURE";
    out.timeoutPhase = "dns";
    return out;
  }

  // HTTP(S)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    out.latencyMs = Math.round(performance.now() - start);
    out.http = { status: res.status, statusText: res.statusText };
    out.finalUrl = res.url;
    if (res.url && res.url !== url) out.redirectChain.push(res.url);
    out.contentLength = Number(res.headers.get("content-length") || 0) || null;
    out.ok = res.status >= 200 && res.status < 400;
    out.reason = out.ok ? "OK" : `HTTP_${res.status}`;
  } catch (e) {
    out.latencyMs = Math.round(performance.now() - start);
    if (e.name === "AbortError") {
      out.reason = "TIMEOUT";
      out.timeoutPhase = "http";
    } else {
      out.reason = "NETWORK_FAILURE";
      out.http = { error: e.cause?.code || e.code || e.message };
    }
  } finally {
    clearTimeout(timer);
  }

  return out;
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
