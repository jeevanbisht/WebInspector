# test/infra — Azure test infrastructure

Infrastructure used for live/integration testing of WebInspector, kept separate from
project code. This is where the ControlPlane VM and the per-arm agent VMs (azure_direct,
gsa_remotenet, gsa_client, cloudflare_client, external_direct) run for end-to-end validation.

## Resource group

| Field | Value |
| --- | --- |
| Resource group | `WebInspector` |
| Tenant | `microsoft.onmicrosoft.com` |
| Subscription | see `infra.local.json` (git-ignored; **not** published to this public repo) |

Portal (fill your subscription): `https://ms.portal.azure.com/#@microsoft.onmicrosoft.com/resource/subscriptions/<subscriptionId>/resourceGroups/WebInspector/overview`

## Local config

Real IDs stay out of git. Copy the example and fill it in:

```bash
cp test/infra/infra.local.example.json test/infra/infra.local.json
# edit infra.local.json with the real subscriptionId
```

`infra.local.json` is matched by `*.local.json` in `.gitignore`, so it is never committed.

## Mapping to components

| Azure resource | WebInspector role |
| --- | --- |
| ControlPlane VM | runs `control-plane` (single port) + Portal |
| Agent VMs (one per arm) | run `control-plane-agent` (supervisor) + `agent` (worker) |

Onboard each VM with zero-touch bootstrap (issue an enrollment token in the Portal, then
`iwr <cp>/bootstrap/install.ps1 | iex`) — no manual install.
