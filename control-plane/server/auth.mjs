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
  const credential = m[1].trim();
  // nodeId (nodeType:nodeName) carries a colon, so it travels in its own header rather than
  // being packed into the bearer value.
  const nodeId = req.headers?.["x-node-id"];
  if (!nodeId) return { ok: false, reason: "missing x-node-id" };
  if (!enrollment.verifyCredential(nodeId, credential)) return { ok: false, reason: "unknown or revoked node credential" };
  return { ok: true, nodeId };
}

/** Headers a node/agent sends on the control channel + data plane. */
export function nodeAuthHeaders(nodeId, credential) {
  return { authorization: `Bearer ${credential}`, "x-node-id": nodeId };
}

// TODO: verifyOperatorAuth(req) — session/OIDC/PAT for Portal-driven mutations.
export function verifyOperatorAuth(_req) {
  return { ok: true, subject: "operator" }; // placeholder; do not ship open
}
