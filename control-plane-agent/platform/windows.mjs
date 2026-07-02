// Windows platform provider (implemented first).
//
// - Service:      Windows Service via sc.exe (auto-start so the supervisor survives reboot).
// - Reboot:       shutdown /r.
// - Atomic swap:  directory junction flipped via mklink /J (documented small race window).
// - Download:     global fetch streamed to disk + SHA-256 verify.
// - Extract:      Expand-Archive (built into Windows PowerShell).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PlatformProvider } from "./contract.mjs";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve({ code, stdout, stderr }) : reject(new Error(`${cmd} exited ${code}: ${stderr || stdout}`)),
    );
  });
}

const ps = (script) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

export class WindowsPlatform extends PlatformProvider {
  get name() {
    return "windows";
  }

  async reboot({ delaySeconds = 5, reason = "WebInspector control-plane reboot" } = {}) {
    // Supervisor is a Windows Service (auto-start), so it re-registers after boot.
    await run("shutdown.exe", ["/r", "/t", String(delaySeconds), "/c", reason]);
    return { rebooting: true, delaySeconds };
  }

  async installService({ name = "WebInspectorControlPlaneAgent", binPath, displayName = "WebInspector ControlPlane Agent" } = {}) {
    if (!binPath) throw new Error("installService requires binPath");
    // Auto-start service. For a Node entrypoint, wrap with a service host (e.g. nssm) or a
    // scheduled task; sc.exe shown here for the native-exe case.
    await run("sc.exe", ["create", name, `binPath=${binPath}`, "start=", "auto", "DisplayName=", displayName]);
    await run("sc.exe", ["failure", name, "reset=", "0", "actions=", "restart/5000/restart/5000/restart/5000"]);
    return { installed: name };
  }

  startService(name) {
    return run("sc.exe", ["start", name]);
  }
  stopService(name) {
    return run("sc.exe", ["stop", name]);
  }
  async restartService(name) {
    await this.stopService(name).catch(() => {});
    return this.startService(name);
  }

  async startProcess({ command, args = [], cwd, env } = {}) {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, detached: false });
    return { pid: child.pid, handle: child };
  }
  async stopProcess(handle, { force = false } = {}) {
    const pid = handle?.pid || handle;
    if (!pid) return;
    await run("taskkill.exe", force ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"]).catch(() => {});
  }

  async swapCurrent(linkPath, targetDir) {
    // Junction swap. Windows can't atomically replace an existing directory junction, so
    // we remove-then-recreate. The window is microseconds and the worker is drained during
    // update, so no job observes a half-swapped state. TODO: consider a two-junction flip.
    await rm(linkPath, { recursive: true, force: true }).catch(() => {});
    await run("cmd.exe", ["/c", "mklink", "/J", linkPath, targetDir]);
    return { linkPath, targetDir };
  }

  async downloadFile(url, destPath, { sha256 } = {}) {
    await mkdir(dirname(destPath), { recursive: true });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed ${res.status} for ${url}`);
    const hash = createHash("sha256");
    const out = createWriteStream(destPath);
    const body = Readable.fromWeb(res.body);
    body.on("data", (chunk) => hash.update(chunk));
    await pipeline(body, out);
    const digest = hash.digest("hex");
    if (sha256 && digest.toLowerCase() !== String(sha256).toLowerCase()) {
      await rm(destPath, { force: true }).catch(() => {});
      throw new Error(`sha256 mismatch for ${url}: got ${digest}, expected ${sha256}`);
    }
    return { destPath, sha256: digest };
  }

  async extractBundle(bundlePath, destDir) {
    await mkdir(destDir, { recursive: true });
    await ps(`Expand-Archive -Path '${bundlePath}' -DestinationPath '${destDir}' -Force`);
    return { destDir };
  }

  async isElevated() {
    try {
      const { stdout } = await ps(
        "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
      );
      return /true/i.test(stdout);
    } catch {
      return false;
    }
  }
}
