// Run orchestrator (ControlPlane side).
//
// Ties the whole per-URL flow together:
//   queue URL -> select nodes -> dispatch initial_test jobs -> collect results
//   -> (if any not-OK) dispatch browser_validation to all selected nodes -> collect
//   -> compare arms -> classify -> generate packet -> mark URL completed
//
// Results arrive asynchronously from agents via the control channel (`result` messages),
// which call onResult(); the orchestrator advances each URL's state machine as they land.
// Self-contained in memory (works without a store); persists best-effort when a store is set.

import { classify, armStatus } from "../comparison/classify.mjs";
import { normalizeUrl } from "../../shared/contracts/nodes.mjs";

const ARM_BY_TYPE = Object.freeze({
  azure_direct: "azureDirect",
  gsa_remotenet: "gsaRemotenet",
  gsa_client: "gsaClient",
  cloudflare_client: "cloudflareClient",
  external_direct: "externalDirect",
});

export function createRunOrchestrator({ store = null, registry, dispatcher, selection, sitePacket = null, onEvent = null, logger = console } = {}) {
  const runs = new Map(); // runId -> run
  const urls = new Map(); // urlId -> url record
  const jobs = new Map(); // jobId -> job
  const resultsByUrl = new Map(); // urlId -> Map(`${nodeName}:${stage}` -> result)
  const comparisons = new Map(); // urlId -> comparison

  const persist = (table, id, rec) => {
    const pr = store?.put?.(table, id, rec);
    pr?.catch?.(() => {});
  };
  const emit = (type, fields = {}) => {
    onEvent?.({ type, ...fields, ts: new Date().toISOString() });
    const pr = store?.appendEvent?.(type, fields);
    pr?.catch?.(() => {});
  };

  function createRun({ urls: urlList = [] } = {}) {
    const runId = `run-${Date.now()}-${rand()}`;
    const run = { id: runId, status: "running", createdAt: new Date().toISOString(), urlIds: [] };
    runs.set(runId, run);
    persist("runs", runId, run);
    emit("run_created", { runId });
    for (const u of urlList) queueUrl(runId, u);
    return run;
  }

  function queueUrl(runId, rawUrl) {
    const run = runs.get(runId);
    if (!run) throw httpErr(404, `unknown run: ${runId}`);
    const url = normalizeUrl(rawUrl);
    const urlId = `url-${Date.now()}-${rand()}`;
    const sel = selection.selectForUrl();
    const record = {
      id: urlId,
      runId,
      url,
      status: sel.canDispatch ? "initial_tests_running" : "blocked",
      selectedNodes: sel.selected,
      unmet: sel.unmet,
      classification: sel.canDispatch ? "pending" : "inconclusive",
      createdAt: new Date().toISOString(),
    };
    urls.set(urlId, record);
    run.urlIds.push(urlId);
    resultsByUrl.set(urlId, new Map());
    persist("urls", urlId, record);
    emit("url_queued", { runId, urlId, url });
    if (sel.canDispatch) dispatchStage(record, "initial_test");
    else emit("url_blocked", { runId, urlId, data: { unmet: sel.unmet } });
    return record;
  }

  function dispatchStage(url, stage) {
    for (const node of url.selectedNodes) {
      const jobId = `${url.id}::${node.nodeName}::${stage}`;
      const job = { id: jobId, runId: url.runId, urlId: url.id, url: url.url, nodeName: node.nodeName, nodeType: node.nodeType, stage, status: "dispatched" };
      jobs.set(jobId, job);
      persist("jobs", jobId, job);
      Promise.resolve()
        .then(() => dispatcher.sendCommand(node.nodeName, "dispatch_job", { job }))
        .then(() => emit("job_dispatched", { runId: url.runId, urlId: url.id, jobId, nodeName: node.nodeName, data: { stage } }))
        .catch(() => recordResult(node.nodeName, { jobId, stage, nodeName: node.nodeName, ok: false, reason: "DISPATCH_FAILED" }));
    }
  }

  function onResult(nodeName, summary) {
    if (summary?.jobId) recordResult(nodeName, summary);
  }

  function recordResult(_nodeName, summary) {
    const job = jobs.get(summary.jobId) || parseJobId(summary.jobId);
    if (!job) return;
    const url = urls.get(job.urlId);
    if (!url) return;
    const bucket = resultsByUrl.get(url.id);
    const nodeType = job.nodeType || url.selectedNodes.find((n) => n.nodeName === job.nodeName)?.nodeType || null;
    const rec = { ...summary, nodeName: job.nodeName, nodeType, stage: job.stage };
    bucket.set(`${job.nodeName}:${job.stage}`, rec);
    persist("results", summary.jobId, rec);
    emit("result_recorded", { runId: url.runId, urlId: url.id, jobId: summary.jobId, data: { stage: job.stage, ok: summary.ok } });
    advance(url);
  }

  function advance(url) {
    if (url.status === "completed" || url.status === "failed") return;
    const bucket = resultsByUrl.get(url.id);
    const stageDone = (stage) => url.selectedNodes.every((n) => bucket.has(`${n.nodeName}:${stage}`));

    if (!stageDone("initial_test")) return;

    const anyNotOk = url.selectedNodes.some((n) => bucket.get(`${n.nodeName}:initial_test`)?.ok === false);
    if (anyNotOk && url.status === "initial_tests_running") {
      url.status = "browser_validation_running";
      persist("urls", url.id, url);
      emit("browser_validation_required", { runId: url.runId, urlId: url.id });
      dispatchStage(url, "browser_validation");
      return;
    }
    if (url.status === "browser_validation_running" && !stageDone("browser_validation")) return;

    finalize(url);
  }

  function finalize(url) {
    const bucket = resultsByUrl.get(url.id);
    const effective = (n) => bucket.get(`${n.nodeName}:browser_validation`) || bucket.get(`${n.nodeName}:initial_test`);

    const byType = {};
    for (const n of url.selectedNodes) (byType[n.nodeType] ||= []).push(effective(n) || {});

    const arms = {};
    for (const [type, arm] of Object.entries(ARM_BY_TYPE)) arms[arm] = byType[type] ? armStatus(byType[type]) : "unavailable";

    const c = classify(arms);
    const comparison = { urlId: url.id, runId: url.runId, url: url.url, classification: c.classification, confidence: c.confidence, arms: c.arms, createdAt: new Date().toISOString() };
    comparisons.set(url.id, comparison);
    persist("comparisons", url.id, comparison);
    emit("comparison_completed", { runId: url.runId, urlId: url.id, data: { classification: c.classification } });

    if (sitePacket) {
      Promise.resolve()
        .then(() => sitePacket.generate(url.runId, url, { selectedNodes: url.selectedNodes, jobs: [...jobs.values()].filter((j) => j.urlId === url.id), results: [...bucket.values()], comparison }))
        .catch((e) => logger.warn?.(`[orchestrator] packet gen failed: ${e.message}`));
    }

    url.status = "completed";
    url.classification = c.classification;
    persist("urls", url.id, url);
    emit("url_completed", { runId: url.runId, urlId: url.id, data: { classification: c.classification } });
  }

  function getRun(runId) {
    const run = runs.get(runId);
    if (!run) return null;
    return { run, urls: run.urlIds.map((id) => ({ ...urls.get(id), comparison: comparisons.get(id) || null })) };
  }

  return {
    createRun,
    queueUrl,
    onResult,
    getRun,
    listRuns: () => [...runs.values()],
  };
}

function parseJobId(jobId) {
  const [urlId, nodeName, stage] = String(jobId).split("::");
  return urlId && nodeName && stage ? { id: jobId, urlId, nodeName, stage } : null;
}
function rand() {
  return Math.random().toString(16).slice(2, 8);
}
function httpErr(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}
