// Update-bundle signing (shared, transport-agnostic).
//
// Bundles are content-addressed (SHA-256); a signature additionally binds the PUBLISHER's
// identity to a specific (component, version, sha256) tuple, so a compromised ControlPlane
// cannot push tampered or substituted code that agents will accept. ed25519 (small keys,
// fast, deterministic). The signature covers a canonical message — not the bare digest — so
// a signature can never be replayed across a different component or version.
//
// Verification runs at two chokepoints: on publish (ControlPlane, when publisher public keys
// are configured) and before apply (agent updater, when trusted public keys are configured).

import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, generateKeyPairSync } from "node:crypto";

export const BUNDLE_SIGNING_ALGORITHM = "ed25519";

/** Canonical message that a bundle signature covers. Stable + versioned. */
export function bundleSigningMessage({ component, version, sha256 } = {}) {
  if (!component || !version || !sha256) {
    throw new Error("component, version and sha256 are required to build a bundle signing message");
  }
  return Buffer.from(`webinspector-bundle\nv1\n${component}\n${version}\n${sha256}`, "utf8");
}

/** Sign a bundle with an ed25519 private key (PEM string/Buffer or KeyObject). Returns base64. */
export function signBundle({ component, version, sha256, privateKey } = {}) {
  const key = normalizePrivateKey(privateKey);
  const signature = cryptoSign(null, bundleSigningMessage({ component, version, sha256 }), key);
  return signature.toString("base64");
}

/**
 * Verify a base64 signature against one or more trusted ed25519 public keys.
 * Returns true only if the signature is present, well-formed, and validates under some key.
 */
export function verifyBundleSignature({ component, version, sha256, signature, publicKeys } = {}) {
  if (!signature) return false;
  const keys = normalizePublicKeys(publicKeys);
  if (!keys.length) return false;
  let message;
  let sig;
  try {
    message = bundleSigningMessage({ component, version, sha256 });
    sig = Buffer.from(String(signature), "base64");
  } catch {
    return false;
  }
  if (!sig.length) return false;
  return keys.some((key) => {
    try {
      return cryptoVerify(null, message, key, sig);
    } catch {
      return false;
    }
  });
}

/** Generate an ed25519 keypair as PEM strings (publisher key management / tests). */
export function generateBundleSigningKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function normalizePrivateKey(privateKey) {
  if (!privateKey) throw new Error("a private key is required to sign a bundle");
  if (typeof privateKey === "string" || Buffer.isBuffer(privateKey)) return createPrivateKey(privateKey);
  return privateKey; // already a KeyObject
}

function normalizePublicKeys(publicKeys) {
  const list = Array.isArray(publicKeys) ? publicKeys : publicKeys ? [publicKeys] : [];
  const out = [];
  for (const k of list) {
    if (!k) continue;
    try {
      out.push(typeof k === "string" || Buffer.isBuffer(k) ? createPublicKey(k) : k);
    } catch {
      // ignore malformed keys rather than failing the whole check
    }
  }
  return out;
}
