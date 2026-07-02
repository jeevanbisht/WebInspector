// Enrollment-token exchange + secure identity persistence (node side).
//
// Zero-trust onboarding: the bootstrap presents a short-lived, single-use enrollment token
// plus the node's claimed identity. The ControlPlane verifies + consumes the token and
// returns a DURABLE node credential (node token today; mTLS client cert-ready) and the
// control-channel URL. The supervisor then authenticates with that credential — the
// enrollment token is never reused.

import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

/**
 * Exchange an enrollment token for a durable node credential.
 * @returns {{ nodeId:string, nodeCredential:string, controlChannelUrl:string, expiresAt?:string }}
 */
export async function enrollNode(controlPlaneUrl, enrollmentToken, identity) {
  const res = await fetch(`${controlPlaneUrl}/api/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollmentToken, identity }),
  });
  if (res.status === 401 || res.status === 409) {
    throw new Error(`enrollment rejected (${res.status}): token invalid, expired, or already used`);
  }
  if (!res.ok) throw new Error(`enrollment failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (!body?.nodeCredential) throw new Error("enrollment response missing nodeCredential");
  return body;
}

/**
 * Persist the node identity + credential to protected local state. The supervisor reads
 * this on startup to authenticate the control channel.
 */
export async function persistIdentity(installRoot, identity) {
  const stateDir = join(installRoot, "state");
  const file = join(stateDir, "node-identity.json");
  await mkdir(stateDir, { recursive: true });
  await writeFile(file, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // Best-effort tighten perms (POSIX). On Windows, restrict via ACLs in install.ps1.
  await chmod(file, 0o600).catch(() => {});
  return file;
}
