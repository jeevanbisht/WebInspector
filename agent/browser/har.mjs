// HAR capture (worker side).
//
// A HAR (HTTP Archive 1.2) of the full network waterfall is recorded ONLY on failing browser
// validations. Response bodies are omitted (content: "omit") so it stays compact and carries
// no payloads. Uploaded as artifact kind `har` (application/json); imports into Chrome DevTools.
//
// TODO: implement via Playwright's recordHar context option; keep + describe only on failure.

export const HAR_RECORD_OPTIONS = Object.freeze({
  recordHar: { mode: "full", content: "omit" }, // pass to browser.newContext({ ...HAR_RECORD_OPTIONS, recordHar: { path } })
});

/** Decide whether to keep the HAR for this validation outcome (failure-only). */
export function shouldKeepHar(validationOk) {
  return validationOk === false;
}
