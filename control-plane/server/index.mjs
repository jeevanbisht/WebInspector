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
import { loadControlPlaneConfig } from "../config.mjs";
import { createRegistry } from "../control/registry.mjs";
import { createDispatcher } from "../control/dispatcher.mjs";
import { createReconciler } from "../control/reconciler.mjs";
import { createUpdateManager } from "../control/update-manager.mjs";
import { createBundleRegistry } from "../control/bundle-registry.mjs";
import { createRebootManager } from "../control/reboot-manager.mjs";
import { createEnrollmentService } from "../control/enrollment.mjs";
import { verifyNodeAuth } from "./auth.mjs";

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
  const reboot = createRebootManager({ dispatcher, registry, store });
  const reconciler = createReconciler({ registry, dispatcher, updateManager });

  const services = { config, store, registry, dispatcher, bundleRegistry, updateManager, enrollment, reboot, reconciler };

  const server = http.createServer((req, res) => route(req, res, services).catch((e) => fail(res, e)));

  // Control channel lives on the same port via HTTP upgrade.
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url, baseUrl).pathname === "/agent/channel") {
      // TODO: complete WS handshake; on open, authenticate via verifyNodeAuth, then
      // registry.attachSession(nodeId, session) and pump envelopes to dispatcher/registry.
      socket.destroy(); // placeholder until WS transport is implemented
    } else {
      socket.destroy();
    }
  });

  return {
    services,
    listen(port = config.server.port, host = config.server.host) {
      reconciler.start({ intervalMs: 5000 });
      return new Promise((resolve) => server.listen(port, host, () => resolve({ port, host })));
    },
    close() {
      reconciler.stop();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

async function route(req, res, services) {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;
  const method = req.method;

  // health
  if (method === "GET" && pathname === "/api/health") return json(res, 200, { ok: true, ts: new Date().toISOString() });

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
    const body = await readJson(req); // TODO: operator auth
    return json(res, 201, services.enrollment.issueToken(body));
  }
  if (method === "POST" && pathname === "/api/enroll") {
    const body = await readJson(req);
    try {
      return json(res, 200, services.enrollment.enroll(body));
    } catch (e) {
      return json(res, e.httpStatus || 400, { error: e.message });
    }
  }

  // read APIs (Portal)
  if (method === "GET" && pathname === "/api/nodes") return json(res, 200, { nodes: services.registry.listAll() });

  // command APIs (Portal → agent). Node-authenticated data/control below.
  if (method === "POST" && pathname.startsWith("/api/nodes/") && pathname.endsWith("/reboot")) {
    const nodeName = decodeURIComponent(pathname.split("/")[3]);
    return json(res, 202, await services.reboot.reboot(nodeName, await readJson(req).catch(() => ({}))));
  }

  // data plane (node-authenticated)
  if (method === "GET" && pathname.startsWith("/agent/updates/")) {
    // GET /agent/updates/:version/bundle → stream the bundle file (TODO: from bundleDir)
    return notImplemented(res, "bundle streaming");
  }
  if (method === "POST" && (pathname.startsWith("/api/results/") || pathname === "/api/artifacts/upload")) {
    const auth = verifyNodeAuth(req, services.enrollment);
    if (!auth.ok) return json(res, 401, { error: "invalid node credential" });
    return notImplemented(res, "data-plane ingest");
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
  app.listen().then(({ port, host }) => console.log(`[control-plane] listening on http://${host}:${port}`));
}
