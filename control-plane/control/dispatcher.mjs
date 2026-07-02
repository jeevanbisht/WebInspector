// Command dispatcher (ControlPlane side).
//
// Sends commands DOWN the control channel and correlates the `command_result` that comes
// back UP. Tracks in-flight commands per node so the reconciler stays idempotent (it never
// issues a second update/config while one is pending).

import { downMessage } from "../../shared/protocol/control-channel.mjs";
import { makeCommand } from "../../shared/contracts/commands.mjs";
import { makeEvent } from "../../shared/contracts/events.mjs";

// Group related commands so idempotency checks can ask "is an update in flight?"
const CATEGORY = {
  update_agent: "update",
  update_control_plane_agent: "update",
  set_config: "set_config",
  reboot: "reboot",
  drain: "drain",
  undrain: "drain",
  dispatch_job: "job",
  cancel_job: "job",
};

export function createDispatcher({ registry, store = null, onEvent = null } = {}) {
  // nodeName -> Map<commandId, { command, category, sentAt, resolve, reject }>
  const inFlight = new Map();

  function bucket(nodeName) {
    if (!inFlight.has(nodeName)) inFlight.set(nodeName, new Map());
    return inFlight.get(nodeName);
  }

  function emit(type, fields) {
    const evt = makeEvent(type, fields);
    onEvent?.(evt);
    // TODO: store?.appendEvent(evt)
    return evt;
  }

  return {
    /** Send an already-built command object (from makeCommand / makeUpdateCommand). */
    async send(nodeName, command) {
      const category = CATEGORY[command.command] || command.command;
      bucket(nodeName).set(command.commandId, { command, category, sentAt: Date.now() });
      registry.send(nodeName, downMessage("command", command));
      emit("command_issued", { nodeName, commandId: command.commandId, message: command.command });
      return command.commandId;
    },

    /** Convenience: build + send. */
    sendCommand(nodeName, commandName, args = {}, opts = {}) {
      return this.send(nodeName, makeCommand(commandName, args, opts));
    },

    /** Idempotency guard used by the reconciler. `category` e.g. "update", "set_config". */
    hasInFlightCommand(nodeName, category) {
      const b = inFlight.get(nodeName);
      if (!b) return false;
      for (const rec of b.values()) if (rec.category === category) return true;
      return false;
    },

    /** Resolve an in-flight command from an UP `command_result`. */
    onCommandResult(nodeName, result) {
      const b = inFlight.get(nodeName);
      const rec = b?.get(result.commandId);
      if (!rec) return null;
      // terminal statuses clear the slot; interim (accepted/in_progress) keep it
      if (["succeeded", "failed", "rejected", "superseded"].includes(result.status)) {
        b.delete(result.commandId);
        emit(result.status === "succeeded" ? "command_succeeded" : "command_failed", {
          nodeName,
          commandId: result.commandId,
          message: rec.command.command,
          data: { status: result.status, error: result.error },
        });
      }
      return { command: rec.command, status: result.status };
    },

    listInFlight(nodeName) {
      return [...(inFlight.get(nodeName)?.values() || [])].map((r) => ({ commandId: r.command.commandId, command: r.command.command, category: r.category, sentAt: r.sentAt }));
    },
  };
}
