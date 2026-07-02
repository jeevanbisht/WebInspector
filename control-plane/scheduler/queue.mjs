// URL queue + job creation (ControlPlane side).
//
// Turns a queued URL into per-selected-node jobs that the dispatcher pushes as
// `dispatch_job` commands. Kept separate from selection + lifecycle for clarity.

import { normalizeUrl } from "../../shared/contracts/nodes.mjs";

export function createQueue({ store, selection, dispatcher } = {}) {
  return {
    /** Queue a URL for a run; returns the created url record. */
    async queueUrl(runId, rawUrl, opts = {}) {
      const url = normalizeUrl(rawUrl);
      const urlId = `url-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const record = { id: urlId, runId, url, status: "queued", queuedAt: new Date().toISOString(), ...opts };
      await store?.put("urls", urlId, record);
      await store?.appendEvent("url_queued", { runId, urlId, message: url });
      return record;
    },

    /** Create jobs for the selected nodes and dispatch them. */
    async dispatchInitialTests(runId, urlRecord, selectedNodes = []) {
      const jobs = [];
      for (const node of selectedNodes) {
        const jobId = `job-${urlRecord.id}-${node.nodeName}`;
        const job = { id: jobId, runId, urlId: urlRecord.id, url: urlRecord.url, nodeName: node.nodeName, nodeType: node.nodeType, stage: "initial_test", status: "pending", createdAt: new Date().toISOString() };
        await store?.put("jobs", jobId, job);
        await dispatcher?.sendCommand(node.nodeName, "dispatch_job", { job });
        await store?.appendEvent("job_dispatched", { runId, urlId: urlRecord.id, jobId, nodeName: node.nodeName });
        jobs.push(job);
      }
      return jobs;
    },
  };
}
