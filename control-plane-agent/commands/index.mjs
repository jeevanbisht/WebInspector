// Command router (supervisor side).
//
// Receives DOWN `command` envelopes, executes them IDEMPOTENTLY (deduped by commandId),
// and reports progress UP via `command_result` (accepted → in_progress → succeeded/failed).
// This is the heart of central control: every management action funnels through here.

import { makeCommandResult } from "../../shared/contracts/commands.mjs";
import { handleUpdate } from "./update.mjs";
import { handleReboot } from "./reboot.mjs";
import { handleRestartWorker } from "./restart-worker.mjs";
import { handleDrain, handleUndrain } from "./drain.mjs";

export function createCommandRouter({ platform, workerManager, updater, connection, identity, logger = console } = {}) {
  const seen = new Map(); // commandId -> last status (idempotency + replay safety)

  function report(commandId, status, extra = {}) {
    connection.sendUp("command_result", makeCommandResult(commandId, status, extra), { correlationId: commandId });
  }

  async function handle(envelope) {
    const command = envelope.payload;
    const { commandId, command: verb, args = {} } = command;

    // Idempotency: if we already finished this command, re-ack its terminal status.
    const prior = seen.get(commandId);
    if (prior && ["succeeded", "failed", "rejected"].includes(prior)) return report(commandId, prior);
    if (prior === "in_progress") return; // still running; ignore duplicate

    seen.set(commandId, "in_progress");
    report(commandId, "accepted");

    const ctx = { platform, workerManager, updater, connection, identity, args, commandId, progress: (m) => report(commandId, "in_progress", { message: m }) };

    try {
      const result = await dispatch(verb, ctx);
      seen.set(commandId, "succeeded");
      report(commandId, "succeeded", { data: result || {} });
    } catch (e) {
      seen.set(commandId, "failed");
      logger.error?.(`[command] ${verb} failed: ${e.message}`);
      report(commandId, "failed", { error: e.message });
    }
  }

  async function dispatch(verb, ctx) {
    switch (verb) {
      case "update_agent":
        return handleUpdate({ ...ctx, component: "agent" });
      case "update_control_plane_agent":
        return handleUpdate({ ...ctx, component: "control-plane-agent" });
      case "reboot":
        return handleReboot(ctx);
      case "restart_worker":
        return handleRestartWorker(ctx);
      case "drain":
        return handleDrain(ctx);
      case "undrain":
        return handleUndrain(ctx);
      case "dispatch_job":
        return ctx.workerManager.runJob(ctx.args.job);
      case "cancel_job":
        return ctx.workerManager.cancelJob(ctx.args.jobId);
      case "set_config":
        return ctx.workerManager.applyConfig(ctx.args.config);
      case "collect_diagnostics":
        return ctx.workerManager.collectDiagnostics?.() || { note: "diagnostics not implemented" };
      case "ping":
        return { pong: true };
      default:
        throw new Error(`unknown command: ${verb}`);
    }
  }

  return { handle };
}
