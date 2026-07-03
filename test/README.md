# test

Tests and test-infrastructure documentation, kept **separate from project code** by
convention. Nothing here is imported by the `control-plane` / `control-plane-agent` /
`agent` / `portal` runtime.

## Running

```bash
npm test                                   # node --test "test/**/*.test.mjs" (10 tests)
node --test test/control-channel.test.mjs  # a single file
```

## Coverage

| Test | Proves |
| --- | --- |
| `control-channel.test.mjs` | Single-port control channel: enroll → authenticated WebSocket connect → `hello`/register → server-dispatched command → `command_result` round-trip; bad credential rejected. Real client + command router against the real server. |
| `data-plane.test.mjs` | Bundle publish (PUT) + stream (GET) with matching bytes/SHA-256; node-authenticated artifact upload + serve by content hash; mismatched SHA rejected (400); unauthenticated upload rejected (401). |
| `worker-ipc.test.mjs` | Spawns the real worker via the worker-manager: job in over stdin → `ready` + `result` out over stdout, surfaced by the supervisor. |
| `run-pipeline.test.mjs` | Fake agents over the real control channel: all-arms-healthy → URL `completed`/`healthy`; GSA fails → browser-validation branch → `likely_gsa_impacting`. |
| `probe.test.mjs` | Layered probe against local servers: 200 OK (dns+tcp layers), redirect chain, 403 with edge headers → vendor + reference ids, connection refused → `TCP_FAILURE` at the tcp layer. |

## Test infrastructure (Azure)

See `infra/` for the Azure resources used by live/integration testing (ControlPlane VM +
per-arm agent VMs). Real subscription IDs are **not** committed to this public repo — they
live in a git-ignored `infra/infra.local.json` (copy from `infra/infra.local.example.json`).
