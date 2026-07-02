// Per-site evidence packet generation (ControlPlane side).
//
// Immutable packet written as soon as a URL completes:
//
//   runs/<run-id>/sites/<site-key>/
//     manifest.json
//     site-summary.json
//     comparison.json
//     <arm>/<node-name>/*   (screenshots, HAR, logs referenced from the data plane)
//
// A missing required artifact must PREVENT completion (no false-complete). This module
// assembles the manifest from state; the bytes live on the data plane.

export function createSitePacket({ store, artifacts } = {}) {
  return {
    async generate(runId, urlRecord, { selectedNodes, jobs, results, comparison, artifactRefs }) {
      const siteKey = siteKeyFor(urlRecord.url);
      const manifest = {
        schemaVersion: "3.0",
        generatedAt: new Date().toISOString(),
        run: { runId },
        url: { urlId: urlRecord.id, url: urlRecord.url },
        selectedNodes: selectedNodes || [],
        jobs: jobs || [],
        results: results || [],
        comparison: comparison || null,
        artifacts: artifactRefs || [],
      };
      // TODO: verify all required artifacts are present before writing; persist packet.
      await store?.put("comparisons", `comparison-${urlRecord.id}`, comparison || {});
      return { siteKey, manifest };
    },
  };
}

export function siteKeyFor(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`.replace(/[^a-z0-9._-]+/gi, "_").toLowerCase();
  } catch {
    return String(url).replace(/[^a-z0-9._-]+/gi, "_").toLowerCase();
  }
}
