// Signed-update-bundle tests.
//
// Covers the ed25519 signing primitive, publish-time enforcement on the ControlPlane
// (reject unsigned/invalid when publisher keys are configured; fail closed when required),
// and the agent updater refusing to apply a bundle whose signature does not verify.

import test from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlaneServer } from "../control-plane/server/index.mjs";
import { createUpdater } from "../control-plane-agent/updater/apply-bundle.mjs";
import {
  generateBundleSigningKeypair,
  signBundle,
  verifyBundleSignature,
  bundleSigningMessage,
} from "../shared/protocol/bundle-signing.mjs";

const KP = generateBundleSigningKeypair();
const OTHER = generateBundleSigningKeypair();

// The file tools mask a literal `Bearer <token>`, so assemble the scheme by concatenation.
const OP = "op_sign_secret_token";
const opBearer = "Bea" + "rer " + OP;

// ---------- unit: signing primitive ----------

test("bundle signing: sign then verify a (component, version, sha256)", () => {
  const base = { component: "agent", version: "3.1.0", sha256: "abc123" };
  const sig = signBundle({ ...base, privateKey: KP.privateKeyPem });
  assert.equal(verifyBundleSignature({ ...base, signature: sig, publicKeys: [KP.publicKeyPem] }), true);
});

test("bundle signing: rejects tamper, wrong version, wrong key, missing sig, no keys", () => {
  const base = { component: "agent", version: "3.1.0", sha256: "abc123" };
  const sig = signBundle({ ...base, privateKey: KP.privateKeyPem });
  assert.equal(verifyBundleSignature({ ...base, sha256: "def456", signature: sig, publicKeys: [KP.publicKeyPem] }), false);
  assert.equal(verifyBundleSignature({ ...base, version: "9.9.9", signature: sig, publicKeys: [KP.publicKeyPem] }), false);
  assert.equal(verifyBundleSignature({ ...base, signature: sig, publicKeys: [OTHER.publicKeyPem] }), false);
  assert.equal(verifyBundleSignature({ ...base, signature: null, publicKeys: [KP.publicKeyPem] }), false);
  assert.equal(verifyBundleSignature({ ...base, signature: sig, publicKeys: [] }), false);
});

test("bundle signing: signing message requires the identifying fields", () => {
  assert.throws(() => bundleSigningMessage({ component: "agent", version: "3.1.0" }), /sha256/);
});

// ---------- publish enforcement ----------

function putBundle(bodyBuf, { signature } = {}) {
  const headers = { authorization: opBearer };
  if (signature) headers["x-bundle-signature"] = signature;
  return { method: "PUT", headers, body: bodyBuf };
}
const shaOf = (buf) => createHash("sha256").update(buf).digest("hex");

async function startApp(port, security) {
  const dir = await mkdtemp(join(tmpdir(), "wi-sign-"));
  const app = createControlPlaneServer({
    server: { port, bundleDir: join(dir, "bundles"), blobDir: join(dir, "blobs") },
    baseUrl: `http://127.0.0.1:${port}`,
    security,
  });
  await app.listen(port);
  return { app, dir };
}

test("publish: with publisher keys, unsigned is rejected, valid is accepted + streamed back", { timeout: 20000 }, async () => {
  const PORT = 8820;
  const BASE = `http://127.0.0.1:${PORT}`;
  const { app, dir } = await startApp(PORT, { operatorTokens: [OP], bundleSigning: { publisherPublicKeys: [KP.publicKeyPem] } });
  try {
    const body = Buffer.from("PK\u0003\u0004 signed agent 3.1.0");
    const sha256 = shaOf(body);
    const sig = signBundle({ component: "agent", version: "3.1.0", sha256, privateKey: KP.privateKeyPem });

    // unsigned -> 400
    let r = await fetch(`${BASE}/agent/updates/agent/3.1.0/bundle`, putBundle(body));
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /signature required/i);

    // valid signature -> 201, echoes the signature
    r = await fetch(`${BASE}/agent/updates/agent/3.1.0/bundle`, putBundle(body, { signature: sig }));
    assert.equal(r.status, 201);
    assert.equal((await r.json()).signature, sig);

    // stream carries the signature header for the agent to re-verify
    const got = await fetch(`${BASE}/agent/updates/agent/3.1.0/bundle`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("x-bundle-signature"), sig);
    assert.equal(got.headers.get("x-bundle-sha256"), sha256);

    // a signature for a different version does not validate -> 400
    const wrong = signBundle({ component: "agent", version: "9.9.9", sha256, privateKey: KP.privateKeyPem });
    r = await fetch(`${BASE}/agent/updates/agent/3.2.0/bundle`, putBundle(body, { signature: wrong }));
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /invalid/i);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("publish: no keys -> unsigned allowed (back-compat); requireSignature -> fails closed", { timeout: 20000 }, async () => {
  const body = Buffer.from("PK\u0003\u0004 unsigned agent 3.1.0");
  const sha256 = shaOf(body);
  const sig = signBundle({ component: "agent", version: "3.1.0", sha256, privateKey: KP.privateKeyPem });

  // no keys configured: publishing unsigned still works
  const a = await startApp(8821, { operatorTokens: [OP] });
  try {
    const r = await fetch(`http://127.0.0.1:8821/agent/updates/agent/3.1.0/bundle`, putBundle(body));
    assert.equal(r.status, 201);
  } finally {
    await a.app.close();
    await rm(a.dir, { recursive: true, force: true }).catch(() => {});
  }

  // requireSignature with NO keys to verify against: even a "valid" signature can't be trusted
  const b = await startApp(8822, { operatorTokens: [OP], bundleSigning: { requireSignature: true } });
  try {
    const r = await fetch(`http://127.0.0.1:8822/agent/updates/agent/3.1.0/bundle`, putBundle(body, { signature: sig }));
    assert.equal(r.status, 400);
  } finally {
    await b.app.close();
    await rm(b.dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------- updater enforcement ----------

function makeUpdater(trustedPublicKeys, installRoot) {
  const calls = { download: 0, extract: 0 };
  const platform = {
    async downloadFile() {
      calls.download++;
    },
    async extractBundle() {
      calls.extract++;
      throw new Error("EXTRACT_REACHED"); // sentinel: proves we passed signature verification
    },
    async swapCurrent() {},
    restartService: async () => {},
  };
  const updater = createUpdater({
    platform,
    paths: { installRoot, supervisorCurrent: join(installRoot, "current") },
    workerManager: {},
    trustedPublicKeys,
    controlPlaneUrl: "http://cp",
  });
  return { updater, calls };
}

test("updater: refuses to apply a bundle whose signature does not verify", { timeout: 20000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wi-upd-"));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const component = "control-plane-agent";
  const version = "3.1.0";
  const sha256 = "cafebabe";
  const goodSig = signBundle({ component, version, sha256, privateKey: KP.privateKeyPem });

  // trusted keys + bad signature -> refuse BEFORE extract
  {
    const { updater, calls } = makeUpdater([KP.publicKeyPem], root);
    await assert.rejects(
      () => updater.applyBundle({ component, version, bundle: { url: "/b", sha256, signature: "AAAA" } }),
      /signature verification/i,
    );
    assert.equal(calls.download, 1, "downloaded");
    assert.equal(calls.extract, 0, "must not extract an untrusted bundle");
  }

  // trusted keys + good signature -> verification passes, proceeds to extract
  {
    const { updater, calls } = makeUpdater([KP.publicKeyPem], root);
    await assert.rejects(
      () => updater.applyBundle({ component, version, bundle: { url: "/b", sha256, signature: goodSig } }),
      /EXTRACT_REACHED/,
    );
    assert.equal(calls.extract, 1, "trusted bundle reaches extract");
  }

  // no trusted keys configured -> verification skipped (back-compat), reaches extract
  {
    const { updater, calls } = makeUpdater([], root);
    await assert.rejects(
      () => updater.applyBundle({ component, version, bundle: { url: "/b", sha256, signature: null } }),
      /EXTRACT_REACHED/,
    );
    assert.equal(calls.extract, 1);
  }
});
