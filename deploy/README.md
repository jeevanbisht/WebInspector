# deploy

Packaging + deployment for WebInspector. **Windows first**; Linux/K8s follow the platform
provider work.

## Layout

| Path | Purpose |
| --- | --- |
| `windows/install-control-plane.ps1` | Install the ControlPlane as an auto-start Windows service and open the port. |
| `scripts/build-bundle.mjs` | Package a component (`agent` / `control-plane-agent`) into an immutable, content-addressed bundle for central push updates. |

## ControlPlane (Orch1)

```powershell
# from the repo on Orch1, elevated:
.\deploy\windows\install-control-plane.ps1 -InstallRoot C:\WebInspector -Port 8787
```

Durable state lives in `C:\WebInspector\state` and is preserved across app deploys — never
delete it.

## Nodes (VMs)

Nodes are **not** installed manually — use zero-touch onboarding (root README): issue an
enrollment token in the Portal, then run `iwr <cp>/bootstrap/install.ps1 | iex` on the VM
(or via Azure Custom Script Extension / cloud-init).

## Publishing a new agent version (central update)

```powershell
# 1. build an immutable bundle
node .\deploy\scripts\build-bundle.mjs --component agent --version 3.1.0 --src .\agent

# 2. place the bundle where the ControlPlane serves it (state\bundles) and register it
#    (bundle registry), then set desiredVersions.agentVersion = 3.1.0 in the Portal/config.
# 3. the reconciler rolls it out canary-first with health-gated rollback — no manual touch.
```
