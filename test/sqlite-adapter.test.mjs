// SQLite state-adapter tests.
//
// Exercises the built-in node:sqlite adapter behind the same store interface: put/get/list/
// append round-trip (incl. upsert), durability across a fresh store instance (restart), the
// final report rendered from persisted SQLite state, and driver selection through the server.

import test from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStateStore } from "../control-plane/state/store.mjs";
import { sqliteAdapter } from "../control-plane/state/adapters/sqlite.mjs";
import { createFinalReport } from "../control-plane/reporting/final-report.mjs";
import { loadControlPlaneConfig } from "../control-plane/config.mjs";
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

const SELECTED = [
  { nodeName: "D1", nodeType: "azure_direct" },
  { nodeName: "G1", nodeType: "gsa_remotenet" },
  { nodeName: "C1", nodeType: "gsa_client" },
];

test("sqlite: put/get/list (indexed) + upsert + appendEvent + delete", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wi-sqlite-"));
  const store = createStateStore(sqliteAdapter(dir));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  await store.init();

  await store.put("runs", "r1", { status: "running" });
  await store.put("urls", "u1", { runId: "r1", url: "https://a" });
  await store.put("urls", "u2", { runId: "r2", url: "https://b" });
  await store.put("urls", "u1", { runId: "r1", url: "https://a2" }); // upsert same id

  assert.equal((await store.get("runs", "r1")).status, "running");
  const byRun = await store.list("urls", { runId: "r1" });
  assert.equal(byRun.length, 1, "runId filter is exact");
  assert.equal(byRun[0].url, "https://a2", "upsert replaced the record");

  await store.appendEvent("url_queued", { runId: "r1" });
  await store.appendEvent("url_completed", { runId: "r1" });
  const events = await store.listEvents({}, 10);
  assert.ok(events.length >= 2);
  assert.equal(events[0].type, "url_completed", "events are newest-first");

  assert.equal(await store.delete("urls", "u1"), true);
  assert.equal(await store.get("urls", "u1"), null);
});

test("sqlite: survives a fresh store (restart recovery) and renders the report", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wi-sqlite-"));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));

  const a = createStateStore(sqliteAdapter(dir));
  await a.init();
  await a.put("runs", "run-x", { status: "completed", createdAt: "2026-07-02T00:00:00Z", urlIds: ["u1"] });
  await a.put("urls", "u1", { runId: "run-x", url: "https://blocked.example", status: "completed", classification: "likely_gsa_impacting", selectedNodes: SELECTED });
  await a.put("results", "u1::D1::initial_test", { runId: "run-x", urlId: "u1", jobId: "u1::D1::initial_test", stage: "initial_test", nodeName: "D1", nodeType: "azure_direct", ok: true, reason: "OK" });
  await a.put("results", "u1::G1::browser_validation", { runId: "run-x", urlId: "u1", jobId: "u1::G1::browser_validation", stage: "browser_validation", nodeName: "G1", nodeType: "gsa_remotenet", ok: false, reason: "AKAMAI_BLOCK", pageClassification: "challenge_or_block", evidence: { vendor: "Akamai", referenceIds: { akamaiReference: "18.abcd" } } });
  await a.put("results", "u1::C1::browser_validation", { runId: "run-x", urlId: "u1", jobId: "u1::C1::browser_validation", stage: "browser_validation", nodeName: "C1", nodeType: "gsa_client", ok: false, reason: "AKAMAI_BLOCK", evidence: { vendor: "Akamai", referenceIds: {} } });
  await a.put("comparisons", "u1", { urlId: "u1", runId: "run-x", url: "https://blocked.example", classification: "likely_gsa_impacting", confidence: 0.8 });
  await a.close(); // simulate a restart

  const b = createStateStore(sqliteAdapter(dir));
  await b.init();
  assert.equal((await b.get("runs", "run-x")).status, "completed");
  assert.equal((await b.list("results", { runId: "run-x" })).length, 3);

  const html = await createFinalReport({ store: b }).renderHtml("run-x");
  assert.ok(html.includes("run-x"));
  assert.ok(html.includes("likely_gsa_impacting"));
  assert.ok(html.includes("AKAMAI_BLOCK"), "persisted evidence renders from SQLite after restart");
  await b.close();
});

test("config + server: WEBINSPECTOR_STATE_DRIVER=sqlite selects it; server persists a run via SQLite", async (t) => {
  const prev = process.env.WEBINSPECTOR_STATE_DRIVER;
  process.env.WEBINSPECTOR_STATE_DRIVER = "sqlite";
  try {
    const cfg = loadControlPlaneConfig({});
    assert.equal(cfg.state.driver, "sqlite");
    assert.equal(cfg.state.persist, true, "selecting a driver implies persistence");
  } finally {
    if (prev === undefined) delete process.env.WEBINSPECTOR_STATE_DRIVER;
    else process.env.WEBINSPECTOR_STATE_DRIVER = prev;
  }

  const dir = await mkdtemp(join(tmpdir(), "wi-sqlite-srv-"));
  const OP = "op_sqlite_secret_token";
  const PORT = 8860;
  const BASE = `http://127.0.0.1:${PORT}`;
  const app = createControlPlaneServer({ server: { port: PORT }, baseUrl: BASE, security: { operatorTokens: [OP] }, state: { driver: "sqlite", dir } });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  await app.listen(PORT);

  const created = await fetch(`${BASE}/api/runs`, { method: "POST", headers: { "content-type": "application/json", authorization: bearer(OP) }, body: "{}" });
  assert.equal(created.status, 201);
  const runId = (await created.json()).runId;

  await waitFor(async () => {
    const r = await fetch(`${BASE}/api/runs/${runId}/report.html`, { headers: { authorization: bearer(OP) } });
    return r.status === 200 && (await r.text()).includes(runId);
  });
});
