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
// Tokens + credentials are hashed at rest and WRITTEN THROUGH to the durable store, then
// re-hydrated on startup (load()), so a restarted ControlPlane still recognizes enrolled nodes.
// TODO: replace the opaque node token with an issued mTLS client certificate.

import { randomBytes, createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { assertNodeIdentity } from "../../shared/contracts/nodes.mjs";

// Tokens + node credentials are stored ONLY as SHA-256 hashes, so a leak of enrollment or
// registry state never yields a usable secret. The plaintext is returned to the caller once.
const sha256Hex = (v) => createHash("sha256").update(String(v)).digest("hex");

export function createEnrollmentService({ store = null, controlChannelPath = "/agent/channel", tokenTtlMs = 15 * 60 * 1000 } = {}) {
  const tokens = new Map(); // tokenHash -> { tokenHash, nodeType, expiresAt, oneTimeUse, used, issuedBy }
  const credentials = new Map(); // nodeId -> { nodeId, nodeName, nodeType, credentialHash, issuedAt, revoked }

  // Best-effort write-through to the durable store so identity survives a restart.
  const persist = (table, id, rec) => {
    const p = store?.put?.(table, id, rec);
    p?.catch?.(() => {});
  };
  const remove = (table, id) => {
    const p = store?.delete?.(table, id);
    p?.catch?.(() => {});
  };

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
    const tokenHash = sha256Hex(token); // hashed at rest; raw token never stored
    tokens.set(tokenHash, { tokenHash, ...record });
    persist("enrollments", tokenHash, { tokenHash, ...record });
    return { token, expiresAt: new Date(record.expiresAt).toISOString(), nodeType: record.nodeType };
  }

  /** Verify + consume a token and mint a node credential. Throws on any policy failure. */
  function enroll({ enrollmentToken, identity, clientCertPem = null } = {}) {
    const tokenHash = enrollmentToken ? sha256Hex(enrollmentToken) : null;
    const rec = tokenHash ? tokens.get(tokenHash) : null;
    if (!rec) throw enrollError(401, "unknown enrollment token");
    if (Date.now() > rec.expiresAt) throw enrollError(401, "enrollment token expired");
    if (rec.oneTimeUse && rec.used) throw enrollError(409, "enrollment token already used");

    const { nodeName, nodeType } = assertNodeIdentity(identity || {});
    if (rec.nodeType && rec.nodeType !== nodeType) {
      throw enrollError(401, `token scoped to ${rec.nodeType}, not ${nodeType}`);
    }

    // Optional mTLS: pin the node's client-certificate fingerprint at enrollment.
    let certFingerprint = null;
    if (clientCertPem) {
      try {
        certFingerprint = new X509Certificate(clientCertPem).fingerprint256;
      } catch {
        throw enrollError(400, "invalid client certificate");
      }
    }

    rec.used = true; // consume (single-use)
    persist("enrollments", tokenHash, rec);

    const nodeId = `${nodeType}:${nodeName}`;
    const credential = `nodecred_${randomBytes(32).toString("base64url")}`;
    const credRec = { nodeId, nodeName, nodeType, credentialHash: sha256Hex(credential), certFingerprint, issuedAt: new Date().toISOString(), revoked: false };
    credentials.set(nodeId, credRec);
    persist("credentials", nodeId, credRec);

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

  /** mTLS: compare a presented client-cert fingerprint (sha256) to the one pinned at enroll. */
  function verifyClientCert(nodeId, fingerprint256) {
    const rec = credentials.get(nodeId);
    if (!rec || rec.revoked || !rec.certFingerprint || !fingerprint256) return false;
    return safeEqualHex(normalizeFingerprint(rec.certFingerprint), normalizeFingerprint(fingerprint256));
  }

  function revokeCredential(nodeId) {
    const rec = credentials.get(nodeId);
    if (rec) {
      rec.revoked = true;
      persist("credentials", nodeId, rec);
    }
    return Boolean(rec);
  }

  function revokeToken(token) {
    const tokenHash = sha256Hex(token);
    remove("enrollments", tokenHash);
    return tokens.delete(tokenHash);
  }

  /** Hydrate tokens + credentials from the durable store on startup (post-restart recovery). */
  async function load() {
    if (!store) return;
    for (const rec of (await store.list("enrollments", {}).catch(() => [])) || []) {
      const h = rec?.tokenHash || rec?.id;
      if (h) tokens.set(h, rec);
    }
    for (const rec of (await store.list("credentials", {}).catch(() => [])) || []) {
      const id = rec?.nodeId || rec?.id;
      if (id) credentials.set(id, rec);
    }
  }

  return { issueToken, enroll, verifyCredential, verifyClientCert, revokeCredential, revokeToken, load };
}

// Normalize an X.509 sha256 fingerprint ("AA:BB:..") to a bare lowercase hex string.
function normalizeFingerprint(fp) {
  return String(fp).replace(/:/g, "").toLowerCase();
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
