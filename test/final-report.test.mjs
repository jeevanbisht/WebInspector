// Final-report renderer tests (hermetic — no browser, no network).
//
// Exercises the pure HTML/CSV renderers against a representative run model (one healthy URL,
// one GSA-impacting URL with Akamai block evidence + screenshot/HAR artifacts), and the
// store-backed createFinalReport wrapper end to end.

import test from "node:test";
import assert from "node:assert";
import {
  createFinalReport,
  renderHtmlFromModel,
  renderCsvFromModel,
  ARM_COLUMNS,
} from "../control-plane/reporting/final-report.mjs";

function sampleModel() {
  const selected = [
    { nodeName: "D1", nodeType: "azure_direct" },
    { nodeName: "G1", nodeType: "gsa_remotenet" },
    { nodeName: "C1", nodeType: "gsa_client" },
  ];
  return {
    run: { id: "run-1", status: "completed", createdAt: "2026-07-02T00:00:00.000Z", urlIds: ["u1", "u2"] },
    nodes: [
      { nodeName: "D1", nodeType: "azure_direct", status: "ready", versions: { agentVersion: "3.0.0" }, metadata: { publicIp: "20.0.0.1" } },
      { nodeName: "G1", nodeType: "gsa_remotenet", status: "ready", versions: { agentVersion: "3.0.0" }, metadata: { publicIp: "20.0.0.2" } },
      { nodeName: "C1", nodeType: "gsa_client", status: "ready", versions: {}, metadata: {} },
    ],
    urls: [
      { id: "u1", runId: "run-1", url: "https://healthy.example", status: "completed", classification: "healthy", selectedNodes: selected },
      { id: "u2", runId: "run-1", url: "https://blocked.example", status: "completed", classification: "likely_gsa_impacting", selectedNodes: selected },
    ],
    results: [
      { jobId: "u1::D1::initial_test", stage: "initial_test", nodeName: "D1", nodeType: "azure_direct", ok: true, reason: "OK" },
      { jobId: "u1::G1::initial_test", stage: "initial_test", nodeName: "G1", nodeType: "gsa_remotenet", ok: true, reason: "OK" },
      { jobId: "u1::C1::initial_test", stage: "initial_test", nodeName: "C1", nodeType: "gsa_client", ok: true, reason: "OK" },
      { jobId: "u2::D1::initial_test", stage: "initial_test", nodeName: "D1", nodeType: "azure_direct", ok: true, reason: "OK" },
      { jobId: "u2::G1::initial_test", stage: "initial_test", nodeName: "G1", nodeType: "gsa_remotenet", ok: false, reason: "HTTP_403" },
      { jobId: "u2::C1::initial_test", stage: "initial_test", nodeName: "C1", nodeType: "gsa_client", ok: false, reason: "HTTP_403" },
      {
        jobId: "u2::G1::browser_validation",
        stage: "browser_validation",
        nodeName: "G1",
        nodeType: "gsa_remotenet",
        ok: false,
        reason: "AKAMAI_BLOCK",
        pageClassification: "challenge_or_block",
        evidence: { vendor: "Akamai", referenceIds: { akamaiReference: "18.abcd" }, redirectChain: [{ from: "a", to: "b", status: 302 }], finalUrl: "https://blocked.example" },
        artifactRefs: [
          { kind: "screenshot", url: "/artifacts/aaa", sha256: "aaa", sizeBytes: 100 },
          { kind: "har", url: "/artifacts/bbb", sha256: "bbb", sizeBytes: 200 },
        ],
      },
      {
        jobId: "u2::C1::browser_validation",
        stage: "browser_validation",
        nodeName: "C1",
        nodeType: "gsa_client",
        ok: false,
        reason: "AKAMAI_BLOCK",
        pageClassification: "challenge_or_block",
        evidence: { vendor: "Akamai", referenceIds: { akamaiReference: "18.efgh" }, redirectChain: [], finalUrl: "https://blocked.example" },
        artifactRefs: [],
      },
    ],
    comparisons: [
      { urlId: "u1", runId: "run-1", url: "https://healthy.example", classification: "healthy", confidence: 0.9, arms: { azure: "ok", gsa: "ok", cf: "unavailable", ext: "unavailable" } },
      { urlId: "u2", runId: "run-1", url: "https://blocked.example", classification: "likely_gsa_impacting", confidence: 0.8, arms: { azure: "ok", gsa: "fail", cf: "unavailable", ext: "unavailable" } },
    ],
    updateEvents: [],
  };
}

test("renderHtmlFromModel: arm columns, classification, evidence, artifacts, inventory", () => {
  const html = renderHtmlFromModel(sampleModel());

  assert.ok(html.startsWith("<!doctype html>"), "valid html doctype");
  assert.ok(html.includes("run-1"), "run id present");
  for (const col of ARM_COLUMNS) assert.ok(html.includes(col.label), `arm column ${col.label} present`);

  // both URLs and their classifications
  assert.ok(html.includes("https://healthy.example"));
  assert.ok(html.includes("https://blocked.example"));
  assert.ok(html.includes("healthy"));
  assert.ok(html.includes("likely_gsa_impacting"));

  // failing-arm evidence
  assert.ok(html.includes("AKAMAI_BLOCK"), "specific reason surfaced");
  assert.ok(html.includes("Akamai"), "vendor surfaced");
  assert.ok(html.includes("akamaiReference=18.abcd"), "reference id surfaced");
  assert.ok(html.includes("challenge_or_block"), "page classification surfaced");

  // artifact links
  assert.ok(html.includes('href="/artifacts/aaa"'), "screenshot link");
  assert.ok(html.includes('href="/artifacts/bbb"'), "har link");

  // node inventory
  assert.ok(html.includes("D1") && html.includes("20.0.0.1"), "node inventory with public IP");
});

test("renderHtmlFromModel: escapes HTML in URLs (no injection)", () => {
  const model = {
    run: { id: "r" },
    urls: [{ id: "x", url: "https://evil.example/<script>", selectedNodes: [], classification: "pending" }],
    results: [],
    comparisons: [],
    nodes: [],
  };
  const html = renderHtmlFromModel(model);
  assert.ok(!html.includes("<script>"), "raw script tag must be escaped");
  assert.ok(html.includes("&lt;script&gt;"), "escaped form present");
});

test("renderCsvFromModel: header + per-URL arm statuses + primary reason", () => {
  const csv = renderCsvFromModel(sampleModel());
  const lines = csv.split("\n");
  assert.equal(lines[0], "url,classification,confidence,azure_direct,gsa_remotenet,gsa_client,cloudflare_client,external_direct,primary_reason");

  const blocked = lines.find((l) => l.startsWith("https://blocked.example"));
  assert.ok(blocked, "row for blocked URL");
  const cols = blocked.split(",");
  // url, classification, confidence, azure, gsaRnet, gsaClient, cf, ext, primary_reason
  assert.equal(cols[1], "likely_gsa_impacting");
  assert.equal(cols[3], "ok", "azure_direct ok");
  assert.equal(cols[4], "fail", "gsa_remotenet fail");
  assert.equal(cols[5], "fail", "gsa_client fail");
  assert.equal(cols[6], "unavailable", "cloudflare unavailable");
  assert.equal(cols[8], "AKAMAI_BLOCK", "primary reason");

  const healthy = lines.find((l) => l.startsWith("https://healthy.example"));
  assert.ok(healthy.includes("healthy"));
});

test("createFinalReport: store-backed render round-trip", async () => {
  const model = sampleModel();
  const store = {
    async get(table, id) {
      return table === "runs" ? model.run : null;
    },
    async list(table) {
      return { urls: model.urls, results: model.results, comparisons: model.comparisons, nodes: model.nodes, node_update_events: [] }[table] || [];
    },
  };
  const report = createFinalReport({ store });
  const html = await report.renderHtml("run-1");
  const csv = await report.renderCsv("run-1");
  assert.ok(html.includes("run-1") && html.includes("Azure Direct"));
  assert.ok(csv.split("\n").length === 3, "header + 2 URL rows");
});
