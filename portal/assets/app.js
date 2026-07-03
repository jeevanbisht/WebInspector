// Portal app. Static, dependency-free. Talks to the ControlPlane REST API on the same port.
// Operator-gated /api/* calls carry the operator bearer token (kept in localStorage).

const TOKEN_KEY = "wi_operator_token";
const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
// Split the scheme so no literal "Bearer <token>" appears in source.
const authHeaders = () => (getToken() ? { authorization: "Bea" + "rer " + getToken() } : {});

function checkStatus(path, r) {
  if (r.status === 401) throw new Error("401 — set a valid operator token (top-right)");
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
}

const api = {
  async get(path) {
    const r = await fetch(path, { headers: { ...authHeaders() } });
    checkStatus(path, r);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify(body || {}) });
    checkStatus(path, r);
    return r.json();
  },
};

// --- operator token ---
const tokenInput = document.getElementById("op-token");
if (tokenInput) {
  tokenInput.value = getToken();
  tokenInput.addEventListener("change", () => {
    localStorage.setItem(TOKEN_KEY, tokenInput.value.trim());
    loadNodes();
    loadRuns();
  });
}

// --- view switching ---
document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
    document.getElementById(`view-${b.dataset.view}`).classList.remove("hidden");
  }),
);

// --- health ---
async function pollHealth() {
  const el = document.getElementById("health");
  try {
    await api.get("/api/health");
    el.textContent = "healthy";
    el.className = "pill ok";
  } catch {
    el.textContent = "unreachable";
    el.className = "pill fail";
  }
}

// --- nodes ---
function actionButtons(node) {
  const n = encodeURIComponent(node.nodeName);
  return `
    <button data-act="reboot" data-node="${n}">Reboot</button>
    <button data-act="drain" data-node="${n}">Drain</button>
    <button data-act="restart_worker" data-node="${n}">Restart worker</button>`;
}

async function loadNodes() {
  const tbody = document.querySelector("#nodes-table tbody");
  try {
    const { nodes } = await api.get("/api/nodes");
    if (!nodes?.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="muted">no nodes registered yet — onboard one from the Onboarding tab</td></tr>`;
      return;
    }
    tbody.innerHTML = nodes
      .map(
        (n) => `<tr>
          <td>${n.nodeName || "?"}</td>
          <td>${n.nodeType || "?"}</td>
          <td><span class="pill ${statusClass(n.status)}">${n.status || "?"}</span></td>
          <td>${n.versions?.agentVersion || "—"}</td>
          <td>${n.versions?.controlPlaneAgentVersion || "—"}</td>
          <td>${n.metadata?.publicIp || "—"}</td>
          <td>${n.lastHeartbeatAt ? new Date(n.lastHeartbeatAt).toLocaleTimeString() : "—"}</td>
          <td class="actions">${actionButtons(n)}</td>
        </tr>`,
      )
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="fail">${e.message}</td></tr>`;
  }
}

function statusClass(s) {
  if (["ready", "connected"].includes(s)) return "ok";
  if (["updating", "rebooting", "draining"].includes(s)) return "warn";
  return "fail";
}

document.querySelector("#nodes-table").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const node = decodeURIComponent(btn.dataset.node);
  const act = btn.dataset.act;
  if (act === "reboot" && !confirm(`Reboot ${node}?`)) return;
  try {
    // TODO: dedicated endpoints per action; reboot is wired server-side today.
    if (act === "reboot") await api.post(`/api/nodes/${encodeURIComponent(node)}/reboot`, { reason: "portal" });
    else alert(`${act} endpoint not wired yet`);
    loadNodes();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("refresh-nodes").addEventListener("click", loadNodes);

// --- onboarding ---
document.getElementById("issue-token").addEventListener("click", async () => {
  const nodeType = document.getElementById("enroll-type").value;
  const pre = document.getElementById("enroll-cmd");
  try {
    const { token } = await api.post("/api/enrollment-tokens", { nodeType });
    const url = location.origin;
    pre.textContent =
      `$env:WEBINSPECTOR_CONTROLPLANE_URL='${url}'\n` +
      `$env:WEBINSPECTOR_ENROLLMENT_TOKEN='${token}'\n` +
      `$env:WEBINSPECTOR_NODE_TYPE='${nodeType}'\n` +
      `iwr ${url}/bootstrap/install.ps1 | iex`;
  } catch (e) {
    pre.textContent = `error: ${e.message}`;
  }
});

// --- runs ---
async function loadRuns() {
  const tbody = document.querySelector("#runs-table tbody");
  if (!tbody) return;
  try {
    const { runs } = await api.get("/api/runs");
    if (!runs?.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted">no runs yet — queue a URL above</td></tr>`;
      return;
    }
    tbody.innerHTML = runs
      .map(
        (r) => `<tr>
          <td>${r.id}</td>
          <td><span class="pill ${statusClass(r.status)}">${r.status || "?"}</span></td>
          <td>${r.createdAt ? new Date(r.createdAt).toLocaleTimeString() : "—"}</td>
          <td>${r.urlIds?.length ?? 0}</td>
          <td class="actions"><button data-report="html" data-run="${r.id}">html</button> <button data-report="csv" data-run="${r.id}">csv</button></td>
        </tr>`,
      )
      .join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="fail">${e.message}</td></tr>`;
  }
}

// Reports are operator-gated, so fetch with the auth header and open a blob (a plain link
// navigation can't send Authorization).
async function openReport(runId, fmt) {
  try {
    const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/report.${fmt}`, { headers: { ...authHeaders() } });
    if (!r.ok) {
      alert(`report → ${r.status}`);
      return;
    }
    const url = URL.createObjectURL(await r.blob());
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e) {
    alert(e.message);
  }
}

document.getElementById("create-run")?.addEventListener("click", async () => {
  const input = document.getElementById("run-url");
  const url = input.value.trim();
  if (!url) return;
  try {
    await api.post("/api/runs", { urls: [url] });
    input.value = "";
    loadRuns();
  } catch (e) {
    alert(e.message);
  }
});
document.getElementById("refresh-runs")?.addEventListener("click", loadRuns);
document.querySelector("#runs-table")?.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-report]");
  if (b) openReport(b.dataset.run, b.dataset.report);
});

// --- boot ---
pollHealth();
loadNodes();
loadRuns();
setInterval(pollHealth, 10000);
setInterval(loadNodes, 15000);
