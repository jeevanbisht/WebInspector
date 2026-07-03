// Auth for the ControlPlane.
//
// Two audiences:
//   - Nodes  (control channel + data plane): authenticate with the durable node credential
//     minted at enrollment (Authorization: Bearer <nodeId>:<nodeCredential>). mTLS-ready.
//   - Operators (/api/* mutations): separate; wire to your IdP/session. TODO.

import { randomBytes, timingSafeEqual } from "node:crypto";

export function verifyNodeAuth(req, enrollment) {
  // nodeId (nodeType:nodeName) carries a colon, so it travels in its own header rather than
  // being packed into the bearer value.
  const nodeId = req.headers?.["x-node-id"];
  if (!nodeId) return { ok: false, reason: "missing x-node-id" };

  // mTLS: a client certificate pinned at enrollment authenticates the node. When TLS + mTLS
  // are enabled the server requests the cert; self-signed certs reach here for app-level pinning.
  const fingerprint = peerCertFingerprint(req);
  if (fingerprint && enrollment.verifyClientCert?.(nodeId, fingerprint)) {
    return { ok: true, nodeId, method: "mtls" };
  }

  // Durable bearer credential.
  const m = /^Bearer\s+(.+)$/i.exec(req.headers?.authorization || "");
  if (!m) return { ok: false, reason: fingerprint ? "client certificate not recognized" : "missing bearer credential" };
  if (!enrollment.verifyCredential(nodeId, m[1].trim())) return { ok: false, reason: "unknown or revoked node credential" };
  return { ok: true, nodeId, method: "bearer" };
}

function peerCertFingerprint(req) {
  try {
    const cert = req.socket?.getPeerCertificate?.();
    return cert && cert.fingerprint256 ? cert.fingerprint256 : null;
  } catch {
    return null;
  }
}

/** Headers a node/agent sends on the control channel + data plane. */
export function nodeAuthHeaders(nodeId, credential) {
  return { authorization: `Bearer ${credential}`, "x-node-id": nodeId };
}

// Operator auth for /api/* mutations (enrollment issuance, runs, reboot, bundle publish).
//
// Bearer PAT to start; inject a custom `verify(req) -> { ok, subject?, reason? }` for OIDC or
// a session store. Denies by default: if neither tokens nor a verifier are supplied, an
// ephemeral token is minted for this process (and logged) so the surface is never open.
export function createOperatorAuth({ tokens = [], verify = null, logger = console } = {}) {
  const customVerify = typeof verify === "function" ? verify : null;
  let allow = normalizeTokens(tokens);
  let generatedToken = null;
  if (!customVerify && allow.length === 0) {
    generatedToken = `op_${randomBytes(24).toString("base64url")}`;
    allow = [generatedToken];
    logger?.warn?.(
      "[auth] no operator token configured — generated an ephemeral one for this process. " +
        `Set WEBINSPECTOR_OPERATOR_TOKEN to override. Token: ${generatedToken}`,
    );
  }
  return {
    generatedToken,
    verify(req) {
      if (customVerify) return customVerify(req);
      const token = bearerToken(req);
      if (!token) return { ok: false, reason: "missing operator credential" };
      const ok = allow.some((t) => constantTimeEquals(t, token));
      return ok ? { ok: true, subject: "operator" } : { ok: false, reason: "invalid operator credential" };
    },
  };
}

/** Verify an operator request against a created operator-auth instance. Fails closed. */
export function verifyOperatorAuth(req, operatorAuth) {
  if (!operatorAuth || typeof operatorAuth.verify !== "function") {
    return { ok: false, reason: "operator auth not configured" };
  }
  return operatorAuth.verify(req);
}

function bearerToken(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers?.authorization || "");
  return m ? m[1].trim() : null;
}

function constantTimeEquals(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function normalizeTokens(tokens) {
  const list = Array.isArray(tokens) ? tokens : String(tokens || "").split(",");
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
}
