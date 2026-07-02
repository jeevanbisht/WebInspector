// Data-plane HTTP handlers (ControlPlane side).
//
// Bulk transfers that must not block the control channel:
//   PUT  /agent/updates/:component/:version/bundle   publish an immutable bundle (operator)
//   GET  /agent/updates/:component/:version/bundle   stream a bundle (public: integrity-checked)
//   POST /api/artifacts/upload                        ingest a screenshot/HAR (node-authenticated)
//   GET  /artifacts/:id                               serve an artifact by content hash
//   POST /api/results/:jobId                          ingest a bulk result body (node-authenticated)
//
// Every stored blob is content-addressed (SHA-256); the control channel only carries refs.

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";

const COMPONENTS = ["agent", "control-plane-agent"];

export function createDataPlane({ config, bundleRegistry, blobStore, store = null } = {}) {
  const bundleDir = config.server.bundleDir;

  return {
    async publishBundle(req, res, { component, version }) {
      if (!COMPONENTS.includes(component)) return json(res, 400, { error: `unknown component: ${component}` });
      if (!version) return json(res, 400, { error: "version required" });
      // TODO: operator auth before accepting a bundle.
      const buf = await readBody(req);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      await mkdir(bundleDir, { recursive: true });
      await writeFile(join(bundleDir, `${component}-${version}.zip`), buf);
      let rec;
      try {
        rec = bundleRegistry.register({ component, version, sha256, sizeBytes: buf.length });
      } catch (e) {
        return json(res, 409, { error: e.message }); // immutable: already registered
      }
      return json(res, 201, { component, version, sha256, sizeBytes: buf.length, downloadUrl: rec.downloadUrl });
    },

    async streamBundle(req, res, { component, version }) {
      const rec = bundleRegistry.get(component, version);
      const file = join(bundleDir, `${component}-${version}.zip`);
      if (!rec || !existsSync(file)) return json(res, 404, { error: "bundle not found" });
      const { size } = await stat(file);
      res.writeHead(200, { "content-type": "application/zip", "content-length": size, "x-bundle-sha256": rec.sha256 });
      createReadStream(file).pipe(res);
    },

    async ingestArtifact(req, res, auth) {
      const buf = await readBody(req);
      let meta;
      try {
        meta = await blobStore.put(buf, { kind: req.headers["x-artifact-kind"] || "file", sha256: req.headers["x-artifact-sha256"], contentType: req.headers["content-type"] });
      } catch (e) {
        return json(res, e.httpStatus || 500, { error: e.message });
      }
      const rec = {
        artifactId: meta.artifactId,
        kind: meta.kind,
        sizeBytes: meta.sizeBytes,
        contentType: meta.contentType,
        nodeName: auth?.nodeId ? auth.nodeId.split(":").slice(1).join(":") : null,
        jobId: req.headers["x-job-id"] || null,
        url: `/artifacts/${meta.artifactId}`,
        createdAt: meta.createdAt,
      };
      persist(store, "artifacts", meta.artifactId, rec);
      return json(res, 201, { artifactId: meta.artifactId, url: rec.url, sizeBytes: meta.sizeBytes });
    },

    async serveArtifact(req, res, { id }) {
      if (!blobStore.has(id)) return json(res, 404, { error: "artifact not found" });
      const meta = await blobStore.meta(id);
      const headers = { "content-type": meta?.contentType || "application/octet-stream" };
      if (meta?.sizeBytes) headers["content-length"] = meta.sizeBytes;
      res.writeHead(200, headers);
      blobStore.stream(id).pipe(res);
    },

    async ingestResult(req, res, jobId) {
      const body = await readJson(req);
      persist(store, "results", jobId, { id: jobId, ...body, receivedAt: new Date().toISOString() });
      return json(res, 202, { received: true, jobId });
    },
  };
}

function persist(store, table, id, rec) {
  const pr = store?.put?.(table, id, rec);
  pr?.catch?.(() => {});
}

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
async function readJson(req) {
  const buf = await readBody(req);
  return buf.length ? JSON.parse(buf.toString("utf8")) : {};
}
