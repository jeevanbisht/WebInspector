// Azure Instance Metadata Service (IMDS) lookup (worker side).
//
// Best-effort: returns Azure VM metadata when running on an Azure VM, else null. Uses the
// non-routable IMDS endpoint with a short timeout so it fails fast off-Azure.

export async function getAzureMetadata({ timeoutMs = 2000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("http://169.254.169.254/metadata/instance?api-version=2021-02-01", {
      headers: { Metadata: "true" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const c = body?.compute || {};
    const net = body?.network?.interface?.[0]?.ipv4?.ipAddress?.[0] || {};
    return {
      vmName: c.name,
      vmId: c.vmId,
      location: c.location,
      resourceGroup: c.resourceGroupName,
      subscriptionId: c.subscriptionId,
      vmSize: c.vmSize,
      privateIp: net.privateIpAddress,
      publicIp: net.publicIpAddress || null,
    };
  } catch {
    return null; // not on Azure, or IMDS unreachable
  } finally {
    clearTimeout(timer);
  }
}
