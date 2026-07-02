// Enrollment (ControlPlane side).
//
// Issues and verifies short-lived, single-use enrollment tokens, and mints durable node
// credentials — the zero-trust half of zero-touch onboarding.
//
// Endpoints wired by the server:
//   POST /api/enrollment-tokens   (operator) issue a token, scoped to a nodeType
//   POST /api/enroll              (bootstrap) exchange token + identity → node credential
//
// Best practices: tokens are single-use, TTL-bounded, scoped, and revocable; the returned
// node credential is what the supervisor authenticates with (never the enrollment token).
//
// TODO: replace the opaque node token with an issued mTLS client certificate; persist
// tokens + credentials in the durable state store.

import { randomBytes } from "node:crypto";
import { assertNodeIdentity } from "../../shared/contracts/nodes.mjs";

export function createEnrollmentService({ store = null, controlChannelPath = "/agent/channel", tokenTtlMs = 15 * 60 * 1000 } = {}) {
  const tokens = new Map(); // token -> { nodeType, expiresAt, oneTimeUse, used, issuedBy }
  const credentials = new Map(); // nodeId -> { nodeName, nodeType, credential, issuedAt }

  function issueToken({ nodeType, ttlMs = tokenTtlMs, oneTimeUse = true, issuedBy = null } = {}) {
    const token = `enr_${randomBytes(24).toString("base64url")}`;
    const record = {
      token,
      nodeType: nodeType || null, // null = any allowed type
      expiresAt: Date.now() + ttlMs,
      oneTimeUse,
      used: false,
      issuedBy,
      issuedAt: new Date().toISOString(),
    };
    tokens.set(token, record);
    // TODO: persist via store
    return { token, expiresAt: new Date(record.expiresAt).toISOString(), nodeType: record.nodeType };
  }

  /** Verify + consume a token and mint a node credential. Throws on any policy failure. */
  function enroll({ enrollmentToken, identity } = {}) {
    const rec = tokens.get(enrollmentToken);
    if (!rec) throw enrollError(401, "unknown enrollment token");
    if (Date.now() > rec.expiresAt) throw enrollError(401, "enrollment token expired");
    if (rec.oneTimeUse && rec.used) throw enrollError(409, "enrollment token already used");

    const { nodeName, nodeType } = assertNodeIdentity(identity || {});
    if (rec.nodeType && rec.nodeType !== nodeType) {
      throw enrollError(401, `token scoped to ${rec.nodeType}, not ${nodeType}`);
    }

    rec.used = true; // consume (single-use)

    const nodeId = `${nodeType}:${nodeName}`;
    const credential = `nodecred_${randomBytes(32).toString("base64url")}`; // TODO: mTLS cert
    credentials.set(nodeId, { nodeName, nodeType, credential, issuedAt: new Date().toISOString() });
    // TODO: persist via store

    return {
      nodeId,
      nodeCredential: credential,
      controlChannelUrl: controlChannelPath,
      nodeName,
      nodeType,
    };
  }

  function verifyCredential(nodeId, credential) {
    const rec = credentials.get(nodeId);
    return Boolean(rec) && rec.credential === credential;
  }

  function revokeToken(token) {
    tokens.delete(token);
  }

  return { issueToken, enroll, verifyCredential, revokeToken };
}

function enrollError(status, message) {
  const err = new Error(message);
  err.httpStatus = status;
  return err;
}
