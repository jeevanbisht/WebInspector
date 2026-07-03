# bootstrap

The **small, scriptable component** an admin (or automation) runs on a fresh VM to onboard
it into the WebInspector control plane with **zero touch**.

## Principles

- **Tiny + stable.** The bootstrap only knows how to: fetch the ControlPlane Agent
  (supervisor), verify it, install it as an OS service, and enroll the node. Everything
  else (worker Agent, config, jobs) is delivered afterward by the ControlPlane reconciler.
- **Scriptable / unattended.** Runnable as a one-liner (`iwr … | iex`), an Azure VM Custom
  Script Extension, cloud-init, or a GPO/startup script. Proper exit codes; idempotent.
- **Zero-trust onboarding.** Uses a short-lived, single-use **enrollment token** issued by
  the operator. The bootstrap exchanges it (`POST /api/enroll`) for a durable node
  credential (node token now; mTLS cert-ready). No long-lived secret ever ships in the script.
- **Verify before run.** The supervisor bundle is content-addressed (SHA-256) and
  signature-checked before anything executes.
- **Reuses the platform provider.** `bootstrap.mjs` calls the same
  `control-plane-agent/platform` provider (Windows first) for service install / download /
  extract, so onboarding behaves identically to updates.

## Contents

| File | Purpose |
| --- | --- |
| `windows/install.ps1` | Tiny Windows entrypoint. Ensures Node, downloads `bootstrap.mjs`, runs it. Supports `iwr\|iex` and Custom Script Extension. |
| `linux/install.sh` | Tiny Linux entrypoint (systemd). Ensures Node, downloads `bootstrap.mjs`, runs it. Supports `curl\|sudo -E bash` and cloud-init. |
| `bootstrap.mjs` | Cross-platform orchestrator: manifest → download+verify supervisor → install service → enroll → start. |
| `enroll.mjs` | Enrollment-token exchange + secure persistence of the returned node identity/credential. |

## Flow

```
install.ps1 → bootstrap.mjs:
  GET  /bootstrap/manifest              desired supervisor version + bundle data-ref
  download supervisor bundle (data plane), verify SHA-256/signature
  platform.installService(...)          auto-start OS service (survives reboot)
  POST /api/enroll {enrollmentToken, identity}  → node credential + control-channel URL
  platform.startService(...)            → supervisor connects; reconciler finishes onboarding
```

After `bootstrap.mjs` exits 0, no human action is required: the supervisor connects and the
ControlPlane converges the node to desired state (installs the worker Agent, pushes config,
marks it ready, and it joins the job flow).
