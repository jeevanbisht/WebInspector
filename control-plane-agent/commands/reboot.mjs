// Handle reboot.
//
// Best practice: tell the ControlPlane we're going down (bye) BEFORE the OS call, so the
// Portal shows "rebooting" not "offline". The supervisor is an auto-start service, so it
// re-registers automatically after boot.

export async function handleReboot({ platform, connection, args, progress }) {
  progress?.("preparing reboot");
  try {
    connection.sendUp("bye", { reason: args?.reason || "reboot", expectReconnect: true });
  } catch {
    // best effort — proceed with reboot regardless
  }
  const res = await platform.reboot({ delaySeconds: args?.delaySeconds ?? 5, reason: args?.reason });
  return { rebooting: true, ...res };
}
