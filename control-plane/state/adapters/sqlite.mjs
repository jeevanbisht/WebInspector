// SQLite state adapter.
//
// Durable, indexed, transactional alternative to localJsonAdapter behind the SAME interface
// (init/append/put/get/delete/query). One `.db` file: records live as JSON in `rec_<table>`
// (upserted by id, with an expression index on `$.runId` for the hot report/query path), and
// the append-only event log lives in `events`. Unlike localJson it never rewrites a whole file
// per write — it does an indexed upsert.
//
// Uses Node's built-in `node:sqlite` (no native dependency). It is loaded lazily inside the
// factory so the experimental-module warning only fires when this adapter is actually used.

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function sqliteAdapter(dir = "./state/db", { file = "state.db" } = {}) {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite");

  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, file));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)");

  const ready = new Set();
  const stmtCache = new Map();
  const prep = (sql) => {
    let s = stmtCache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      stmtCache.set(sql, s);
    }
    return s;
  };

  const recTable = (table) => `rec_${ident(table)}`;

  function ensure(table) {
    if (table === "events" || ready.has(table)) return;
    const t = recTable(table);
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${t}_runid ON ${t} (json_extract(data,'$.runId'))`);
    ready.add(table);
  }

  function run(table, filter, { limit = Infinity, order = "asc" } = {}) {
    const keys = Object.keys(filter || {});
    const where = keys.length ? ` WHERE ${keys.map((k) => `json_extract(data,'$.${ident(k)}')=?`).join(" AND ")}` : "";
    const params = keys.map((k) => param(filter[k]));
    const dir = order === "desc" ? "DESC" : "ASC";
    const orderCol = table === "events" ? "seq" : "rowid";
    const source = table === "events" ? "events" : recTable(table);
    const limited = Number.isFinite(limit);
    const sql = `SELECT data FROM ${source}${where} ORDER BY ${orderCol} ${dir}${limited ? " LIMIT ?" : ""}`;
    const rows = prep(sql).all(...(limited ? [...params, limit] : params));
    return rows.map((r) => JSON.parse(r.data));
  }

  return {
    async init(tables = []) {
      for (const t of tables) ensure(t);
    },
    async append(table, record) {
      prep("INSERT INTO events(data) VALUES(?)").run(JSON.stringify(record));
      return record;
    },
    async put(table, id, record) {
      ensure(table);
      prep(`INSERT INTO ${recTable(table)}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(String(id), JSON.stringify(record));
      return record;
    },
    async get(table, id) {
      ensure(table);
      const row = prep(`SELECT data FROM ${recTable(table)} WHERE id=?`).get(String(id));
      return row ? JSON.parse(row.data) : null;
    },
    async delete(table, id) {
      ensure(table);
      return prep(`DELETE FROM ${recTable(table)} WHERE id=?`).run(String(id)).changes > 0;
    },
    async query(table, filter = {}, opts = {}) {
      if (table !== "events") ensure(table);
      return run(table, filter, opts);
    },
    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}

// Table/field names come from code (TABLES + fixed filter keys), never user input; sanitize
// anyway so they can be safely inlined into DDL/queries.
function ident(name) {
  const s = String(name).replace(/[^A-Za-z0-9_]/g, "");
  if (!s) throw new Error(`invalid identifier: ${name}`);
  return s;
}

function param(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return typeof v === "number" || typeof v === "bigint" ? v : String(v);
}
