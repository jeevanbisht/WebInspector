// Single-port ControlPlane server.
//
// One HTTP listener carries everything (see root README "Single-port surface"):
//   - Portal static UI               GET /, GET /assets/*
//   - REST API                       /api/*
//   - Control channel (WS upgrade)   /agent/channel   (long-poll fallback: /agent/poll, /agent/push)
//   - Bootstrap                      GET /bootstrap/*
//   - Enrollment                     POST /api/enroll, POST /api/enrollment-tokens
//   - Data plane                     POST /api/results/:jobId, POST /api/artifacts/upload,
//                                    GET /agent/updates/:version/bundle
//
// This file wires the object graph and routes; handlers delegate to the control/* modules.
// TODO: real WebSocket upgrade (ws) + streaming multipart for the data plane.

import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { loadControlPlaneConfig } from "../config.mjs";
import { createRegistry } from "../control/registry.mjs";
import { createDispatcher } from "../control/dispatcher.mjs";
import { createReconciler } from "../control/reconciler.mjs";
import { createUpdateManager } from "../control/update-manager.mjs";
import { createBundleRegistry } from "../control/bundle-registry.mjs";
import { createRebootManager } from "../control/reboot-manager.mjs";
import { createEnrollmentService } from "../control/enrollment.mjs";
import { verifyNodeAuth, verifyOperatorAuth, createOperatorAuth } from "./auth.mjs";
import { attachControlChannel } from "./channel.mjs";
import { createBlobStore } from "../data/blob-store.mjs";
import { createDataPlane } from "./data-plane.mjs";
import { createNodeSelection } from "../scheduler/node-selection.mjs";
import { createSitePacket } from "../reporting/site-packet.mjs";
import { createRunOrchestrator } from "../scheduler/run-orchestrator.mjs";

export function createControlPlaneServer(overrides = {}) {
  const config = loadControlPlaneConfig(overrides);
  const baseUrl = overrides.baseUrl || `http://localhost:${config.server.port}`;

  // --- object graph (shared by control + data planes) ---
  const store = overrides.store || null; // TODO: createStateStore(localJsonAdapter(config.paths.stateDir))
  const registry = createRegistry({ store });
  const dispatcher = createDispatcher({ registry, store });
  const bundleRegistry = createBundleRegistry({ baseUrl, store });
  const updateManager = createUpdateManager({
    bundleRegistry,
    desiredVersions: config.desiredVersions,
    rollout: config.rollout,
  });
  const enrollment = createEnrollmentService({ store, tokenTtlMs: config.security.enrollmentTokenTtlMs });
  const operatorAuth = overrides.operatorAuth || createOperatorAuth({ tokens: config.security.operatorTokens, logger: console });
  const reboot = createRebootManager({ dispatcher, registry, store });
  const reconciler = createReconciler({ registry, dispatcher, updateManager });
  const blobStore = createBlobStore({ dir: config.server.blobDir });
  const dataPlane = createDataPlane({ config, bundleRegistry, blobStore, store });
  const selection = createNodeSelection({ registry, config });
  const sitePacket = createSitePacket({ store, artifacts: blobStore });
  const orchestrator = createRunOrchestrator({ store, registry, dispatcher, selection, sitePacket });

  const services = { config, store, registry, dispatcher, bundleRegistry, updateManager, enrollment, operatorAuth, reboot, reconciler, blobStore, dataPlane, selection, orchestrator };

  // Optional in-process TLS: serve the single port over HTTPS when a cert+key are configured.
  const tlsOptions = loadTlsOptions(config.server.tls);
  const scheme = tlsOptions ? "https" : "http";
  services.scheme = scheme;
  const handler = (req, res) => route(req, res, services).catch((e) => fail(res, e));
  const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);

  // Control channel lives on the SAME port via HTTP(S) upgrade (WebSocket) plus a long-poll
  // fallback (GET /agent/poll, POST /agent/push) routed below through services.controlChannel.
  const channel = attachControlChannel(server, services, { baseUrl });
  services.controlChannel = channel;

  return {
    services,
    scheme,
    listen(port = config.server.port, host = config.server.host) {
      reconciler.start({ intervalMs: 5000 });
      return new Promise((resolve) => server.listen(port, host, () => resolve({ port, host })));
    },
    close() {
      reconciler.stop();
      channel.close();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// Load a cert+key pair for HTTPS when both file paths are configured; otherwise plain HTTP.
function loadTlsOptions(tlsCfg) {
  if (!tlsCfg?.certFile || !tlsCfg?.keyFile) return null;
  return { cert: readFileSync(tlsCfg.certFile), key: readFileSync(tlsCfg.keyFile) };
}

async function route(req, res, services) {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;
  const method = req.method;

  // Gate for operator-only mutations. Returns false (and writes 401) when unauthenticated.
  const requireOperator = () => {
    const auth = verifyOperatorAuth(req, services.operatorAuth);
    if (!auth.ok) {
      json(res, 401, { error: "operator authentication required", reason: auth.reason });
      return false;
    }
    return true;
  };

  // health
  if (method === "GET" && pathname === "/api/health") return json(res, 200, { ok: true, ts: new Date().toISOString() });

  // control channel — long-poll fallback (WebSocket upgrade is handled in channel.mjs)
  if (services.controlChannel) {
    if (method === "GET" && pathname === "/agent/poll") return services.controlChannel.handlePoll(req, res);
    if (method === "POST" && pathname === "/agent/push") return services.controlChannel.handlePush(req, res);
  }

  // bootstrap (zero-touch onboarding)
  if (method === "GET" && pathname === "/bootstrap/manifest") {
    const version = services.config.desiredVersions.controlPlaneAgentVersion;
    const bundle = safe(() => services.bundleRegistry.dataRef("control-plane-agent", version));
    return json(res, 200, { supervisor: { version, bundle } });
  }
  if (method === "GET" && pathname === "/bootstrap/install.ps1") return serveFile(res, "../../bootstrap/windows/install.ps1", "text/plain");
  if (method === "GET" && pathname === "/bootstrap/bootstrap.mjs") return serveFile(res, "../../bootstrap/bootstrap.mjs", "text/javascript");

  // enrollment
  if (method === "POST" && pathname === "/api/enrollment-tokens") {
    if (!requireOperator()) return;
    const body = await readJson(req).catch(() => ({}));
    return json(res, 201, services.enrollment.issueToken({ ...body, issuedBy: "operator" }));
  }
  if (method === "POST" && pathname === "/api/enroll") {
    const body = await readJson(req);
    try {
      return json(res, 200, services.enrollment.enroll(body));
    } catch (e) {
      return json(res, e.httpStatus || 400, { error: e.message });
    }
  }

  // read APIs (operator-authenticated: node inventory + runs disclose infrastructure)
  if (method === "GET" && pathname === "/api/nodes") {
    if (!requireOperator()) return;
    return json(res, 200, { nodes: services.registry.listAll() });
  }

  // runs API (the run pipeline)
  if (method === "POST" && pathname === "/api/runs") {
    if (!requireOperator()) return;
    const body = await readJson(req).catch(() => ({}));
    const run = services.orchestrator.createRun(body);
    return json(res, 201, { runId: run.id, run });
  }
  if (method === "GET" && pathname === "/api/runs") {
    if (!requireOperator()) return;
    return json(res, 200, { runs: services.orchestrator.listRuns() });
  }
  if (pathname.startsWith("/api/runs/")) {
    const parts = pathname.split("/"); // ['', api, runs, runId, (urls)?]
    const runId = decodeURIComponent(parts[3]);
    if (method === "POST" && parts.length === 5 && parts[4] === "urls") {
      if (!requireOperator()) return;
      try {
        return json(res, 202, services.orchestrator.queueUrl(runId, (await readJson(req)).url));
      } catch (e) {
        return json(res, e.httpStatus || 400, { error: e.message });
      }
    }
    if (method === "GET" && parts.length === 4) {
      if (!requireOperator()) return;
      const details = services.orchestrator.getRun(runId);
      return details ? json(res, 200, details) : json(res, 404, { error: "run not found" });
    }
  }

  // command APIs (Portal → agent). Node-authenticated data/control below.
  if (method === "POST" && pathname.startsWith("/api/nodes/") && pathname.endsWith("/reboot")) {
    if (!requireOperator()) return;
    const nodeName = decodeURIComponent(pathname.split("/")[3]);
    return json(res, 202, await services.reboot.reboot(nodeName, await readJson(req).catch(() => ({}))));
  }

  // data plane
  if (pathname.startsWith("/agent/updates/") && pathname.endsWith("/bundle")) {
    const parts = pathname.split("/"); // ['', agent, updates, component, version, bundle]
    if (parts.length === 6) {
      const component = decodeURIComponent(parts[3]);
      const version = decodeURIComponent(parts[4]);
      // GET is public: bundles are integrity-checked (SHA-256), not secret, and the
      // bootstrap fetches the supervisor bundle before it has a node credential.
      if (method === "GET") return services.dataPlane.streamBundle(req, res, { component, version });
      if (method === "PUT") {
        if (!requireOperator()) return;
        return services.dataPlane.publishBundle(req, res, { component, version });
      }
    }
  }
  if (method === "GET" && pathname.startsWith("/artifacts/")) {
    return services.dataPlane.serveArtifact(req, res, { id: decodeURIComponent(pathname.split("/")[2]) });
  }
  if (method === "POST" && pathname === "/api/artifacts/upload") {
    const auth = verifyNodeAuth(req, services.enrollment);
    if (!auth.ok) return json(res, 401, { error: "invalid node credential" });
    return services.dataPlane.ingestArtifact(req, res, auth);
  }
  if (method === "POST" && pathname.startsWith("/api/results/")) {
    const auth = verifyNodeAuth(req, services.enrollment);
    if (!auth.ok) return json(res, 401, { error: "invalid node credential" });
    return services.dataPlane.ingestResult(req, res, decodeURIComponent(pathname.split("/")[3]));
  }

  // portal static
  if (method === "GET" && (pathname === "/" || pathname.startsWith("/assets/"))) {
    return serveFile(res, pathname === "/" ? "../../portal/index.html" : `../../portal${pathname}`, contentTypeFor(pathname));
  }

  return json(res, 404, { error: "not found", pathname });
}

// --- tiny http helpers (kept minimal; a real build would use a router + streaming) ---
function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}
function notImplemented(res, what) {
  return json(res, 501, { error: `not implemented: ${what}` });
}
function fail(res, e) {
  return json(res, 500, { error: e?.message || "internal error" });
}
function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
async function serveFile(res, relPath, contentType) {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    const data = await readFile(resolve(here, relPath));
    res.writeHead(200, { "content-type": contentType });
    res.end(data);
  } catch {
    json(res, 404, { error: "file not found", relPath });
  }
}
function contentTypeFor(p) {
  if (p.endsWith(".html")) return "text/html";
  if (p.endsWith(".js")) return "text/javascript";
  if (p.endsWith(".css")) return "text/css";
  return "application/octet-stream";
}

// CLI entry
if (process.argv[1]?.endsWith("server/index.mjs") || process.argv[1]?.endsWith("index.mjs")) {
  const app = createControlPlaneServer();
  app.listen().then(({ port, host }) => {
    console.log(`[control-plane] listening on ${app.scheme}://${host}:${port}`);
    if (app.scheme === "http") {
      console.warn("[control-plane] WARNING: serving plain HTTP — operator tokens, node credentials, and bundles travel in cleartext. Set WEBINSPECTOR_TLS_CERT_FILE + WEBINSPECTOR_TLS_KEY_FILE for HTTPS.");
    }
  });
}
