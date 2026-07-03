// Supervisor node-info + run-completion for the "blocked" (no-eligible-nodes) case.

import test from "node:test";
import assert from "node:assert/strict";
import { privateIpv4, collectNodeInfo } from "../control-plane-agent/core/node-info.mjs";
import { createRunOrchestrator } from "../control-plane/scheduler/run-orchestrator.mjs";

test("node-info: reports a private IPv4 and skips the public lookup when disabled", async () => {
  const ip = privateIpv4();
  // A test host may occasionally have only loopback; accept null but require IPv4 shape otherwise.
  if (ip !== null) assert.match(ip, /^\d{1,3}(\.\d{1,3}){3}$/);

  // With lookups disabled, collectNodeInfo makes NO network call and returns publicIp:null.
  const info = await collectNodeInfo({ WEBINSPECTOR_SKIP_METADATA_LOOKUPS: "1" });
  assert.equal(info.publicIp, null);
  assert.equal(info.privateIp, ip);
});

test("run-completion: a run whose only URL is blocked still completes", () => {
  // Selection with no eligible nodes → the URL is blocked (never dispatched).
  const selection = { selectForUrl: () => ({ selected: [], unmet: [{ nodeType: "azure_direct", need: 1, have: 0 }], canDispatch: false }) };
  const orchestrator = createRunOrchestrator({ registry: {}, dispatcher: {}, selection });

  const run = orchestrator.createRun({ urls: ["https://blocked.example"] });
  const detail = orchestrator.getRun(run.id);
  assert.equal(detail.urls[0].status, "blocked");
  // The run must not hang in "running" — a fully-blocked run is terminal.
  assert.equal(detail.run.status, "completed");
});

test("run-completion: run stays running until a dispatched URL settles", () => {
  const selection = { selectForUrl: () => ({ selected: [{ nodeName: "d1", nodeType: "azure_direct" }], unmet: [], canDispatch: true }) };
  const dispatcher = { sendCommand: () => {} }; // dispatch is fire-and-forget here
  const orchestrator = createRunOrchestrator({ registry: {}, dispatcher, selection });

  const run = orchestrator.createRun({ urls: ["https://example.com"] });
  // Dispatched but no results yet → still running.
  assert.equal(orchestrator.getRun(run.id).run.status, "running");

  // Feed a passing initial_test result (jobId is `${urlId}::${nodeName}::${stage}`).
  const urlId = orchestrator.getRun(run.id).urls[0].id;
  orchestrator.onResult("d1", { jobId: `${urlId}::d1::initial_test`, stage: "initial_test", nodeName: "d1", ok: true, reason: "OK" });
  assert.equal(orchestrator.getRun(run.id).urls[0].status, "completed");
  assert.equal(orchestrator.getRun(run.id).run.status, "completed");
});
