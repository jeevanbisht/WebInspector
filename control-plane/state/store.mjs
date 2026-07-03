// Durable state store (ControlPlane side).
//
// A thin, adapter-backed store so the same API/dashboard can later run on SQLite, Azure
// Table, or Postgres without touching call sites. Start with the local-json adapter.
//
// Logical tables:
//   runs, nodes, run_node_selection, urls, jobs, events (append-only),
//   results, comparisons, artifacts, commands, enrollments, node_update_events

import { makeEvent } from "../../shared/contracts/events.mjs";

export const TABLES = Object.freeze([
  "runs",
  "nodes",
  "run_node_selection",
  "urls",
  "jobs",
  "events",
  "results",
  "comparisons",
  "artifacts",
  "commands",
  "enrollments",
  "node_update_events",
]);

export function createStateStore(adapter) {
  if (!adapter) throw new Error("state store requires an adapter");

  return {
    async init() {
      await adapter.init(TABLES);
    },

    // append-only event log
    async appendEvent(type, fields = {}) {
      const evt = fields.eventId && fields.type ? fields : makeEvent(type, fields);
      await adapter.append("events", evt);
      return evt;
    },
    async listEvents(filter = {}, limit = 100) {
      return adapter.query("events", filter, { limit, order: "desc" });
    },

    // generic entity access
    async put(table, id, record) {
      assertTable(table);
      return adapter.put(table, id, { ...record, id });
    },
    async get(table, id) {
      assertTable(table);
      return adapter.get(table, id);
    },
    async list(table, filter = {}) {
      assertTable(table);
      return adapter.query(table, filter);
    },
    async delete(table, id) {
      assertTable(table);
      return adapter.delete(table, id);
    },
    async close() {
      await adapter.close?.();
    },
  };
}

function assertTable(table) {
  if (!TABLES.includes(table)) throw new Error(`unknown table: ${table}`);
}
