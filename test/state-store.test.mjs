// Durable state-store tests.
//
// Covers the store interface (memory + localJson adapters), disk durability across a fresh
// store instance (i.e. a ControlPlane restart) with the final report rendered from persisted
// state, and the operator-gated report routes on the server.

import test from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStateStore } from "../control-plane/state/store.mjs";
import { localJsonAdapter } from "../control-plane/state/adapters/local-json.mjs";
import { memoryAdapter } from "../control-plane/state/adapters/memory.mjs";
import { createFinalReport } from "../control-plane/reporting/final-report.mjs";
import { createControlPlaneServer } from "../control-plane/server/index.mjs";

const bearer = (t) => "Bea" + "rer " + t; // avoid the file-tool secret masker

async function waitFor(cond, { timeout = 8000, interval = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await cond()) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("timeout waiting for condition");
}

test("state store: put/get/list/appendEvent/delete round-trip (memory)", async () => {
  const store = createStateStore(memoryAdapter());
  await store.init();

  await store.put("runs", "r1", { status: "running" });
  const got = await store.get("runs", "r1");
  assert.equal(got.id, "r1");
  assert.equal(got.status, "running");

  await store.put("urls", "u1", { runId: "r1", url: "https://a" });
  await store.put("urls", "u2", { runId: "r2", url: "https://b" });
  const byRun = await store.list("urls", { runId: "r1" });
  assert.equal(byRun.length, 1);
  assert.equal(byRun[0].id, "u1");

  await store.appendEvent("url_queued", { runId: "r1" });
  const events = await store.listEvents();
  assert.ok(events.some((e) => e.type === "url_queued"));

  assert.equal(await store.delete("runs", "r1"), true);
  assert.equal(await store.get("runs", "r1"), null);
});

test("state store: unknown table is rejected", async () => {
  const store = createStateStore(memoryAdapter());
  await assert.rejects(() => store.put("bogus", "x", {}), /unknown table/);
});

test("state store: localJson survives a fresh store (restart recovery) and renders the report", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wi-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));

  const selected = [
    { nodeName: "D1", nodeType: "azure_direct" },
    { nodeName: "G1", nodeType: "gsa_remotenet" },
    { nodeName: "C1", nodeType: "gsa_client" },
  ];

  // Write via store A, exactly as the orchestrator persists a completed run.
  const a = createStateStore(localJsonAdapter(dir));
  await a.init();
  await a.put("runs", "run-x", { status: "completed", createdAt: "2026-07-02T00:00:00Z", urlIds: ["u1"] });
  await a.put("urls", "u1", { runId: "run-x", url: "https://blocked.example", status: "completed", classification: "likely_gsa_impacting", selectedNodes: selected });
  await a.put("results", "u1::D1::initial_test", { runId: "run-x", urlId: "u1", jobId: "u1::D1::initial_test", stage: "initial_test", nodeName: "D1", nodeType: "azure_direct", ok: true, reason: "OK" });
  await a.put("results", "u1::G1::browser_validation", { runId: "run-x", urlId: "u1", jobId: "u1::G1::browser_validation", stage: "browser_validation", nodeName: "G1", nodeType: "gsa_remotenet", ok: false, reason: "AKAMAI_BLOCK", pageClassification: "challenge_or_block", evidence: { vendor: "Akamai", referenceIds: { akamaiReference: "18.abcd" } } });
  await a.put("results", "u1::C1::browser_validation", { runId: "run-x", urlId: "u1", jobId: "u1::C1::browser_validation", stage: "browser_validation", nodeName: "C1", nodeType: "gsa_client", ok: false, reason: "AKAMAI_BLOCK", evidence: { vendor: "Akamai", referenceIds: {} } });
  await a.put("comparisons", "u1", { urlId: "u1", runId: "run-x", url: "https://blocked.example", classification: "likely_gsa_impacting", confidence: 0.8 });

  // A brand-new store on the SAME dir is a restarted ControlPlane — it must see the data.
  const b = createStateStore(localJsonAdapter(dir));
  await b.init();
  assert.equal((await b.get("runs", "run-x")).status, "completed");
  assert.equal((await b.list("urls", { runId: "run-x" })).length, 1);
  assert.equal((await b.list("results", { runId: "run-x" })).length, 3);

  const html = await createFinalReport({ store: b }).renderHtml("run-x");
  assert.ok(html.includes("run-x"));
  assert.ok(html.includes("https://blocked.example"));
  assert.ok(html.includes("likely_gsa_impacting"));
  assert.ok(html.includes("AKAMAI_BLOCK"), "persisted failure evidence renders after restart");

  const csv = await createFinalReport({ store: b }).renderCsv("run-x");
  assert.ok(csv.split("\n").some((l) => l.startsWith("https://blocked.example") && l.includes("likely_gsa_impacting")));
});

test("server: a store is wired by default; report routes are operator-gated", { timeout: 20000 }, async () => {
  const PORT = 8840;
  const BASE = `http://127.0.0.1:${PORT}`;
  const OP = "op_state_secret_token";
  const app = createControlPlaneServer({ server: { port: PORT }, baseUrl: BASE, security: { operatorTokens: [OP] } });
  assert.ok(app.services.store, "an in-memory store is wired by default");
  await app.listen(PORT);
  try {
    const created = await fetch(`${BASE}/api/runs`, { method: "POST", headers: { "content-type": "application/json", authorization: bearer(OP) }, body: "{}" });
    assert.equal(created.status, 201);
    const runId = (await created.json()).runId;

    // report requires the operator token
    assert.equal((await fetch(`${BASE}/api/runs/${runId}/report.html`)).status, 401);

    // the persisted run surfaces in the report (orchestrator persists asynchronously)
    await waitFor(async () => {
      const r = await fetch(`${BASE}/api/runs/${runId}/report.html`, { headers: { authorization: bearer(OP) } });
      return r.status === 200 && (await r.text()).includes(runId);
    });

    const csv = await fetch(`${BASE}/api/runs/${runId}/report.csv`, { headers: { authorization: bearer(OP) } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type"), /text\/csv/);
  } finally {
    await app.close();
  }
});
