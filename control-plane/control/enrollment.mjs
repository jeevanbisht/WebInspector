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

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { assertNodeIdentity } from "../../shared/contracts/nodes.mjs";

// Tokens + node credentials are stored ONLY as SHA-256 hashes, so a leak of enrollment or
// registry state never yields a usable secret. The plaintext is returned to the caller once.
const sha256Hex = (v) => createHash("sha256").update(String(v)).digest("hex");

export function createEnrollmentService({ store = null, controlChannelPath = "/agent/channel", tokenTtlMs = 15 * 60 * 1000 } = {}) {
  const tokens = new Map(); // tokenHash -> { nodeType, expiresAt, oneTimeUse, used, issuedBy }
  const credentials = new Map(); // nodeId -> { nodeName, nodeType, credentialHash, issuedAt, revoked }

  function issueToken({ nodeType, ttlMs = tokenTtlMs, oneTimeUse = true, issuedBy = null } = {}) {
    const token = `enr_${randomBytes(24).toString("base64url")}`;
    const record = {
      nodeType: nodeType || null, // null = any allowed type
      expiresAt: Date.now() + ttlMs,
      oneTimeUse,
      used: false,
      issuedBy,
      issuedAt: new Date().toISOString(),
    };
    tokens.set(sha256Hex(token), record); // hashed at rest; raw token never stored
    // TODO: persist via store
    return { token, expiresAt: new Date(record.expiresAt).toISOString(), nodeType: record.nodeType };
  }

  /** Verify + consume a token and mint a node credential. Throws on any policy failure. */
  function enroll({ enrollmentToken, identity } = {}) {
    const rec = enrollmentToken ? tokens.get(sha256Hex(enrollmentToken)) : null;
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
    credentials.set(nodeId, { nodeName, nodeType, credentialHash: sha256Hex(credential), issuedAt: new Date().toISOString(), revoked: false });
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
    if (!rec || rec.revoked || !credential) return false;
    return safeEqualHex(sha256Hex(credential), rec.credentialHash);
  }

  function revokeCredential(nodeId) {
    const rec = credentials.get(nodeId);
    if (rec) rec.revoked = true;
    return Boolean(rec);
  }

  function revokeToken(token) {
    return tokens.delete(sha256Hex(token));
  }

  return { issueToken, enroll, verifyCredential, revokeCredential, revokeToken };
}

// Constant-time compare of two equal-length hex digests (avoids credential timing oracles).
function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), "hex");
  const bb = Buffer.from(String(b), "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function enrollError(status, message) {
  const err = new Error(message);
  err.httpStatus = status;
  return err;
}
