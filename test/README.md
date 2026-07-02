# test

Tests and test-infrastructure documentation, kept **separate from project code** by
convention. Nothing here is imported by the `control-plane` / `control-plane-agent` /
`agent` / `portal` runtime.

## Running

```bash
npm test            # node --test test
node --test test/control-channel.test.mjs
```

## Coverage

| Test | Proves |
| --- | --- |
| `control-channel.test.mjs` | End-to-end single-port control channel: enroll → authenticated WebSocket connect → `hello`/register → server-dispatched command → `command_result` round-trip; and that a bad credential is rejected (node never registers). Uses the real client + real command router against the real server. |

## Test infrastructure (Azure)

See `infra/` for the Azure resources used by live/integration testing (ControlPlane VM +
per-arm agent VMs). Real subscription IDs are **not** committed to this public repo — they
live in a git-ignored `infra/infra.local.json` (copy from `infra/infra.local.example.json`).
