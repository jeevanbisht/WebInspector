# WebInspector — Rewire

[![CI](https://github.com/jeevanbisht/WebInspector/actions/workflows/ci.yml/badge.svg)](https://github.com/jeevanbisht/WebInspector/actions/workflows/ci.yml)

A re-architecture of CheckWebHealth/TestingInfra into a **control-plane + managed-agent**
model with **central control, single-port transport, push updates, and remote reboot**.

Repo: https://github.com/jeevanbisht/WebInspector

## Topology

```
                       (single port, bidirectional)
  ┌────────┐        ┌────────────────┐        ┌──────────────────────── VM ─┐
  │ Portal │◀──────▶│  ControlPlane  │◀──────▶│  ControlPlane Agent → Agent │
  └────────┘        └────────────────┘        └─────────────────────────────┘
                            ▲  │                    (supervisor)   (worker)
                            │  │  down: commands, updates, reboot, jobs (blue)
                            │  └────────────────────────────────────────────▶
                            └───────────────────────────────────────────────
                               up: hello, heartbeat, status, results (green)
```

Four components map directly to the diagram:

| Component | Role | Runs on |
| --- | --- | --- |
| **Portal** | Web UI for operators. Visibility + control surface. | Served by ControlPlane |
| **ControlPlane** | Orchestrator. Owns state, scheduling, agent registry, enrollment, update distribution, command dispatch, reporting. | `Orch1` |
| **ControlPlane Agent** | Long-lived per-VM supervisor. Owns the control channel, applies pushed updates, reboots the VM, and manages the worker Agent lifecycle. | Each VM |
| **Agent** | Worker. Runs the actual probes + browser validation. Frequently updated; owned by the ControlPlane Agent. | Each VM |
| **Bootstrap** | Tiny, scriptable installer for zero-touch onboarding. Fetches + installs the supervisor and enrolls the node; then gets out of the way. | Each VM (once) |

## Why the rewire

Today nodes **pull** jobs (`GET /api/jobs/next`) and are updated/rebooted out-of-band
via `az vm run-command`. The rewire moves to a **push** model with a persistent
control channel so the ControlPlane has first-class:

1. **Control** — dispatch jobs, drain, restart, reboot, and reconfigure agents centrally.
2. **Visibility** — live agent inventory, heartbeats, worker state, and telemetry streamed up.
3. **Single port** — Portal UI, REST API, agent control channel, artifact upload, and
   update bundles all served on **one** ControlPlane port.
4. **Central push updates** — the ControlPlane hosts versioned agent bundles and pushes
   `update_agent` to bring VMs to the desired version, with verify + rollback.
5. **Remote reboot** — the ControlPlane sends a `reboot` command; the supervisor survives
   the reboot (service/scheduled task) and re-registers.

## The two-process split on each VM

The **ControlPlane Agent** (supervisor) is deliberately separate from the **Agent** (worker):

- The supervisor is small, stable, and rarely updated. It owns the control channel and
  the VM lifecycle (reboot, restart, update).
- The worker is where probe/browser logic lives and changes often. It can be swapped and
  restarted by the supervisor **without dropping the control channel**.

This is what makes "push agent updates centrally" and "reboot" safe: the channel that
receives those commands is not the thing being updated or restarted.

## Single-port surface (ControlPlane)

Everything is served on one port (default `8787`), split across a **control plane** (small,
low-latency) and a **data plane** (bulk, resumable):

| Path | Purpose | Plane / Direction |
| --- | --- | --- |
| `GET /` , `GET /assets/*` | Portal UI (static) | Portal ↔ CP |
| `/api/*` | REST API (nodes, runs, jobs, commands, enrollment) | Portal/tools ↔ CP |
| `/agent/channel` · `/agent/poll` · `/agent/push` | Persistent bidirectional control channel — WebSocket, with an HTTP long-poll fallback (`GET /agent/poll` down, `POST /agent/push` up). Small messages + refs only. | Control · Agent ↔ CP |
| `GET /bootstrap/install.ps1` | Tiny scriptable onboarding entrypoint | CP → VM |
| `GET /bootstrap/bootstrap.mjs` | Cross-platform bootstrap orchestrator | CP → VM |
| `GET /bootstrap/manifest` | Desired supervisor version + bundle reference | CP → VM |
| `POST /api/enrollment-tokens` | Operator issues a short-lived, single-use enrollment token | Portal → CP |
| `POST /api/enroll` | Bootstrap exchanges token + identity → node credential | VM → CP |
| `POST /api/results/<jobId>` | Bulk result body | Data · Agent → CP |
| `POST /api/artifacts/upload` | Screenshot / HAR upload (resumable) | Data · Agent → CP |
| `GET /agent/updates/<version>/bundle` | Versioned agent/supervisor update bundle | Data · CP → Agent |

## Folder map

```
rewire/
  shared/                 # protocol + contracts shared by every component
    protocol/             # control-channel (small msgs + refs) + data-plane (bulk) contracts
    contracts/            # nodes, commands, events, versions
  bootstrap/              # tiny scriptable zero-touch onboarding component
    windows/              # install.ps1 (iwr|iex / Custom Script Extension entrypoint)
  control-plane/          # the orchestrator (single port)
    server/               # single-port HTTP + control-channel server
    control/              # registry, dispatcher, reconciler, update + reboot mgrs, enrollment, bundles
    state/                # durable state store (+ adapters)
    scheduler/            # queue, node selection, per-URL lifecycle
    comparison/           # arm comparison + classification
    reporting/            # site packets + final report
  control-plane-agent/    # per-VM supervisor
    core/                 # entrypoint, control-channel client, register, heartbeat, reconcile
    commands/             # update, reboot, restart-worker, drain handlers
    worker-manager/       # start/stop/monitor the worker Agent
    updater/              # download + verify + apply + rollback update bundles
    platform/             # OS abstraction: windows (first), linux, kubernetes
  agent/                  # per-VM worker (probes)
    core/                 # entrypoint + job loop (driven by supervisor)
    probe/                # fast initial HTTP probe
    browser/              # Playwright browser validation, screenshot, HAR
    metadata/             # public IP, local network, azure metadata
    artifacts/            # artifact upload
  portal/                 # operator web UI (served by ControlPlane)
  deploy/                 # packaging + deployment scripts (windows first)
```

## Zero-touch onboarding

A fresh VM joins the full flow with no manual configuration:

1. Operator issues a short-lived, single-use **enrollment token** (scoped to a node type)
   from the Portal (`POST /api/enrollment-tokens`).
2. On the VM, an admin or automation runs the tiny bootstrap — interactively or unattended
   (Azure VM Custom Script Extension / cloud-init / GPO startup script):
   ```powershell
   # Windows
   $env:WEBINSPECTOR_CONTROLPLANE_URL='http://<cp>:8787'
   $env:WEBINSPECTOR_ENROLLMENT_TOKEN='<token>'
   $env:WEBINSPECTOR_NODE_TYPE='azure_direct'
   iwr http://<cp>:8787/bootstrap/install.ps1 | iex
   ```
   ```bash
   # Linux (systemd)
   export WEBINSPECTOR_CONTROLPLANE_URL='http://<cp>:8787'
   export WEBINSPECTOR_ENROLLMENT_TOKEN='<token>'
   export WEBINSPECTOR_NODE_TYPE='azure_direct'
   curl -fsSL "$WEBINSPECTOR_CONTROLPLANE_URL/bootstrap/install.sh" | sudo -E bash
   ```
3. The bootstrap downloads + verifies the supervisor, installs it as an auto-start service,
   and enrolls the node (`POST /api/enroll`) — exchanging the token for a durable node
   credential (the enrollment token is never reused).
4. The supervisor connects and the **reconciler** converges the node to desired state
   (installs the worker Agent, pushes config, marks it ready). No further human steps.

The bootstrap stays tiny and stable on purpose: it only fetches, installs, and enrolls. All
later change — worker versions, config, reboot — is delivered centrally over the control
channel.

## Platforms

The supervisor does everything OS-specific through a `PlatformProvider` (see
`control-plane-agent/platform/`), so the same control logic runs everywhere. **Windows**
(services via `sc.exe`), **Linux** (systemd), and **Kubernetes** (pod lifecycle) providers are
implemented; the selector picks one by host (`WEBINSPECTOR_PLATFORM` overrides). Full
systemctl/kubectl execution is verified on those hosts; the command/unit builders are unit-tested.

## Best practices baked in

- **Security** — **optional in-process TLS** (single-port HTTPS + `wss`) with **opt-in mTLS**
  (nodes authenticate by a client cert pinned at enrollment; the bearer credential still works),
  authenticated control channel (enrollment token → durable node
  credential) and **operator-authenticated `/api/*`** — mutations *and* inventory/run reads —
  (bearer PAT, pluggable for OIDC/session), **ed25519-signed + SHA-256-verified update bundles**
  (verified on publish and again before apply), enrollment tokens + node credentials stored
  **hashed at rest** with constant-time verification + revocation, baseline security headers (CSP/nosniff/frame-deny), per-IP enroll rate limiting, expired-token cleanup, least privilege, no secrets in repo.
- **Reliability** — reconnect with backoff, idempotent commands (dedupe by `commandId`),
  ack + result correlation, graceful drain, watchdog self-heal.
- **Updates** — desired-state reconciliation, canary-first rollout, atomic A/B swap,
  health-gated progression, automatic rollback, immutable versioned bundles.
- **Reboot safety** — supervisor runs as an auto-start OS service, survives reboot, and
  re-registers on boot.
- **Observability** — structured logs, up-channel telemetry, health + Prometheus metrics (`GET /api/metrics`) endpoints, append-only
  events covering management actions as well as test execution.

## Status

Core mechanics are implemented and covered by an integration test suite (`npm test`, 77
tests). This is well past scaffolding — a URL can flow through the whole system end to end.

**Implemented + tested**

| Area | State |
| --- | --- |
| Control channel (single port) | WebSocket **and** an HTTP long-poll fallback behind one auth check + one inbound router: auth, register, heartbeat, bidirectional commands + results, with transparent WS→long-poll auto-failover. Tests: `test/control-channel.test.mjs`, `test/control-channel-longpoll.test.mjs` |
| Data plane (content-addressed) | Publish/stream bundles, upload/serve artifacts (SHA-256 verified), result ingest. Test: `test/data-plane.test.mjs` |
| Worker IPC (supervisor ↔ worker over stdio) | Job delivery + ready/result + health gate + force-kill on stop. Test: `test/worker-ipc.test.mjs` |
| Run pipeline (queue → dispatch → compare → complete) | Orchestrator, browser-validation branch, classification, runs API. Test: `test/run-pipeline.test.mjs` |
| Layered initial probe | DNS/TCP/TLS/HTTP with redirect chain, failure-layer classification, vendor/reference-id detection. Test: `test/probe.test.mjs` |
| Browser validation | Playwright (Edge channel, chromium fallback): page classification, edge/WAF vendor + reference-id + Akamai `_abck` detection, screenshot always + failure-only HAR. Test: `test/browser-validation.test.mjs` |
| Central updates | Bundle registry, canary reconciler, verify + atomic A/B swap + health-gate + rollback |
| Remote reboot | Command + `bye` + await-reconnect (closes fully once the service host lands) |
| Zero-touch onboarding | Control-plane side (enrollment) + Windows bootstrap install path |
| Cross-platform provider | Windows (`sc.exe`), Linux (systemd), and Kubernetes (pod lifecycle) providers implemented. Test: `test/platform.test.mjs` |
| Final report (HTML/CSV) | Per-URL arm matrix (Azure Direct / GSA_RNet / GSA_CLIENT / CloudFlare / External), classification + confidence, node inventory, and failure evidence (specific reason, vendor, reference IDs, redirect depth, screenshot/HAR links). Test: `test/final-report.test.mjs` |
| Durable state store | Adapter-backed store (in-memory default; **SQLite** via built-in `node:sqlite` — indexed + transactional — or localJson for durability; on by default for the CLI). Runs/results/comparisons **and node identity (credentials + registry)** survive a restart; `GET /api/runs/:id/report.{html,csv}` renders from it. Tests: `test/state-store.test.mjs`, `test/sqlite-adapter.test.mjs`, `test/identity-persistence.test.mjs` |

**Still stubbed / TODO**

- Windows service host (nssm/winsw) so the supervisor + control-plane run as real services
- Horizontal scale-out: shared state + a command bus so multiple control-plane instances can
  route commands to the instance holding each node's session (durable single-instance store is
  now wired; multi-instance is next)

## Quickstart

```bash
npm install
npm test                 # 77 integration tests
npm run control-plane    # single-port server (default :8787) → http://localhost:8787
```

Onboard a node (zero-touch): issue an enrollment token in the Portal, then on the VM run
`iwr http://<cp>:8787/bootstrap/install.ps1 | iex` (Windows) or
`curl -fsSL http://<cp>:8787/bootstrap/install.sh | sudo -E bash` (Linux) — see "Zero-touch
onboarding" above.

Operator-only API mutations (issue enrollment tokens, create/queue runs, reboot a node,
publish an update bundle) require an operator bearer token. Set `WEBINSPECTOR_OPERATOR_TOKEN`
(comma-separated for multiple); if none is set, the server mints and logs an ephemeral one at
startup so the surface is never open. The operator API — mutations **and** inventory/run reads
(`GET /api/nodes`, `GET /api/runs`) — requires this token; only health, bootstrap, and the
static Portal shell stay public.

State is durable: the CLI persists runs/results/comparisons under `./state/db` so they survive
a restart — set `WEBINSPECTOR_STATE_DRIVER=sqlite` for the indexed, transactional SQLite store
(built-in `node:sqlite`, no dependency), `WEBINSPECTOR_STATE_DIR` to relocate, or
`WEBINSPECTOR_STATE_PERSIST=0` to run in-memory. A run's final report is at
`GET /api/runs/<id>/report.html` (and `report.csv`), rendered from the store.

Serve over HTTPS (recommended on any shared network) by setting `WEBINSPECTOR_TLS_CERT_FILE`
and `WEBINSPECTOR_TLS_KEY_FILE` (PEM) — the whole single port, including the `wss` control
channel, is then encrypted. Agents trust a private CA via `NODE_EXTRA_CA_CERTS`. Without TLS
the server logs a cleartext warning at startup. Set `WEBINSPECTOR_MTLS=1` (with TLS) to also
require a node **client certificate** — its fingerprint is pinned when the node enrolls (pass
`clientCertPem`), and the agent presents the cert on the `wss` control channel.

## Continuing the build

Remaining work is under "Still stubbed / TODO"; the natural next step is the Windows service
host. Every component's `README.md` documents its contract, and the `test/` suite is the
fastest way to see the implemented behavior in action.
