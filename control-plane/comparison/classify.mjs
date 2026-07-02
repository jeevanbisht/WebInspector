// Arm comparison + classification (ControlPlane side).
//
// Compares the network arms for a URL and produces a classification. The two GSA arms
// (gsa_remotenet + gsa_client) are combined into one logical GSA group for the decision,
// while the dashboard/report keep them as separate evidence columns.

export const CLASSIFICATIONS = Object.freeze([
  "healthy",
  "likely_gsa_impacting",
  "likely_cloudflare_impacting",
  "azure_direct_environment_issue",
  "azure_egress_or_region_issue",
  "common_destination_or_site_issue",
  "node_group_disagreement",
  "inconclusive",
  "pending",
]);

export const ARM_STATUSES = Object.freeze(["ok", "fail", "mixed", "unavailable"]);

/** Aggregate per-node results for one arm into a single arm status. */
export function armStatus(nodeResults = []) {
  const usable = nodeResults.filter((r) => r && r.ok !== undefined);
  if (!usable.length) return "unavailable";
  const oks = usable.filter((r) => r.ok).length;
  if (oks === usable.length) return "ok";
  if (oks === 0) return "fail";
  return "mixed";
}

/**
 * Classify a URL from its arm statuses.
 * @param {{azureDirect,gsaRemotenet,gsaClient,cloudflareClient,externalDirect}} arms
 */
export function classify(arms = {}) {
  const azure = arms.azureDirect || "unavailable";
  const gsa = combineGsa(arms.gsaRemotenet, arms.gsaClient);
  const cf = arms.cloudflareClient || "unavailable";
  const ext = arms.externalDirect || "unavailable";

  if (gsa === "mixed") return result("node_group_disagreement", 0.5, { azure, gsa, cf, ext });

  if (azure === "ok" && gsa === "ok") {
    if (cf === "fail") return result("likely_cloudflare_impacting", 0.7, { azure, gsa, cf, ext });
    return result("healthy", 0.9, { azure, gsa, cf, ext });
  }
  if (azure === "ok" && gsa === "fail") return result("likely_gsa_impacting", 0.8, { azure, gsa, cf, ext });
  if (azure === "fail" && (gsa === "ok" || cf === "ok")) return result("azure_direct_environment_issue", 0.7, { azure, gsa, cf, ext });
  if (azure === "fail" && gsa === "fail" && ext === "ok") return result("azure_egress_or_region_issue", 0.7, { azure, gsa, cf, ext });
  if (azure === "fail" && gsa === "fail") return result("common_destination_or_site_issue", 0.6, { azure, gsa, cf, ext });
  return result("inconclusive", 0.3, { azure, gsa, cf, ext });
}

/** Combine the two GSA arms into one logical status for the decision. */
export function combineGsa(remotenet, client) {
  const arms = [remotenet, client].filter(Boolean);
  if (!arms.length) return "unavailable";
  if (arms.includes("mixed")) return "mixed";
  const oks = arms.filter((s) => s === "ok").length;
  const fails = arms.filter((s) => s === "fail").length;
  if (oks && fails) return "mixed"; // the two GSA paths disagree
  if (oks) return "ok";
  if (fails) return "fail";
  return "unavailable";
}

function result(classification, confidence, arms) {
  return { classification, confidence, arms };
}
