// Public IP discovery (worker side).
//
// The public egress IP is key evidence (which arm/path a node actually exits through). The
// lookup hits an external service, so it is gated by `allowLookup` to respect locked-down
// environments.

export async function getPublicIp({ allowLookup = true, timeoutMs = 5000 } = {}) {
  if (!allowLookup) return { publicIp: null, source: "disabled" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.ipify.org?format=json", { signal: controller.signal });
    if (!res.ok) return { publicIp: null, source: "error" };
    const body = await res.json();
    return { publicIp: body.ip || null, source: "ipify" };
  } catch {
    return { publicIp: null, source: "error" };
  } finally {
    clearTimeout(timer);
  }
}
