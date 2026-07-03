// Evidence-packet tests.
//
// The per-site packet must (a) collect the artifacts referenced by browser-validation results,
// (b) flag any REQUIRED artifact that's missing (screenshot always; HAR when the validation
// failed) so completeness is auditable, and (c) persist the manifest to the durable store.

import test from "node:test";
import assert from "node:assert";
import { createStateStore } from "../control-plane/state/store.mjs";
import { memoryAdapter } from "../control-plane/state/adapters/memory.mjs";
import { createSitePacket, siteKeyFor } from "../control-plane/reporting/site-packet.mjs";

function results({ harForG1 = true } = {}) {
  return [
    { stage: "initial_test", nodeName: "D1", nodeType: "azure_direct", ok: true },
    {
      stage: "browser_validation",
      nodeName: "G1",
      nodeType: "gsa_remotenet",
      ok: false,
      artifactRefs: [{ kind: "screenshot", url: "/artifacts/s1" }, ...(harForG1 ? [{ kind: "har", url: "/artifacts/h1" }] : [])],
    },
    {
      stage: "browser_validation",
      nodeName: "C1",
      nodeType: "gsa_client",
      ok: false,
      artifactRefs: [{ kind: "screenshot", url: "/artifacts/s2" }, { kind: "har", url: "/artifacts/h2" }],
    },
  ];
}

test("site packet: complete when every required artifact is present; persists the manifest", async () => {
  const store = createStateStore(memoryAdapter());
  await store.init();
  const sp = createSitePacket({ store });
  const url = { id: "u1", url: "https://blocked.example/path" };

  const out = await sp.generate("run-x", url, { selectedNodes: [], results: results(), comparison: { classification: "likely_gsa_impacting" } });
  assert.equal(out.complete, true);
  assert.deepEqual(out.missing, []);
  assert.equal(out.siteKey, "blocked.example_path");
  assert.equal(out.manifest.artifacts.length, 4, "artifacts collected from results");

  const persisted = await store.get("site_packets", "u1");
  assert.ok(persisted, "manifest persisted");
  assert.equal(persisted.evidence.complete, true);
  assert.equal(persisted.url.url, "https://blocked.example/path");
});

test("site packet: a failing browser validation missing its HAR is flagged incomplete (no false-complete)", async () => {
  const store = createStateStore(memoryAdapter());
  await store.init();
  const sp = createSitePacket({ store });

  const out = await sp.generate("run-x", { id: "u2", url: "https://x" }, { results: results({ harForG1: false }) });
  assert.equal(out.complete, false);
  assert.ok(out.missing.some((m) => m.nodeName === "G1" && m.kind === "har"), "G1 HAR flagged missing");
  assert.ok(!out.missing.some((m) => m.kind === "screenshot"), "screenshots were present");
});

test("siteKeyFor: sanitizes host + path", () => {
  assert.equal(siteKeyFor("https://Example.com/a/b?q=1"), "example.com_a_b");
  assert.equal(siteKeyFor("https://example.com/"), "example.com");
});
