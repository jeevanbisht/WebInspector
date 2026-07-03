// In-memory state adapter.
//
// Same interface as localJsonAdapter (init/append/put/get/delete/query) but backed by Maps
// with no disk I/O. This is the default for embedded + test usage; it is NOT durable across
// a restart. Swap in localJsonAdapter (or a future SQLite/Postgres adapter) for durability.

export function memoryAdapter() {
  const tables = new Map(); // table -> { records: Map, events: [] }

  const entry = (table) => {
    if (!tables.has(table)) tables.set(table, { records: new Map(), events: [] });
    return tables.get(table);
  };

  return {
    async init(list = []) {
      for (const t of list) entry(t);
    },
    async append(table, record) {
      entry(table).events.push(record);
      return record;
    },
    async put(table, id, record) {
      entry(table).records.set(String(id), record);
      return record;
    },
    async get(table, id) {
      return entry(table).records.get(String(id)) || null;
    },
    async delete(table, id) {
      return entry(table).records.delete(String(id));
    },
    async query(table, filter = {}, { limit = Infinity, order = "asc" } = {}) {
      const e = entry(table);
      const source = table === "events" ? e.events : [...e.records.values()];
      let rows = source.filter((r) => Object.entries(filter).every(([k, v]) => r?.[k] === v));
      if (order === "desc") rows = [...rows].reverse();
      return rows.slice(0, limit);
    },
  };
}
