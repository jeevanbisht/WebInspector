// Worker Agent entrypoint.
//
// Long-lived process managed by the supervisor (ControlPlane Agent). It receives jobs from
// the supervisor over local IPC, runs them via the job-runner, and returns results. It does
// NOT hold the control channel — that belongs to the supervisor — so it can be updated or
// restarted freely.
//
// IPC (TODO): read job requests as NDJSON on stdin; write result summaries as NDJSON on
// stdout for the supervisor to forward up the control channel. Bulk bodies/artifacts go
// straight to the ControlPlane data plane.

import { createInterface } from "node:readline";
import { runJob } from "./job-runner.mjs";

export async function main() {
  // Readiness signal the supervisor's health gate can watch for.
  process.stdout.write(JSON.stringify({ type: "ready", ts: new Date().toISOString() }) + "\n");

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let job;
    try {
      job = JSON.parse(trimmed);
    } catch {
      continue; // ignore malformed lines
    }
    try {
      const result = await runJob(job, { controlPlaneUrl: process.env.WEBINSPECTOR_CONTROLPLANE_URL, authHeader: process.env.WEBINSPECTOR_NODE_AUTH });
      emit({ type: "result", jobId: job.id, result });
    } catch (e) {
      emit({ type: "result", jobId: job.id, error: e.message });
    }
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (process.argv[1]?.endsWith("core/index.mjs") || process.argv[1]?.endsWith("index.mjs")) {
  main().catch((e) => {
    console.error(`[worker] fatal: ${e.message}`);
    process.exit(1);
  });
}
