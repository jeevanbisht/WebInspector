// Prometheus metrics exposition (ControlPlane side).
//
// Renders a small set of gauges/counters in the text exposition format (v0.0.4) from live
// registry + orchestrator state. Served at GET /api/metrics (operator-gated; a Prometheus
// scrape config supplies the operator bearer token).

export function renderMetrics({ registry, orchestrator } = {}) {
  const nodes = registry?.listAll?.() || [];
  const connected = registry?.listConnected?.() || [];
  const runs = orchestrator?.listRuns?.() || [];

  const nodesByStatus = countBy(nodes, (n) => n.status || "unknown");
  const runsByStatus = countBy(runs, (r) => r.status || "unknown");

  const lines = [];
  const header = (name, help, type) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);

  header("webinspector_up", "1 if the control plane is serving", "gauge");
  lines.push("webinspector_up 1");

  header("webinspector_nodes", "Registered nodes by status", "gauge");
  emitLabelled(lines, "webinspector_nodes", "status", nodesByStatus);

  header("webinspector_nodes_connected", "Nodes with a live control-channel session", "gauge");
  lines.push(`webinspector_nodes_connected ${connected.length}`);

  header("webinspector_runs_total", "Total runs created", "counter");
  lines.push(`webinspector_runs_total ${runs.length}`);

  header("webinspector_runs", "Runs by status", "gauge");
  emitLabelled(lines, "webinspector_runs", "status", runsByStatus);

  return `${lines.join("\n")}\n`;
}

function countBy(items, keyOf) {
  const out = {};
  for (const it of items) {
    const k = keyOf(it);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function emitLabelled(lines, name, label, counts) {
  const entries = Object.entries(counts);
  if (!entries.length) {
    lines.push(`${name}{${label}="none"} 0`);
    return;
  }
  for (const [value, count] of entries) lines.push(`${name}{${label}="${escapeLabel(value)}"} ${count}`);
}

function escapeLabel(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
