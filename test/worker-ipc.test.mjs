// End-to-end worker-IPC test.
//
// Spawns the REAL worker Agent via the worker-manager and proves the local IPC loop:
//   supervisor writes a job to the worker's stdin → worker runs it → emits `ready` and
//   `result` on stdout → worker-manager surfaces readiness and forwards the result.
//
// Hermetic: the probe target is a throwaway local HTTP server; metadata network lookups
// are disabled via WEBINSPECTOR_SKIP_METADATA_LOOKUPS so the test is fast and offline-safe.

import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createWorkerManager } from "../control-plane-agent/worker-manager/lifecycle.mjs";
import { getPlatformProvider } from "../control-plane-agent/platform/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const agentDir = join(here, "..", "agent");

function waitFor(cond, { timeout = 15000, interval = 50 } = {}) {
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
        reject(new Error("timeout waiting for condition"));
      }
    }, interval);
  });
}

test("worker IPC: job in via stdin -> ready + result out via stdout", { timeout: 30000 }, async () => {
  // throwaway probe target
  const target = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const port = target.address().port;

  const results = [];
  const wm = createWorkerManager({
    platform: getPlatformProvider(),
    paths: { agentCurrent: agentDir },
    env: { ...process.env, WEBINSPECTOR_SKIP_METADATA_LOOKUPS: "1" },
    onResult: (msg) => results.push(msg),
  });

  try {
    await wm.start("test");

    // readiness signal arrives over stdout
    await waitFor(() => wm.isReady());
    assert.equal(wm.isReady(), true);

    // deliver a job over stdin
    const acc = await wm.runJob({ id: "job1", url: `http://127.0.0.1:${port}/health`, nodeName: "VM1", nodeType: "azure_direct", stage: "initial_test" });
    assert.equal(acc.accepted, true);

    // result comes back over stdout and is surfaced via onResult
    await waitFor(() => results.some((r) => r.jobId === "job1"));
    const r = results.find((x) => x.jobId === "job1");
    assert.ok(r.result, "result payload present");
    assert.equal(r.result.stage, "initial_test");
    assert.equal(r.result.ok, true, "probe of the local server should be ok");
  } finally {
    await wm.stop();
    await new Promise((r) => target.close(r));
  }
});
