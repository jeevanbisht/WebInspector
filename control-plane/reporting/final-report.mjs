// Final report generation (ControlPlane side).
//
// Produces final.html / final.csv for a run: summary, selected-node inventory (public IPs +
// versions), and a per-URL matrix across the five network arms (Azure Direct / GSA_RNet /
// GSA_CLIENT / CloudFlare / External) with classification + confidence, plus a failure
// evidence section (specific reason, page classification, edge/WAF vendor, reference IDs,
// redirect depth, and screenshot/HAR artifact links).
//
// The renderers are pure functions of the assembled model (renderHtmlFromModel /
// renderCsvFromModel), so they can be unit-tested without a store.

import { armStatus } from "../comparison/classify.mjs";

// Report arm columns (the two GSA arms stay SEPARATE here as evidence, unlike the combined
// GSA group used for the classification decision).
export const ARM_COLUMNS = Object.freeze([
  { type: "azure_direct", key: "azureDirect", label: "Azure Direct" },
  { type: "gsa_remotenet", key: "gsaRemotenet", label: "GSA_RNet" },
  { type: "gsa_client", key: "gsaClient", label: "GSA_CLIENT" },
  { type: "cloudflare_client", key: "cloudflareClient", label: "CloudFlare" },
  { type: "external_direct", key: "externalDirect", label: "External" },
]);

export function createFinalReport({ store } = {}) {
  return {
    async model(runId) {
      const run = await store?.get("runs", runId);
      const urls = (await store?.list("urls", { runId })) || [];
      const results = (await store?.list("results", { runId })) || [];
      const comparisons = (await store?.list("comparisons", {})) || [];
      const nodes = (await store?.list("nodes", {})) || [];
      const updateEvents = (await store?.list("node_update_events", { runId })) || [];
      return { run: run || { id: runId }, nodes, urls, results, comparisons, updateEvents };
    },

    async renderHtml(runId) {
      return renderHtmlFromModel(await this.model(runId));
    },

    async renderCsv(runId) {
      return renderCsvFromModel(await this.model(runId));
    },
  };
}

// --- pure renderers ---

export function renderHtmlFromModel(model = {}) {
  const runId = model.run?.id || "(unknown run)";
  const views = buildUrlViews(model);
  const inventory = buildNodeInventory(model, views);

  return [
    `<!doctype html><html><head><meta charset="utf-8">`,
    `<title>WebInspector run ${escapeHtml(runId)}</title><style>${STYLE}</style></head><body>`,
    `<h1>WebInspector — run ${escapeHtml(runId)}</h1>`,
    `<p class="meta">status: ${escapeHtml(model.run?.status || "?")} · created: ${escapeHtml(model.run?.createdAt || "?")} · generated: ${escapeHtml(new Date().toISOString())} · URLs: ${views.length}</p>`,
    renderSummary(views),
    renderInventory(inventory),
    renderMatrix(views),
    renderEvidence(views),
    `</body></html>`,
  ].join("\n");
}

export function renderCsvFromModel(model = {}) {
  const views = buildUrlViews(model);
  const header = ["url", "classification", "confidence", ...ARM_COLUMNS.map((c) => c.type), "primary_reason"];
  const rows = [header];
  for (const v of views) {
    const cls = classificationOf(v);
    const conf = v.comparison?.confidence ?? "";
    const arms = ARM_COLUMNS.map((c) => v.cells[c.key].status);
    rows.push([v.url.url, cls, conf, ...arms, primaryReason(v)]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

// --- model shaping ---

function buildUrlViews(model = {}) {
  const { urls = [], results = [], comparisons = [] } = model;
  const cmpByUrl = new Map(comparisons.map((c) => [c.urlId, c]));

  // Index results: urlId -> nodeName -> stage -> result.
  const byUrl = new Map();
  for (const r of results) {
    const job = parseJobId(r.jobId || r.id);
    const urlId = r.urlId || job?.urlId;
    if (!urlId) continue;
    const nodeName = r.nodeName || job?.nodeName;
    const stage = r.stage || job?.stage;
    if (!nodeName || !stage) continue;
    if (!byUrl.has(urlId)) byUrl.set(urlId, new Map());
    const nodes = byUrl.get(urlId);
    if (!nodes.has(nodeName)) nodes.set(nodeName, {});
    nodes.get(nodeName)[stage] = r;
  }

  return urls.map((url) => {
    const nodes = byUrl.get(url.id) || new Map();
    const effectiveFor = (nodeName) => {
      const s = nodes.get(nodeName) || {};
      return s.browser_validation || s.initial_test || null;
    };
    const selected = url.selectedNodes || [];
    const cells = {};
    for (const col of ARM_COLUMNS) {
      const nodeResults = selected
        .filter((n) => n.nodeType === col.type)
        .map((n) => ({ node: n.nodeName, result: effectiveFor(n.nodeName) }));
      const status = armStatus(nodeResults.map((nr) => nr.result || {}));
      cells[col.key] = { nodeResults, status };
    }
    return { url, comparison: cmpByUrl.get(url.id) || null, cells };
  });
}

function buildNodeInventory(model = {}, views = []) {
  const registry = new Map((model.nodes || []).map((n) => [n.nodeName, n]));
  const inv = new Map();
  for (const v of views) {
    for (const s of v.url.selectedNodes || []) {
      if (inv.has(s.nodeName)) continue;
      const reg = registry.get(s.nodeName) || {};
      inv.set(s.nodeName, {
        nodeName: s.nodeName,
        nodeType: s.nodeType || reg.nodeType || "",
        status: reg.status || "",
        publicIp: reg.metadata?.publicIp || reg.metadata?.public_ip || s.publicIp || "",
        version: reg.versions?.agentVersion || reg.versions?.workerVersion || "",
      });
    }
  }
  if (!inv.size) {
    for (const n of model.nodes || []) {
      inv.set(n.nodeName, {
        nodeName: n.nodeName,
        nodeType: n.nodeType || "",
        status: n.status || "",
        publicIp: n.metadata?.publicIp || n.metadata?.public_ip || "",
        version: n.versions?.agentVersion || "",
      });
    }
  }
  return [...inv.values()];
}

function evidenceOf(result) {
  if (!result) return null;
  const ev = result.evidence || result.probe || {};
  return {
    ok: result.ok,
    reason: result.specificReason || result.reason || ev.specificReason || "",
    pageClassification: result.pageClassification || "",
    vendor: ev.vendor || "",
    referenceIds: ev.referenceIds || {},
    finalUrl: ev.finalUrl || "",
    redirectChain: ev.redirectChain || [],
    status: ev.http?.status ?? ev.status ?? "",
    artifacts: result.artifactRefs || ev.artifacts || [],
  };
}

const classificationOf = (v) => v.comparison?.classification || v.url.classification || "pending";

function primaryReason(v) {
  for (const col of ARM_COLUMNS) {
    const failing = v.cells[col.key].nodeResults.find((nr) => nr.result && nr.result.ok === false);
    if (failing) return evidenceOf(failing.result).reason || "";
  }
  return "";
}

// --- HTML fragments ---

function renderSummary(views) {
  const counts = {};
  for (const v of views) {
    const c = classificationOf(v);
    counts[c] = (counts[c] || 0) + 1;
  }
  const items = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `<li><span class="badge cls-${escapeAttr(c)}">${escapeHtml(c)}</span> ${n}</li>`)
    .join("");
  return `<h2>Summary</h2><ul class="summary">${items || "<li>no URLs</li>"}</ul>`;
}

function renderInventory(inventory) {
  if (!inventory.length) return "";
  const rows = inventory
    .map(
      (n) =>
        `<tr><td>${escapeHtml(n.nodeName)}</td><td>${escapeHtml(n.nodeType)}</td><td>${escapeHtml(n.status)}</td><td>${escapeHtml(n.publicIp)}</td><td>${escapeHtml(n.version)}</td></tr>`,
    )
    .join("");
  return `<h2>Nodes</h2><table class="inv"><thead><tr><th>Node</th><th>Type</th><th>Status</th><th>Public IP</th><th>Version</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderMatrix(views) {
  const head = `<tr><th>URL</th><th>Classification</th><th>Conf.</th>${ARM_COLUMNS.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("")}</tr>`;
  const rows = views
    .map((v) => {
      const cls = classificationOf(v);
      const conf = v.comparison?.confidence != null ? String(v.comparison.confidence) : "";
      const arms = ARM_COLUMNS.map((c) => armCell(v.cells[c.key])).join("");
      return `<tr><td class="url">${escapeHtml(v.url.url)}</td><td><span class="badge cls-${escapeAttr(cls)}">${escapeHtml(cls)}</span></td><td>${escapeHtml(conf)}</td>${arms}</tr>`;
    })
    .join("");
  return `<h2>Results</h2><table class="matrix"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

function armCell(cell) {
  const detail = cell.nodeResults
    .filter((nr) => nr.result && nr.result.ok === false)
    .map((nr) => {
      const ev = evidenceOf(nr.result);
      const bits = [ev.reason, ev.vendor].filter(Boolean).join(" · ");
      return `<div class="nd">${escapeHtml(nr.node)}${bits ? `: ${escapeHtml(bits)}` : ""}</div>`;
    })
    .join("");
  return `<td class="st-${escapeAttr(cell.status)}"><span class="badge">${escapeHtml(cell.status)}</span>${detail}</td>`;
}

function renderEvidence(views) {
  const failing = views.filter((v) => classificationOf(v) !== "healthy" && classificationOf(v) !== "pending");
  if (!failing.length) return "";
  const blocks = failing
    .map((v) => {
      const rows = [];
      for (const col of ARM_COLUMNS) {
        for (const nr of v.cells[col.key].nodeResults) {
          if (!nr.result || nr.result.ok !== false) continue;
          const ev = evidenceOf(nr.result);
          rows.push(
            `<tr><td>${escapeHtml(col.label)}</td><td>${escapeHtml(nr.node)}</td>` +
              `<td>${escapeHtml(ev.reason)}</td><td>${escapeHtml(ev.pageClassification)}</td>` +
              `<td>${escapeHtml(ev.vendor)}</td><td>${escapeHtml(refIdsStr(ev.referenceIds))}</td>` +
              `<td>${escapeHtml(String(ev.redirectChain.length))}</td><td>${artifactLinks(ev.artifacts)}</td></tr>`,
          );
        }
      }
      if (!rows.length) return "";
      return (
        `<details open><summary>${escapeHtml(v.url.url)} — ${escapeHtml(classificationOf(v))}</summary>` +
        `<table class="ev"><thead><tr><th>Arm</th><th>Node</th><th>Reason</th><th>Page</th><th>Vendor</th><th>Reference IDs</th><th>Redirects</th><th>Artifacts</th></tr></thead><tbody>${rows.join("")}</tbody></table></details>`
      );
    })
    .filter(Boolean);
  return blocks.length ? `<h2>Failure evidence</h2>${blocks.join("\n")}` : "";
}

function artifactLinks(refs = []) {
  return refs
    .filter((r) => r && (r.url || r.id))
    .map((r) => {
      const href = r.url || `/artifacts/${r.id}`;
      const label = r.kind || "artifact";
      return `<a href="${escapeAttr(href)}">${escapeHtml(label)}</a>`;
    })
    .join(" · ");
}

function refIdsStr(ids = {}) {
  return Object.entries(ids)
    .map(([k, val]) => `${k}=${val}`)
    .join(" ");
}

// --- small utilities ---

function parseJobId(jobId) {
  const [urlId, nodeName, stage] = String(jobId || "").split("::");
  return urlId && nodeName && stage ? { urlId, nodeName, stage } : null;
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function escapeAttr(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const STYLE = [
  "body{font:14px/1.45 system-ui,Segoe UI,Arial,sans-serif;margin:24px;color:#1b1b1b}",
  "h1{font-size:20px}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}",
  ".meta{color:#666}",
  "table{border-collapse:collapse;width:100%;margin-top:8px}",
  "th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}",
  "th{background:#f5f5f5}",
  ".url{font-family:ui-monospace,Consolas,monospace;word-break:break-all}",
  ".badge{display:inline-block;padding:1px 6px;border-radius:4px;background:#eee;font-size:12px}",
  ".st-ok{background:#e6f4ea}.st-fail{background:#fce8e6}.st-mixed{background:#fef7e0}.st-unavailable{background:#f1f3f4;color:#777}",
  ".nd{font-size:12px;color:#555;margin-top:2px}",
  ".summary{list-style:none;padding:0;display:flex;gap:16px;flex-wrap:wrap}",
  ".cls-healthy{background:#e6f4ea}.cls-likely_gsa_impacting{background:#fce8e6}.cls-likely_cloudflare_impacting{background:#fef7e0}",
  "details{margin:8px 0}summary{cursor:pointer;font-weight:600}",
].join("");
