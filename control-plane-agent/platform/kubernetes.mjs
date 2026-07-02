// Kubernetes platform provider (STUB — implement after Windows/Linux).
//
// In Kubernetes the supervisor/worker split maps to the pod lifecycle, so several
// "commands" change meaning:
//   - Service:     the supervisor runs as a Deployment/DaemonSet; restart policy handles
//                  crashes; liveness/readiness probes replace heartbeat-based health.
//   - Reboot:      there is no VM reboot — "reboot" = delete the pod and let the
//                  Deployment/DaemonSet reschedule it.
//   - Update:      prefer rolling a new image tag via the Deployment instead of pulling a
//                  bundle in-place; the in-place bundle updater is a fallback.
//   - Atomic swap: emptyDir/volume symlink flip, or just a new pod with the new image.
//   - Config:      ConfigMap/Secret projected as env/files.
//
// The ControlPlane still owns desired state; here it reconciles against the K8s API rather
// than pushing in-place file swaps.

import { PlatformProvider } from "./contract.mjs";

const TODO = "KubernetesPlatform not implemented yet (Windows-first). See file header for the intended mapping.";

export class KubernetesPlatform extends PlatformProvider {
  get name() {
    return "kubernetes";
  }
  async reboot() {
    // = delete this pod; the controller reschedules it.
    throw new Error(TODO);
  }
  async installService() {
    throw new Error(TODO);
  }
  async swapCurrent() {
    throw new Error(TODO);
  }
  async downloadFile() {
    throw new Error(TODO);
  }
  async extractBundle() {
    throw new Error(TODO);
  }
}
