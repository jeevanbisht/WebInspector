// Browser validation (worker side).
//
// Headed Playwright using the system Edge channel (msedge) — this defeats most bot/headless
// detection. Runs a clean context per URL, classifies the page, and captures a screenshot
// always plus a HAR only on failure.
//
// Returns:
//   { ok, specificReason, pageClassification, evidence, artifacts: [{kind, path, sha256, sizeBytes}] }
//
// Stub: interface + capture plan below. TODO: port the existing browser-validator (vendor
// detection, reference IDs, _abck state, redirect chain, failure layer, console/network logs).

export const PAGE_CLASSIFICATIONS = Object.freeze([
  "user_visible_ok",
  "challenge_or_block",
  "http_error",
  "network_failure",
  "timeout",
  "browser_error",
]);

export async function browserValidate(url, { channel = "msedge", timeoutMs = 45000, artifactDir } = {}) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    return {
      ok: false,
      specificReason: "UNKNOWN",
      pageClassification: "browser_error",
      evidence: { note: "playwright not installed; run `npx playwright install msedge`" },
      artifacts: [],
    };
  }

  // TODO: launch headed context (channel), capture HAR on failure, screenshot always,
  // classify page, detect vendor + reference IDs, and populate rich evidence.
  void playwright;
  void url;
  void timeoutMs;
  void artifactDir;
  return {
    ok: false,
    specificReason: "UNKNOWN",
    pageClassification: "browser_error",
    evidence: { note: "browserValidate not implemented (scaffold)" },
    artifacts: [],
  };
}
