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
// The manifest records which REQUIRED artifacts are present (screenshot always for a browser
// validation; HAR additionally when it failed) and flags any that are missing, so evidence
// completeness is auditable and can gate "complete" under a strict policy (no false-complete).
// The bytes live on the data plane; this assembles + persists the manifest from state.

export function createSitePacket({ store, artifacts } = {}) {
  return {
    async generate(runId, urlRecord, { selectedNodes, jobs, results, comparison, artifactRefs } = {}) {
      const siteKey = siteKeyFor(urlRecord.url);
      const collected = collectArtifacts(results, artifactRefs);
      const required = requiredArtifacts(results);
      const { complete, missing } = checkCompleteness(required, collected);

      const manifest = {
        schemaVersion: "3.0",
        generatedAt: new Date().toISOString(),
        run: { runId },
        url: { urlId: urlRecord.id, url: urlRecord.url },
        siteKey,
        selectedNodes: selectedNodes || [],
        jobs: jobs || [],
        results: results || [],
        comparison: comparison || null,
        artifacts: collected,
        evidence: { required, missing, complete },
      };

      // Persist the packet manifest keyed by URL so a restarted CP / the report can read it.
      const p = store?.put?.("site_packets", urlRecord.id, manifest);
      p?.catch?.(() => {});

      return { siteKey, manifest, complete, missing };
    },
  };
}

// Artifacts carried on browser_validation results (screenshot/HAR refs), plus any passed in.
function collectArtifacts(results, extra) {
  const out = [...(extra || [])];
  for (const r of results || []) {
    for (const a of r?.artifactRefs || []) out.push({ ...a, nodeName: a.nodeName || r.nodeName });
  }
  return out;
}

// A browser validation must yield a screenshot (always) and, when it FAILED, a HAR.
function requiredArtifacts(results) {
  const req = [];
  for (const r of results || []) {
    if (r?.stage !== "browser_validation") continue;
    req.push({ nodeName: r.nodeName, kind: "screenshot" });
    if (r.ok === false) req.push({ nodeName: r.nodeName, kind: "har" });
  }
  return req;
}

function checkCompleteness(required, artifacts) {
  const have = new Set((artifacts || []).map((a) => `${a.nodeName}:${a.kind}`));
  const missing = required.filter((r) => !have.has(`${r.nodeName}:${r.kind}`));
  return { complete: missing.length === 0, missing };
}

export function siteKeyFor(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`.replace(/[^a-z0-9._-]+/gi, "_").toLowerCase();
  } catch {
    return String(url).replace(/[^a-z0-9._-]+/gi, "_").toLowerCase();
  }
}
