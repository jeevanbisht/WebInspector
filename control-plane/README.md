# control-plane

The orchestrator. One process, one port. Owns durable state, the agent registry, the
command dispatcher, enrollment, central update distribution, scheduling, comparison, and
reporting. Serves the Portal and both planes (control + data) on the same port.

## Modules

| Area | Module | Purpose |
| --- | --- | --- |
| server | `server/index.mjs` | Single-port HTTP server: Portal static, REST API, control channel upgrade, data-plane endpoints, bootstrap + update-bundle serving. |
| server | `server/auth.mjs` | Verify node credentials (control channel + data plane) and operator auth. |
| control | `control/registry.mjs` | Connected-agent registry: identity, versions, metadata, status, heartbeats, sessions. |
| control | `control/dispatcher.mjs` | Send commands down the channel; correlate `command_result`; in-flight tracking for idempotency. |
| control | `control/reconciler.mjs` | Desired-state loop → converges versions/config/drain. |
| control | `control/update-manager.mjs` | Desired versions + canary rollout policy. |
| control | `control/bundle-registry.mjs` | Immutable versioned bundles; data-plane download URLs. |
| control | `control/reboot-manager.mjs` | Orchestrate reboot + await reconnect. |
| control | `control/enrollment.mjs` | Issue/verify enrollment tokens; mint node credentials. |
| state | `state/store.mjs` (+ `adapters/`) | Durable state: runs, nodes, urls, jobs, events, results, comparisons, artifacts, commands. |
| scheduler | `scheduler/*` | URL queue, node selection, per-URL lifecycle state machine. |
| comparison | `comparison/classify.mjs` | Arm comparison → classification. |
| reporting | `reporting/*` | Per-site evidence packets + final HTML/CSV report. |

## Wiring

`server/index.mjs` constructs one object graph and shares it across control + data planes:

```
state ── registry ── dispatcher ─┐
   │        │            │       ├─ reconciler (desired-state loop)
   │        │       update-manager
   │   bundle-registry   │
   │   enrollment        reboot-manager
   └── scheduler ── comparison ── reporting
```

Single port; the plane split is by endpoint, not by port (see the root README).

## Implementation status

**Implemented + tested:** single-port server, control channel (WebSocket + HTTP long-poll
fallback), agent registry, command dispatcher, enrollment, data plane (bundle publish/stream
+ artifact upload/serve), and the run orchestrator (queue → dispatch → results → comparison →
complete) with the runs API (`POST /api/runs`, `POST /api/runs/:id/urls`, `GET /api/runs`, `GET /api/runs/:id`).

**Implemented:** reporting renders the run model to HTML (per-URL arm matrix, node inventory,
failure evidence with vendor/reference-ids/redirect-depth + screenshot/HAR links) and CSV
(`reporting/final-report.mjs`, tested by `test/final-report.test.mjs`).

**Partial / TODO:** the durable state store exists but is not wired on by default
(in-memory today); the per-site evidence packet does not yet verify/persist artifacts.
