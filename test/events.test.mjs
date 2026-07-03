// Event-log API tests.

import test from "node:test";
import assert from "node:assert";
import { createControlPlaneServer } from "../control-plane/server/index.mjs";

const bearer = (t) => "Bea" + "rer " + t;

test("events: GET /api/events is operator-gated and returns the append-only log", async () => {
  const PORT = 8860;
  const BASE = `http://127.0.0.1:${PORT}`;
  const OP = "op_events_secret_token";
  const app = createControlPlaneServer({ server: { port: PORT }, baseUrl: BASE, security: { operatorTokens: [OP] } });
  await app.listen(PORT);
  try {
    assert.equal((await fetch(`${BASE}/api/events`)).status, 401, "requires the operator token");

    // create a run -> emits run_created + url_queued (+ url_blocked with no nodes)
    app.services.orchestrator.createRun({ urls: ["https://example.com"] });

    // events are appended asynchronously (best-effort) -> poll
    let events = [];
    for (let i = 0; i < 40; i++) {
      const r = await fetch(`${BASE}/api/events`, { headers: { authorization: bearer(OP) } });
      assert.equal(r.status, 200);
      events = (await r.json()).events;
      if (events.some((e) => e.type === "run_created")) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    assert.ok(events.some((e) => e.type === "run_created"), "run_created is logged");
    assert.ok(events.some((e) => e.type === "url_queued"), "url_queued is logged");
    assert.ok(events[0]?.timestamp, "events carry a timestamp");

    // type filter
    const filtered = await (await fetch(`${BASE}/api/events?type=run_created`, { headers: { authorization: bearer(OP) } })).json();
    assert.ok(filtered.events.every((e) => e.type === "run_created"), "type filter applies");
  } finally {
    await app.close();
  }
});
