// Handle update_agent / update_control_plane_agent.
//
// Delegates to the updater, which downloads + verifies the bundle over the data plane, does
// an atomic A/B swap, health-gates the new version, and rolls back on failure. Updating the
// supervisor itself is special: it re-execs after swap, so this returns before the switch.

export async function handleUpdate({ updater, component, args, progress }) {
  const { version, bundle } = args;
  if (!version || !bundle?.url || !bundle?.sha256) throw new Error("update requires version + bundle {url, sha256}");
  progress?.(`updating ${component} → ${version}`);
  return updater.applyBundle({ component, version, bundle, onProgress: progress });
}
