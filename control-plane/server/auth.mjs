// Auth for the ControlPlane.
//
// Two audiences:
//   - Nodes  (control channel + data plane): authenticate with the durable node credential
//     minted at enrollment (Authorization: Bearer <nodeId>:<nodeCredential>). mTLS-ready.
//   - Operators (/api/* mutations): separate; wire to your IdP/session. TODO.

export function verifyNodeAuth(req, enrollment) {
  const header = req.headers?.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return { ok: false, reason: "missing bearer credential" };
  const idx = m[1].indexOf(":");
  if (idx < 0) return { ok: false, reason: "malformed node credential" };
  const nodeId = m[1].slice(0, idx);
  const credential = m[1].slice(idx + 1);
  if (!enrollment.verifyCredential(nodeId, credential)) return { ok: false, reason: "unknown or revoked node credential" };
  return { ok: true, nodeId };
}

/** Format the header a node/agent sends. */
export function nodeAuthHeader(nodeId, credential) {
  return `Bearer ${nodeId}:${credential}`;
}

// TODO: verifyOperatorAuth(req) — session/OIDC/PAT for Portal-driven mutations.
export function verifyOperatorAuth(_req) {
  return { ok: true, subject: "operator" }; // placeholder; do not ship open
}
