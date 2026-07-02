// Local JSON state adapter.
//
// Simple file-per-table JSON store for `Orch1`. Durable enough to survive process restarts;
// swap for SQLite/Azure Table/Postgres later behind the same interface. NOT for high
// concurrency — writes are serialized per table.
//
// TODO: crash-safe writes (temp file + rename), and an SQLite adapter as the durable target.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function localJsonAdapter(dir = "./state/db") {
  const cache = new Map(); // table -> { records: Map, events: [] }
  const locks = new Map(); // table -> Promise chain

  const fileFor = (table) => join(dir, `${table}.json`);

  async function load(table) {
    if (cache.has(table)) return cache.get(table);
    let data = { records: {}, events: [] };
    if (existsSync(fileFor(table))) data = JSON.parse(await readFile(fileFor(table), "utf8"));
    const entry = { records: new Map(Object.entries(data.records || {})), events: data.events || [] };
    cache.set(table, entry);
    return entry;
  }

  async function persist(table) {
    const entry = await load(table);
    const out = { records: Object.fromEntries(entry.records), events: entry.events };
    await mkdir(dir, { recursive: true });
    await writeFile(fileFor(table), `${JSON.stringify(out, null, 2)}\n`, "utf8"); // TODO: temp+rename
  }

  // serialize writes per table
  function withLock(table, fn) {
    const prev = locks.get(table) || Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(table, next.catch(() => {}));
    return next;
  }

  return {
    async init(tables = []) {
      await mkdir(dir, { recursive: true });
      for (const t of tables) await load(t);
    },
    async append(table, record) {
      return withLock(table, async () => {
        const entry = await load(table);
        entry.events.push(record);
        await persist(table);
        return record;
      });
    },
    async put(table, id, record) {
      return withLock(table, async () => {
        const entry = await load(table);
        entry.records.set(String(id), record);
        await persist(table);
        return record;
      });
    },
    async get(table, id) {
      const entry = await load(table);
      return entry.records.get(String(id)) || null;
    },
    async delete(table, id) {
      return withLock(table, async () => {
        const entry = await load(table);
        const existed = entry.records.delete(String(id));
        await persist(table);
        return existed;
      });
    },
    async query(table, filter = {}, { limit = Infinity, order = "asc" } = {}) {
      const entry = await load(table);
      const source = table === "events" ? entry.events : [...entry.records.values()];
      let rows = source.filter((r) => Object.entries(filter).every(([k, v]) => r?.[k] === v));
      if (order === "desc") rows = rows.reverse();
      return rows.slice(0, limit);
    },
  };
}
