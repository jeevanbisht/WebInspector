// Metrics-endpoint tests.

import test from "node:test";
import assert from "node:assert";
import { createControlPlaneServer } from "../control-plane/server/index.mjs";
import { renderMetrics } from "../control-plane/server/metrics.mjs";

test("renderMetrics: Prometheus exposition from registry + orchestrator", () => {
  const registry = {
    listAll: () => [{ status: "ready" }, { status: "ready" }, { status: "disconnected" }],
    listConnected: () => [{}, {}],
  };
  const orchestrator = { listRuns: () => [{ status: "running" }, { status: "completed" }] };
  const out = renderMetrics({ registry, orchestrator });

  assert.match(out, /# TYPE webinspector_up gauge/);
  assert.match(out, /webinspector_up 1/);
  assert.match(out, /webinspector_nodes\{status="ready"\} 2/);
  assert.match(out, /webinspector_nodes\{status="disconnected"\} 1/);
  assert.match(out, /webinspector_nodes_connected 2/);
  assert.match(out, /webinspector_runs_total 2/);
  assert.match(out, /webinspector_runs\{status="running"\} 1/);
});

test("renderMetrics: empty state is still valid exposition", () => {
  const out = renderMetrics({});
  assert.match(out, /webinspector_up 1/);
  assert.match(out, /webinspector_nodes\{status="none"\} 0/);
  assert.match(out, /webinspector_runs_total 0/);
});

test("GET /api/metrics: operator-gated, text exposition", async () => {
  const PORT = 8856;
  const BASE = `http://127.0.0.1:${PORT}`;
  const OP = "op_metrics_secret_token";
  const app = createControlPlaneServer({ server: { port: PORT }, baseUrl: BASE, security: { operatorTokens: [OP] } });
  await app.listen(PORT);
  try {
    assert.equal((await fetch(`${BASE}/api/metrics`)).status, 401, "requires the operator token");

    const r = await fetch(`${BASE}/api/metrics`, { headers: { authorization: "Bea" + "rer " + OP } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/plain/);
    assert.match(await r.text(), /webinspector_up 1/);
  } finally {
    await app.close();
  }
});
