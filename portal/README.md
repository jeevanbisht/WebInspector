# portal

Operator web UI, served by the ControlPlane on the same single port (`GET /`,
`GET /assets/*`). Static — it talks to the ControlPlane REST API and reflects live state.

## Views

| View | Shows / does |
| --- | --- |
| **Nodes** | Inventory by type: status, versions, public/private IP, heartbeat, in-flight commands. Per-node actions: **reboot**, **update**, **drain/undrain**, **restart worker**. |
| **Onboarding** | Issue a short-lived enrollment token and copy the ready-to-run bootstrap one-liner for a fresh VM. |
| **Runs** | Queue URLs; watch per-URL arm progress + classification; open packets/reports. |
| **Events** | Live append-only event stream (management actions + test lifecycle). |

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Shell + view containers. |
| `assets/app.js` | Fetches `/api/*`, renders, polls, and issues commands. |
| `assets/styles.css` | Minimal styling. |

This is a scaffold: `app.js` wires the Nodes + Onboarding calls. The ControlPlane runs API
(`/api/runs*`) now exists, but the Portal Runs/Events views are not yet wired to it.
