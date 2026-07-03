# control-plane-agent

The per-VM **supervisor**. It is the long-lived process the ControlPlane talks to: it owns
the control channel, applies pushed updates, reboots the VM, and manages the worker Agent.
It is intentionally small and stable so updating the worker or rebooting never drops the
control connection.

## Responsibilities

- **Own the control channel** — connect to the ControlPlane, authenticate with the node
  credential minted at enrollment, reconnect with backoff, `hello` + `heartbeat`.
- **Execute commands** (idempotently, deduped by `commandId`): `dispatch_job`,
  `update_agent`, `update_control_plane_agent`, `reboot`, `restart_worker`, `drain`,
  `undrain`, `set_config`, `collect_diagnostics`, `ping`.
- **Manage the worker Agent** — start/stop/restart/monitor, auto-restart on crash, keep it
  at the installed version, run jobs.
- **Apply updates safely** — download + verify (SHA-256/signature) over the data plane,
  atomic A/B swap, health-gate the new worker, roll back on failure.
- **Reboot the VM** — `bye` then OS reboot; the supervisor is an auto-start service, so it
  re-registers on boot.

## Modules

| Area | Module | Purpose |
| --- | --- | --- |
| core | `core/index.mjs` | Entrypoint + supervisor loop. |
| core | `core/connection.mjs` | Control-channel client (WS + long-poll fallback), reconnect/backoff. |
| core | `core/register.mjs` | Build the `hello` registration payload. |
| core | `core/heartbeat.mjs` | Periodic heartbeat with supervisor + worker snapshot. |
| commands | `commands/index.mjs` | Idempotent command router → handlers. |
| commands | `commands/{update,reboot,restart-worker,drain}.mjs` | Individual command handlers. |
| worker-manager | `worker-manager/lifecycle.mjs` | Start/stop/restart/monitor the worker Agent; run jobs. |
| worker-manager | `worker-manager/health.mjs` | Worker health probe (used to health-gate updates). |
| updater | `updater/apply-bundle.mjs` | Download → verify → swap → health-gate → rollback. |
| updater | `updater/rollback.mjs` | Flip `current` back to the previous version. |
| updater | `updater/version.mjs` | Read/write the installed version marker. |
| platform | `platform/*` | OS abstraction (Windows first; Linux + K8s stubbed). |

## Identity

The supervisor reads `state/node-identity.json` (written by the bootstrap at enrollment) for
its `controlPlaneUrl`, `nodeId`, and `nodeCredential`, and authenticates the control channel
with them. The enrollment token itself is never stored or reused.

## Implementation status

**Implemented:** control-channel client — WebSocket preferred with an HTTP long-poll fallback
(`POST /agent/push` + long-held `GET /agent/poll`) and transparent WS→long-poll auto-failover,
reconnect + bounded outbox — register + heartbeat, idempotent command router, worker manager
with stdio IPC (job delivery + ready/result + health gate + force-kill), and the updater
(download + verify + atomic A/B swap + health-gate + rollback). The Windows platform provider
is implemented.

**TODO:** running the supervisor as a real OS service (service host), and the Linux +
Kubernetes platform providers.
