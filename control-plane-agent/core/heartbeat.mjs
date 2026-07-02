// Periodic heartbeat (supervisor side).
//
// Sends a lightweight liveness + status snapshot up the control channel. Kept SMALL (it is
// a control-plane message); bulk telemetry goes on the data plane. The ControlPlane marks a
// node unhealthy if heartbeats stop.

export function startHeartbeat({ connection, getSnapshot, intervalMs = 30000 } = {}) {
  let timer = null;

  function beat() {
    try {
      connection.sendUp("heartbeat", getSnapshot());
    } catch {
      // connection layer buffers/reconnects; nothing to do here
    }
  }

  return {
    start() {
      if (timer) return;
      beat();
      timer = setInterval(beat, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    beatNow: beat,
  };
}
