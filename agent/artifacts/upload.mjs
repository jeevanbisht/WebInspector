// Artifact upload (worker side) — DATA plane.
//
// Uploads a screenshot/HAR to the ControlPlane (or an offloaded endpoint) and returns an
// `artifact_ref` (a content-addressed data-ref) that the supervisor carries UP the control
// channel. The bytes never touch the control channel.
//
// TODO: honor an issued upload ticket (Blob + SAS) when present, and support resumable PUT.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { makeDataRef } from "../../shared/protocol/data-plane.mjs";

export async function uploadArtifact(controlPlaneUrl, artifact, { authHeader, uploadTicket } = {}) {
  const buf = await readFile(artifact.path);
  const sha256 = artifact.sha256 || createHash("sha256").update(buf).digest("hex");
  const base = controlPlaneUrl.replace(/\/$/, "");
  const uploadUrl = uploadTicket?.uploadUrl || `${base}/api/artifacts/upload`;

  const res = await fetch(uploadUrl, {
    method: uploadTicket?.method || "POST",
    headers: {
      "content-type": kindContentType(artifact.kind),
      "x-artifact-kind": artifact.kind,
      "x-artifact-sha256": sha256,
      ...(artifact.jobId ? { "x-job-id": artifact.jobId } : {}),
      ...(authHeader ? { authorization: authHeader } : {}),
      ...(uploadTicket?.headers || {}),
    },
    body: buf,
  });
  if (!res.ok) throw new Error(`artifact upload failed: ${res.status}`);
  const body = await res.json().catch(() => ({}));
  const artifactUrl = body.url
    ? body.url.startsWith("http")
      ? body.url
      : `${base}${body.url}`
    : `${base}/artifacts/${body.artifactId || sha256}`;

  return makeDataRef({
    kind: artifact.kind,
    url: artifactUrl,
    sha256,
    sizeBytes: buf.length,
    jobId: artifact.jobId || null,
    nodeName: artifact.nodeName || null,
  });
}

function kindContentType(kind) {
  return kind === "screenshot" ? "image/png" : "application/json";
}
