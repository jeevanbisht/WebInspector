// Tiny fixed-window rate limiter (in-memory, per-key).
//
// Guards unauthenticated / abuse-prone endpoints (e.g. enrollment) against floods. Per-key
// (usually client IP): up to `max` requests per `windowMs`, then deny until the window rolls.
// Single-instance; a multi-instance deployment would back this with a shared store.

export function createRateLimiter({ windowMs = 60000, max = 60 } = {}) {
  const hits = new Map(); // key -> { count, resetAt }

  return {
    /** Returns true if the request is allowed (and counts it), false if over the limit. */
    allow(key) {
      const now = Date.now();
      const rec = hits.get(String(key));
      if (!rec || now > rec.resetAt) {
        hits.set(String(key), { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (rec.count >= max) return false;
      rec.count += 1;
      return true;
    },

    /** Drop stale windows to bound memory. */
    sweep(now = Date.now()) {
      for (const [k, rec] of hits) if (now > rec.resetAt) hits.delete(k);
    },
  };
}
