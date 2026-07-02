// Portal app. Static, dependency-free. Talks to the ControlPlane REST API on the same port.

const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  },
};

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

// --- boot ---
pollHealth();
loadNodes();
setInterval(pollHealth, 10000);
setInterval(loadNodes, 15000);
