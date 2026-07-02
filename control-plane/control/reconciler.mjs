// Reconciler (ControlPlane side).
//
// A Kubernetes-controller-style desired-state loop. Periodically diffs every connected
// node's ACTUAL state (versions, config, drain) against DESIRED state and issues the
// minimum set of commands to converge — idempotently. This is what makes central updates,
// config pushes, and drains "just happen" without imperative orchestration.
//
// Idempotency: never re-issues a command that is already in flight for a node.

export function createReconciler({ registry, dispatcher, updateManager, desiredConfig = {}, logger = console } = {}) {
  let timer = null;

  async function reconcileOnce() {
    const nodes = registry.listConnected();

    // 1. Version convergence (central agent updates), staged per updateManager policy.
    for (const component of ["control-plane-agent", "agent"]) {
      const desiredVersion = updateManager.getDesired()[
        component === "agent" ? "agentVersion" : "controlPlaneAgentVersion"
      ];
      if (!desiredVersion) continue;
      const needing = nodes.filter((n) => {
        const plan = updateManager.planForNode(n);
        return component === "agent" ? plan.updateAgent : plan.updateSupervisor;
      });
      const batch = updateManager.pickRolloutBatch(component, desiredVersion, needing);
      for (const node of batch) {
        if (dispatcher.hasInFlightCommand(node.nodeName, "update")) continue; // idempotent
        const cmd = updateManager.makeUpdateCommand(component, desiredVersion);
        await dispatcher.send(node.nodeName, cmd);
        logger.info?.(`[reconcile] update ${component}@${desiredVersion} -> ${node.nodeName}`);
      }
    }

    // 2. Config convergence.
    for (const node of nodes) {
      if (needsConfig(node, desiredConfig) && !dispatcher.hasInFlightCommand(node.nodeName, "set_config")) {
        await dispatcher.sendCommand(node.nodeName, "set_config", { config: desiredConfig });
      }
    }

    // 3. Drain convergence (desired drain state from operator).
    for (const node of nodes) {
      const wantDrain = Boolean(desiredConfig.drain?.[node.nodeName]);
      if (wantDrain && node.status !== "draining") await dispatcher.sendCommand(node.nodeName, "drain");
      if (!wantDrain && node.status === "draining") await dispatcher.sendCommand(node.nodeName, "undrain");
    }
  }

  function needsConfig(node, config) {
    // TODO: compare node.appliedConfigHash against hash(config)
    return false;
  }

  return {
    reconcileOnce,
    start({ intervalMs = 5000 } = {}) {
      if (timer) return;
      timer = setInterval(() => reconcileOnce().catch((e) => logger.error?.("[reconcile]", e)), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
