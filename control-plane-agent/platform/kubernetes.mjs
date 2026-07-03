// Kubernetes platform provider.
//
// The supervisor/worker split maps to the pod lifecycle, so lifecycle "commands" change meaning
// (see the control-plane README). File/process/download operations run inside a Linux container,
// so this EXTENDS LinuxPlatform and only overrides the lifecycle:
//   - Service:  owned by the Deployment/DaemonSet — installService is a no-op.
//   - Reboot:   no VM reboot — delete this pod; the controller reschedules it.
//   - Restart:  likewise delete the pod (or roll the Deployment).
//   - Update:   in-place bundle swap is the fallback; prefer rolling a new image tag.
//
// kubectl invocations assume an in-cluster kubeconfig / service-account with the RBAC to delete
// its own pod. Command builders are exported for unit testing.

import { LinuxPlatform } from "./linux.mjs";
import { run } from "./exec.mjs";

export class KubernetesPlatform extends LinuxPlatform {
  get name() {
    return "kubernetes";
  }

  async reboot() {
    const [cmd, args] = podDeleteArgs(process.env);
    await run(cmd, args);
    return { rebooting: true, mode: "pod-delete" };
  }

  async installService() {
    // Lifecycle is owned by the Deployment/DaemonSet, not an in-pod service manager.
    return { installed: "managed-by-kubernetes" };
  }

  async restartService() {
    const [cmd, args] = podDeleteArgs(process.env);
    await run(cmd, args);
    return { restarted: "pod-delete" };
  }
}

// Build the `kubectl delete pod` command for THIS pod (name from POD_NAME or the K8s-injected
// HOSTNAME; namespace from POD_NAMESPACE). `--wait=false` returns immediately.
export function podDeleteArgs(env = process.env) {
  const pod = env.POD_NAME || env.HOSTNAME;
  if (!pod) throw new Error("cannot determine pod name (set POD_NAME or HOSTNAME)");
  const ns = env.POD_NAMESPACE || env.WEBINSPECTOR_NAMESPACE;
  return ["kubectl", ["delete", "pod", pod, ...(ns ? ["-n", ns] : []), "--wait=false"]];
}
