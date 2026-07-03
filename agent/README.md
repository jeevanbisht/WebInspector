# agent

The per-VM **worker**. It runs the actual probes and browser validation and uploads
evidence. It is the frequently-updated component and is owned/managed by the ControlPlane
Agent (supervisor) — it does not hold the control channel itself.

## Responsibilities

- Receive jobs from the supervisor (local IPC), run them, and return structured results.
- **Initial test** — fast DNS/TCP/TLS/HTTP probe with timings, redirect chain, final URL.
- **Browser validation** — headed Playwright (system Edge channel) for URLs whose initial
  test is not OK; captures page classification, vendor/reference IDs, screenshot, and a
  failure-only HAR.
- Capture node **metadata** (public IP, local network, Azure IMDS) for the result snapshot.
- Upload artifacts (screenshot/HAR) over the **data plane** (content-addressed, resumable).

## Modules

| Area | Module | Purpose |
| --- | --- | --- |
| core | `core/index.mjs` | Worker entrypoint; receives jobs from the supervisor; reports readiness. |
| core | `core/job-runner.mjs` | Runs a job end to end (initial test → decision → browser validation → upload). |
| probe | `probe/initial-test.mjs` | Fast HTTP probe with layered timings. |
| browser | `browser/browser-validation.mjs` | Playwright validation (Edge channel). |
| browser | `browser/screenshot.mjs`, `browser/har.mjs` | Screenshot + failure-only HAR capture. |
| metadata | `metadata/{public-ip,local-network,azure-metadata}.mjs` | Node metadata snapshot. |
| artifacts | `artifacts/upload.mjs` | Data-plane artifact upload (SHA-256, resumable). |

## Result contract

Each job produces a result for its stage (`initial_test` or `browser_validation`) carrying
the stage outcome, node metadata + version snapshot, and — via the control channel — only
small summaries + `artifact_ref` / `result_ref` pointers. The bytes go on the data plane.

## Implementation status

- `probe/initial-test.mjs` — **implemented**: layered DNS/TCP/TLS/HTTP probe with redirect
  chain, failure-layer classification, and edge/WAF vendor + reference-id detection.
- `core/*`, `metadata/*`, `artifacts/upload.mjs` — **implemented** (stdio IPC + data-plane upload).
- `browser/*` — **implemented**: Playwright validation (Edge `msedge` channel with bundled
  chromium fallback) — clean context per URL, page classification, edge/WAF vendor +
  reference-id + Akamai `_abck` detection, redirect chain, screenshot always + failure-only HAR.
