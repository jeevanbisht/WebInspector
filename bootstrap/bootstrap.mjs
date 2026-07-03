// Zero-touch node bootstrap orchestrator.
//
// Small, cross-platform, and scriptable. Onboards a fresh VM into the control plane:
//   1. fetch the desired supervisor version + bundle reference from the ControlPlane
//   2. download the supervisor bundle over the data plane and VERIFY it (SHA-256)
//   3. install the supervisor as an auto-start OS service (reuses the platform provider)
//   4. enroll the node (exchange the enrollment token for a durable node credential)
//   5. start the service — the supervisor connects and the reconciler does the rest
//
// Run by windows/install.ps1 (or Linux/K8s equivalents later):
//   node bootstrap.mjs --url http://cp:8787 --token <enrollmentToken> --node-type azure_direct
//
// Everything heavy is delegated to the platform provider so onboarding matches updates.

import os from "node:os";
import { join } from "node:path";
import { getPlatformProvider } from "../control-plane-agent/platform/index.mjs";
import { enrollNode, persistIdentity } from "./enroll.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
  }
  return args;
}

export async function bootstrap(opts = {}) {
  const controlPlaneUrl = (opts.url || process.env.WEBINSPECTOR_CONTROLPLANE_URL || "").replace(/\/$/, "");
  const enrollmentToken = opts.token || process.env.WEBINSPECTOR_ENROLLMENT_TOKEN;
  const nodeType = opts.nodeType || opts["node-type"] || process.env.WEBINSPECTOR_NODE_TYPE;
  const nodeName = opts.nodeName || opts["node-name"] || process.env.WEBINSPECTOR_NODE_NAME || os.hostname();
  const installRoot = opts.installRoot || process.env.WEBINSPECTOR_INSTALL_ROOT || defaultInstallRoot();

  if (!controlPlaneUrl) throw new Error("control plane url is required (--url / WEBINSPECTOR_CONTROLPLANE_URL)");
  if (!enrollmentToken) throw new Error("enrollment token is required (--token / WEBINSPECTOR_ENROLLMENT_TOKEN)");
  if (!nodeType) throw new Error("node type is required (--node-type / WEBINSPECTOR_NODE_TYPE)");

  const platform = getPlatformProvider();
  if (!(await platform.isElevated())) {
    throw new Error("bootstrap must run elevated (needs to install a service / reboot rights)");
  }

  // 1. Manifest: desired supervisor version + bundle reference.
  const manifest = await getJson(`${controlPlaneUrl}/bootstrap/manifest`);
  const bundle = manifest?.supervisor?.bundle;
  if (!bundle?.url || !bundle?.sha256) throw new Error("bootstrap manifest missing supervisor bundle reference");

  // 2. Download + verify (data plane).
  const versionsDir = join(installRoot, "control-plane-agent", "versions", manifest.supervisor.version);
  const bundlePath = join(installRoot, "control-plane-agent", `supervisor-${manifest.supervisor.version}.zip`);
  const url = bundle.url.startsWith("http") ? bundle.url : `${controlPlaneUrl}${bundle.url}`;
  await platform.downloadFile(url, bundlePath, { sha256: bundle.sha256 });
  // TODO: verify bundle.signature against the ControlPlane's trusted public key.
  await platform.extractBundle(bundlePath, versionsDir);
  await platform.swapCurrent(join(installRoot, "control-plane-agent", "current"), versionsDir);

  // 3. Install the supervisor as an auto-start service (survives reboot). Use the absolute
  // node path so systemd's ExecStart (and the Windows service) resolve without relying on PATH.
  const currentDir = join(installRoot, "control-plane-agent", "current");
  await platform.installService({
    name: "WebInspectorControlPlaneAgent",
    binPath: `"${process.execPath}" "${join(currentDir, "core", "index.mjs")}"`,
  });

  // 4. Enroll: exchange the token for a durable node credential.
  const identity = { nodeName, nodeType, platform: platform.name, machineId: os.hostname(), os: `${os.type()} ${os.release()}` };
  const enrollment = await enrollNode(controlPlaneUrl, enrollmentToken, identity);
  await persistIdentity(installRoot, { ...identity, controlPlaneUrl, ...enrollment });

  // 5. Start — supervisor connects; reconciler converges the node (zero touch from here).
  await platform.startService("WebInspectorControlPlaneAgent");

  return { nodeName, nodeType, controlPlaneUrl, supervisorVersion: manifest.supervisor.version, enrolled: true };
}

function defaultInstallRoot() {
  return process.platform === "win32" ? "C:\\WebInspector" : "/opt/webinspector";
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json();
}

// CLI entry.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("bootstrap.mjs")) {
  bootstrap(parseArgs())
    .then((r) => {
      console.log(`[bootstrap] onboarded ${r.nodeName} (${r.nodeType}) → ${r.controlPlaneUrl}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(`[bootstrap] failed: ${e.message}`);
      process.exit(1);
    });
}
