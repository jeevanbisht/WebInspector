// Credential-hygiene tests.
//
// Node credentials and enrollment tokens are stored only as SHA-256 hashes; verification is
// constant-time; credentials are revocable. These tests exercise the observable behaviour of
// the hardened enrollment service.

import test from "node:test";
import assert from "node:assert";
import { createEnrollmentService } from "../control-plane/control/enrollment.mjs";

test("credential hygiene: enroll -> verify -> revoke", () => {
  const svc = createEnrollmentService();
  const { token } = svc.issueToken({ nodeType: "azure_direct" });
  const enr = svc.enroll({ enrollmentToken: token, identity: { nodeName: "VM1", nodeType: "azure_direct" } });

  assert.match(enr.nodeCredential, /^nodecred_/, "plaintext credential returned once");
  assert.equal(svc.verifyCredential(enr.nodeId, enr.nodeCredential), true);
  assert.equal(svc.verifyCredential(enr.nodeId, "nodecred_wrong"), false);
  assert.equal(svc.verifyCredential(enr.nodeId, ""), false);
  assert.equal(svc.verifyCredential("azure_direct:GHOST", enr.nodeCredential), false, "unknown node");

  assert.equal(svc.revokeCredential(enr.nodeId), true);
  assert.equal(svc.verifyCredential(enr.nodeId, enr.nodeCredential), false, "revoked credential no longer verifies");
  assert.equal(svc.revokeCredential("azure_direct:GHOST"), false, "revoking an unknown node is a no-op");
});

test("credential hygiene: enrollment token is single-use and type-scoped", () => {
  const svc = createEnrollmentService();
  const { token } = svc.issueToken({ nodeType: "gsa_client" });

  // wrong type is rejected without consuming the token
  assert.throws(() => svc.enroll({ enrollmentToken: token, identity: { nodeName: "X", nodeType: "azure_direct" } }), /scoped/);
  // correct type consumes it
  const enr = svc.enroll({ enrollmentToken: token, identity: { nodeName: "C1", nodeType: "gsa_client" } });
  assert.ok(enr.nodeCredential);
  // reuse rejected
  assert.throws(() => svc.enroll({ enrollmentToken: token, identity: { nodeName: "C2", nodeType: "gsa_client" } }), /already used/);
});

test("credential hygiene: unknown / revoked token cannot enroll", () => {
  const svc = createEnrollmentService();
  assert.throws(() => svc.enroll({ enrollmentToken: "enr_not_real", identity: { nodeName: "V", nodeType: "azure_direct" } }), /unknown enrollment token/);
  assert.throws(() => svc.enroll({ identity: { nodeName: "V", nodeType: "azure_direct" } }), /unknown enrollment token/);

  const { token } = svc.issueToken({ nodeType: "azure_direct" });
  assert.equal(svc.revokeToken(token), true);
  assert.throws(() => svc.enroll({ enrollmentToken: token, identity: { nodeName: "V", nodeType: "azure_direct" } }), /unknown enrollment token/);
});
