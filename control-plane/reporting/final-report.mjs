// Final report generation (ControlPlane side).
//
// Produces final.html / final.csv for a run: summary, selected-node inventory (with public
// IPs + versions), per-URL results across Azure Direct / GSA_RNet / GSA_CLIENT / CloudFlare
// / External columns, classification, failure evidence (specific reason, vendor, reference
// IDs, redirect chain, HAR link), screenshot evidence, and recovery/update history.
//
// Stub: assembles the model from state and renders. HTML/CSV rendering is TODO (port the
// existing renderer).

export function createFinalReport({ store } = {}) {
  return {
    async model(runId) {
      const run = await store?.get("runs", runId);
      const urls = (await store?.list("urls", { runId })) || [];
      const results = (await store?.list("results", { runId })) || [];
      const comparisons = (await store?.list("comparisons", {})) || [];
      const nodes = (await store?.list("nodes", {})) || [];
      const updateEvents = (await store?.list("node_update_events", { runId })) || [];
      return { run, nodes, urls, results, comparisons, updateEvents };
    },

    async renderHtml(runId) {
      const model = await this.model(runId);
      // TODO: port the existing HTML renderer (arm columns, failure evidence, screenshots, HAR).
      return `<!doctype html><meta charset="utf-8"><title>WebInspector run ${runId}</title>` +
        `<h1>Run ${runId}</h1><pre>${escapeHtml(JSON.stringify(model, null, 2))}</pre>`;
    },

    async renderCsv(runId) {
      const { urls, comparisons } = await this.model(runId);
      const byUrl = new Map(comparisons.map((c) => [c.urlId, c]));
      const rows = [["url", "classification", "confidence"]];
      for (const u of urls) {
        const c = byUrl.get(u.id);
        rows.push([u.url, c?.classification || "pending", c?.confidence ?? ""]);
      }
      return rows.map((r) => r.map(csvCell).join(",")).join("\n");
    },
  };
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
