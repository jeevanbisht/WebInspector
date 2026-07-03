// Platform-provider tests.
//
// The Linux + Kubernetes providers are real (systemd / pod lifecycle). Full systemctl/shutdown/
// kubectl execution needs those hosts; here we test what's host-agnostic: provider selection,
// the real SHA-256-verifying downloader, and the pure command/unit builders.

import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProvider, detectPlatform } from "../control-plane-agent/platform/index.mjs";
import { LinuxPlatform, systemdUnit, rebootArgs, extractArgs } from "../control-plane-agent/platform/linux.mjs";
import { KubernetesPlatform, podDeleteArgs } from "../control-plane-agent/platform/kubernetes.mjs";

test("platform selection: env override + K8s detection + host default", () => {
  assert.equal(detectPlatform({ WEBINSPECTOR_PLATFORM: "linux" }), "linux");
  assert.equal(detectPlatform({ KUBERNETES_SERVICE_HOST: "10.0.0.1" }), "kubernetes");
  assert.equal(getPlatformProvider({ WEBINSPECTOR_PLATFORM: "linux" }).name, "linux");
  assert.equal(getPlatformProvider({ WEBINSPECTOR_PLATFORM: "kubernetes" }).name, "kubernetes");
  assert.equal(getPlatformProvider({ WEBINSPECTOR_PLATFORM: "windows" }).name, "windows");
});

test("LinuxPlatform.downloadFile: streams + verifies SHA-256, rejects a mismatch", async (t) => {
  const payload = Buffer.from("fake update bundle bytes");
  const sha = createHash("sha256").update(payload).digest("hex");
  const srv = http.createServer((req, res) => {
    res.writeHead(200);
    res.end(payload);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const dir = await mkdtemp(join(tmpdir(), "wi-plat-"));
  t.after(async () => {
    srv.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const linux = new LinuxPlatform();
  const dest = join(dir, "bundle.zip");
  const ok = await linux.downloadFile(`http://127.0.0.1:${port}/b`, dest, { sha256: sha });
  assert.equal(ok.sha256, sha);
  assert.deepEqual(await readFile(dest), payload);

  const badDest = join(dir, "bad.zip");
  await assert.rejects(() => linux.downloadFile(`http://127.0.0.1:${port}/b`, badDest, { sha256: "deadbeef" }), /sha256 mismatch/);
  assert.equal(existsSync(badDest), false, "a mismatched download is removed");
});

test("LinuxPlatform: systemd unit + reboot + extract builders", () => {
  const unit = systemdUnit({ execStart: "/usr/bin/node /opt/wi/index.mjs", user: "wi", workingDirectory: "/opt/wi", environment: { WEBINSPECTOR_PLATFORM: "linux" } });
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/wi\/index\.mjs/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /WantedBy=multi-user\.target/);
  assert.match(unit, /Environment=WEBINSPECTOR_PLATFORM=linux/);
  assert.throws(() => systemdUnit({}), /execStart/);

  assert.deepEqual(rebootArgs(5), ["shutdown", ["-r", "now", "reboot"]]);
  assert.deepEqual(rebootArgs(120)[1].slice(0, 2), ["-r", "+2"]);

  assert.deepEqual(extractArgs("x.zip", "/d"), ["unzip", ["-o", "-q", "x.zip", "-d", "/d"]]);
  assert.deepEqual(extractArgs("x.tar.gz", "/d"), ["tar", ["-xzf", "x.tar.gz", "-C", "/d"]]);
});

test("KubernetesPlatform: extends Linux + pod-delete command", async () => {
  const k8s = new KubernetesPlatform();
  assert.equal(k8s.name, "kubernetes");
  assert.equal(typeof k8s.downloadFile, "function", "inherits Linux file ops");
  assert.deepEqual((await k8s.installService()).installed, "managed-by-kubernetes");

  assert.deepEqual(podDeleteArgs({ HOSTNAME: "wi-agent-abc", POD_NAMESPACE: "webinspector" }), [
    "kubectl",
    ["delete", "pod", "wi-agent-abc", "-n", "webinspector", "--wait=false"],
  ]);
  assert.deepEqual(podDeleteArgs({ POD_NAME: "p1" }), ["kubectl", ["delete", "pod", "p1", "--wait=false"]]);
  assert.throws(() => podDeleteArgs({}), /pod name/);
});
