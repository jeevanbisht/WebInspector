// Reboot manager (ControlPlane side).
//
// Orchestrates a remote reboot: send the `reboot` command, expect the node to disconnect,
// then wait (within a grace window) for it to reconnect and re-register. Surfaces reboot
// state so the Portal shows "rebooting → reconnected" instead of a scary "offline".

import { makeEvent } from "../../shared/contracts/events.mjs";

export function createRebootManager({ dispatcher, registry, store = null, reconnectGraceMs = 300000, onEvent = null } = {}) {
  const pending = new Map(); // nodeName -> { since, timer }

  function emit(type, fields) {
    const evt = makeEvent(type, fields);
    onEvent?.(evt);
    // TODO: store?.appendEvent(evt)
    return evt;
  }

  return {
    async reboot(nodeName, { reason = "operator-requested reboot", requestedBy = "operator" } = {}) {
      const commandId = await dispatcher.sendCommand(nodeName, "reboot", { reason }, { requestedBy, reason });
      const nodeId = registry.listAll().find((n) => n.nodeName === nodeName)?.nodeId;
      if (nodeId) registry.setStatus(nodeId, "rebooting");
      emit("reboot_requested", { nodeName, commandId, message: reason });

      const timer = setTimeout(() => {
        // Grace expired without reconnect → escalate to offline.
        if (nodeId) registry.setStatus(nodeId, "offline");
        pending.delete(nodeName);
      }, reconnectGraceMs);
      pending.set(nodeName, { since: Date.now(), timer });
      return { nodeName, commandId, status: "rebooting" };
    },

    /** Called by the registry when a node re-attaches its session after boot. */
    onReconnect(nodeName) {
      const p = pending.get(nodeName);
      if (!p) return false;
      clearTimeout(p.timer);
      pending.delete(nodeName);
      emit("agent_reconnected", { nodeName, message: `reconnected in ${Math.round((Date.now() - p.since) / 1000)}s` });
      return true;
    },

    isRebooting(nodeName) {
      return pending.has(nodeName);
    },
  };
}
