// Job runner (worker side).
//
// Runs a single job end to end and returns a structured result:
//   1. initial test (fast probe)
//   2. if not OK → browser validation (headed Playwright) with screenshot + failure HAR
//   3. upload artifacts over the data plane; return a small summary + refs
//
// Classification of the URL happens on the ControlPlane; the worker only reports evidence.

import { initialTest } from "../probe/initial-test.mjs";
import { browserValidate } from "../browser/browser-validation.mjs";
import { collectMetadata } from "../metadata/local-network.mjs";
import { uploadArtifact } from "../artifacts/upload.mjs";

export async function runJob(job, { controlPlaneUrl, authHeader } = {}) {
  if (!job?.url) throw new Error("job requires a url");
  const metadata = await collectMetadata().catch(() => ({}));

  if (job.stage === "initial_test" || !job.stage) {
    const probe = await initialTest(job.url);
    return {
      stage: "initial_test",
      nodeName: job.nodeName,
      nodeType: job.nodeType,
      url: job.url,
      ok: probe.ok,
      reason: probe.reason,
      probe,
      metadataSnapshot: metadata,
      completedAt: new Date().toISOString(),
    };
  }

  if (job.stage === "browser_validation") {
    const validation = await browserValidate(job.url);
    const artifactRefs = [];
    if (controlPlaneUrl) {
      for (const artifact of validation.artifacts || []) {
        artifactRefs.push(await uploadArtifact(controlPlaneUrl, artifact, { authHeader }).catch(() => null));
      }
    }
    return {
      stage: "browser_validation",
      nodeName: job.nodeName,
      nodeType: job.nodeType,
      url: job.url,
      ok: validation.ok,
      reason: validation.specificReason,
      pageClassification: validation.pageClassification,
      evidence: validation.evidence,
      artifactRefs: artifactRefs.filter(Boolean),
      metadataSnapshot: metadata,
      completedAt: new Date().toISOString(),
    };
  }

  throw new Error(`unknown job stage: ${job.stage}`);
}
