// Data-plane contract.
//
// The data plane carries BULK bytes that must not block the control channel:
//   - full result bodies
//   - screenshots (image/png)
//   - HAR network waterfalls (application/json)
//   - update bundles (application/zip)
//   - large log/telemetry batches
//
// Transport is plain HTTP request/response streams on the ControlPlane's SINGLE port by
// default, but every transfer is addressed by a URL that the ControlPlane ISSUES. That
// indirection lets the data plane be offloaded later (e.g. Azure Blob + SAS) with ZERO
// change to the control protocol — the control channel only ever carries references.
//
// Reliability rules for every transfer: content-addressed by SHA-256, resumable, and
// retried independently of the control channel.

export const DATA_KINDS = Object.freeze([
  "result",
  "screenshot",
  "har",
  "trace",
  "log_batch",
  "update_bundle",
]);

export const DATA_CONTENT_TYPES = Object.freeze({
  result: "application/json",
  screenshot: "image/png",
  har: "application/json",
  trace: "application/zip",
  log_batch: "application/json",
  update_bundle: "application/zip",
});

export function isDataKind(value) {
  return DATA_KINDS.includes(value);
}

/**
 * A reference to bulk data, carried on the CONTROL channel (result_ref / artifact_ref).
 * The bytes live on the data plane at `url`.
 */
export function makeDataRef({ kind, url, sha256, sizeBytes, jobId = null, nodeName = null } = {}) {
  if (!isDataKind(kind)) throw new Error(`unknown data kind: ${kind}`);
  if (!url) throw new Error("data ref requires a url");
  if (!sha256) throw new Error("data ref requires a sha256 (content-addressed)");
  return {
    kind,
    url,
    sha256,
    sizeBytes: Number(sizeBytes || 0),
    contentType: DATA_CONTENT_TYPES[kind],
    jobId,
    nodeName,
    createdAt: new Date().toISOString(),
  };
}

/**
 * An upload ticket ISSUED by the ControlPlane telling an agent where + how to PUT bulk
 * data. `uploadUrl` defaults to the same port but can point at offloaded storage (Blob
 * + SAS) without touching the control protocol.
 */
export function makeUploadTicket({
  kind,
  uploadUrl,
  method = "PUT",
  headers = {},
  maxBytes = 0,
  expiresAt = null,
  sha256Required = true,
} = {}) {
  if (!isDataKind(kind)) throw new Error(`unknown data kind: ${kind}`);
  if (!uploadUrl) throw new Error("upload ticket requires an uploadUrl");
  return {
    kind,
    uploadUrl,
    method,
    headers,
    maxBytes: Number(maxBytes || 0),
    resumable: true,
    sha256Required: Boolean(sha256Required),
    contentType: DATA_CONTENT_TYPES[kind],
    expiresAt,
    issuedAt: new Date().toISOString(),
  };
}
