// ControlPlane Agent (supervisor) entrypoint + loop.
//
// Boot sequence:
//   1. load node identity (written by the bootstrap at enrollment)
//   2. select the platform provider (Windows first)
//   3. bring up the worker Agent at the installed version
//   4. connect the control channel; on open → hello; then heartbeat
//   5. route inbound commands idempotently; report results up
//
// This is deliberately thin: heavy lifting lives in worker-manager, updater, and platform.

import { readFile } from "node:fs/promises";
import { loadSupervisorConfig, defaultInstallRoot } from "../config.mjs";
import { getPlatformProvider } from "../platform/index.mjs";
import { createConnection } from "./connection.mjs";
import { buildHello } from "./register.mjs";
import { startHeartbeat } from "./heartbeat.mjs";
import { createWorkerManager } from "../worker-manager/lifecycle.mjs";
import { createUpdater } from "../updater/apply-bundle.mjs";
import { readInstalledVersion } from "../updater/version.mjs";
import { createCommandRouter } from "../commands/index.mjs";
import { isDownMessage } from "../../shared/protocol/control-channel.mjs";
import { versionSnapshot } from "../../shared/contracts/versions.mjs";
import { collectNodeInfo } from "./node-info.mjs";

export async function main({ installRoot = process.env.WEBINSPECTOR_INSTALL_ROOT || defaultInstallRoot() } = {}) {
  const config = loadSupervisorConfig(installRoot);
  const identity = JSON.parse(await readFile(config.paths.identityFile, "utf8"));
  const platform = getPlatformProvider();

  const workerEnv = {
    ...process.env,
    WEBINSPECTOR_CONTROLPLANE_URL: identity.controlPlaneUrl,
    WEBINSPECTOR_NODE_ID: identity.nodeId,
    WEBINSPECTOR_NODE_CREDENTIAL: identity.nodeCredential,
  };
  const workerManager = createWorkerManager({
    platform,
    paths: config.paths,
    intervals: config.intervals,
    env: workerEnv,
    // Forward each worker result UP the control channel as a small summary; bulk bodies +
    // artifacts already went to the data plane directly from the worker.
    onResult: (msg) => connection.sendUp("result", summarizeResult(msg)),
  });
  const updater = createUpdater({ platform, paths: config.paths, workerManager, healthGateMs: config.healthGateMs, controlPlaneUrl: identity.controlPlaneUrl });

  const installedVersions = {
    controlPlaneAgentVersion: await readInstalledVersion(config.paths.supervisorCurrent),
    agentVersion: await readInstalledVersion(config.paths.agentCurrent),
  };

  // Ensure the worker is running before we advertise readiness.
  await workerManager.ensureRunning(installedVersions.agentVersion);

  // Collect the node's IPs once at startup so the ControlPlane/Portal can show them.
  const nodeInfo = await collectNodeInfo();

  const connection = createConnection({
    controlPlaneUrl: identity.controlPlaneUrl,
    controlChannelPath: identity.controlChannelUrl || "/agent/channel",
    nodeId: identity.nodeId,
    nodeCredential: identity.nodeCredential,
    intervals: config.intervals,
    onOpen: () => connection.sendUp("hello", buildHello({ identity, installedVersions, metadata: { privateIp: nodeInfo.privateIp, publicIp: nodeInfo.publicIp } })),
    onMessage: (msg) => {
      if (isDownMessage(msg) && msg.type === "command") router.handle(msg);
    },
  });

  const router = createCommandRouter({ platform, workerManager, updater, connection, identity });

  const heartbeat = startHeartbeat({
    connection,
    intervalMs: config.intervals.heartbeatMs,
    getSnapshot: () => ({
      nodeType: identity.nodeType,
      status: workerManager.isDraining() ? "draining" : "ready",
      // Report the FULL version set (contracts/protocol/schema too), consistent with `hello`,
      // so the ControlPlane's selection compatibility gate stays satisfied across heartbeats.
      versions: versionSnapshot(installedVersions),
      metadata: { worker: workerManager.status(), privateIp: nodeInfo.privateIp, publicIp: nodeInfo.publicIp },
    }),
  });

  connection.start();
  heartbeat.start();

  const shutdown = () => {
    heartbeat.stop();
    connection.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { config, identity, connection, workerManager, updater, router, heartbeat };
}

// CLI entry (the installed service runs this).
if (process.argv[1]?.endsWith("core/index.mjs") || process.argv[1]?.endsWith("index.mjs")) {
  main().catch((e) => {
    console.error(`[supervisor] fatal: ${e.message}`);
    process.exit(1);
  });
}

// Trim a worker result to a small control-plane summary (bulk stays on the data plane).
function summarizeResult(msg) {
  const r = msg.result || {};
  return {
    jobId: msg.jobId || null,
    stage: r.stage || null,
    nodeName: r.nodeName || null,
    url: r.url || null,
    ok: r.ok ?? null,
    reason: r.reason || null,
    error: msg.error || null,
  };
}
