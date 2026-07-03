// Node network self-info (supervisor side).
//
// The supervisor reports the node's IP addresses to the ControlPlane so the Portal can show them.
// - privateIp: the first non-internal IPv4 (from the OS) — always available, no network call.
// - publicIp:  the egress IP a target site sees — a best-effort external lookup, gated by
//              WEBINSPECTOR_SKIP_METADATA_LOOKUPS so locked-down nodes stay offline-clean.
// Collected ONCE at startup (an IP rarely changes for a VM) and attached to hello + heartbeat.

import os from "node:os";

export function privateIpv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      const isV4 = a.family === "IPv4" || a.family === 4;
      if (!a.internal && isV4) return a.address;
    }
  }
  return null;
}

export async function publicEgressIp({ allowLookup = true, timeoutMs = 5000 } = {}) {
  if (!allowLookup) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.ipify.org?format=json", { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json())?.ip || null;
  } catch {
    return null; // best-effort: never fail startup over this
  } finally {
    clearTimeout(timer);
  }
}

export async function collectNodeInfo(env = process.env) {
  const allowLookup = env.WEBINSPECTOR_SKIP_METADATA_LOOKUPS !== "1";
  const publicIp = await publicEgressIp({ allowLookup });
  return { privateIp: privateIpv4(), publicIp };
}
