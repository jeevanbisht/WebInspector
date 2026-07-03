// End-to-end run-pipeline test.
//
// Fake agents (the three required arms) connect over the real control channel; each replies
// to dispatch_job with a result. A URL is queued and must flow all the way through:
//   select nodes -> dispatch -> collect results -> (browser validation if needed) ->
//   compare arms -> classify -> complete.

import test from "node:test";
import assert from "node:assert";
import { createControlPlaneServer } from "../control-plane/server/index.mjs";
import { createConnection } from "../control-plane-agent/core/connection.mjs";
import { buildHello } from "../control-plane-agent/core/register.mjs";
import { makeCommandResult } from "../shared/contracts/commands.mjs";

function waitFor(cond, { timeout = 8000, interval = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      let ok = false;
      try {
        ok = cond();
      } catch {
        ok = false;
      }
      if (ok) {
        clearInterval(t);
        resolve(true);
      } else if (Date.now() - start > timeout) {
        clearInterval(t);
        reject(new Error("timeout"));
      }
    }, interval);
  });
}

// A fake agent that replies to every dispatch_job with a fixed ok/not-ok result.
function fakeAgent(base, enrollment, nodeName, nodeType, ok) {
  const { token } = enrollment.issueToken({ nodeType });
  const enr = enrollment.enroll({ enrollmentToken: token, identity: { nodeName, nodeType } });
  const conn = createConnection({
    controlPlaneUrl: base,
    nodeId: enr.nodeId,
    nodeCredential: enr.nodeCredential,
    onOpen: () => conn.sendUp("hello", buildHello({ identity: { nodeName, nodeType, platform: "test", os: "test" } })),
    onMessage: (msg) => {
      if (msg.type !== "command") return;
      const cmd = msg.payload;
      conn.sendUp("command_result", makeCommandResult(cmd.commandId, "succeeded"), { correlationId: cmd.commandId });
      if (cmd.command === "dispatch_job") {
        const job = cmd.args.job;
        conn.sendUp("result", { jobId: job.id, stage: job.stage, nodeName, url: job.url, ok, reason: ok ? "OK" : "WAF_BLOCK" });
      }
    },
  });
  conn.start();
  return conn;
}

test("run pipeline: all arms healthy -> completed healthy", { timeout: 20000 }, async () => {
  const PORT = 8801;
  const BASE = `http://127.0.0.1:${PORT}`;
  const app = createControlPlaneServer({ server: { port: PORT }, baseUrl: BASE });
  await app.listen(PORT);
  const { enrollment, orchestrator, registry } = app.services;
  const conns = [
    fakeAgent(BASE, enrollment, "D1", "azure_direct", true),
    fakeAgent(BASE, enrollment, "G1", "gsa_remotenet", true),
    fakeAgent(BASE, enrollment, "C1", "gsa_client", true),
  ];
  try {
    await waitFor(() => registry.listConnected().filter((n) => n.status === "ready").length === 3);
    const run = orchestrator.createRun({});
    const rec = orchestrator.queueUrl(run.id, "https://example.com");
    assert.equal(rec.status, "initial_tests_running", "URL dispatches once quorum is met");

    await waitFor(() => orchestrator.getRun(run.id).urls[0].status === "completed");
    assert.equal(orchestrator.getRun(run.id).urls[0].classification, "healthy");
    // The parent run must flip running → completed once its only URL settles.
    await waitFor(() => orchestrator.getRun(run.id).run.status === "completed");
  } finally {
    conns.forEach((c) => c.close());
    await app.close();
  }
});

test("run pipeline: gsa fails -> browser validation -> likely_gsa_impacting", { timeout: 20000 }, async () => {
  const PORT = 8802;
  const BASE = `http://127.0.0.1:${PORT}`;
  const app = createControlPlaneServer({ server: { port: PORT }, baseUrl: BASE });
  await app.listen(PORT);
  const { enrollment, orchestrator, registry } = app.services;
  const conns = [
    fakeAgent(BASE, enrollment, "D1", "azure_direct", true),
    fakeAgent(BASE, enrollment, "G1", "gsa_remotenet", false),
    fakeAgent(BASE, enrollment, "C1", "gsa_client", false),
  ];
  try {
    await waitFor(() => registry.listConnected().filter((n) => n.status === "ready").length === 3);
    const run = orchestrator.createRun({ urls: ["https://blocked.example"] });

    await waitFor(() => orchestrator.getRun(run.id).urls[0].status === "completed");
    assert.equal(orchestrator.getRun(run.id).urls[0].classification, "likely_gsa_impacting");
    await waitFor(() => orchestrator.getRun(run.id).run.status === "completed");
  } finally {
    conns.forEach((c) => c.close());
    await app.close();
  }
});
