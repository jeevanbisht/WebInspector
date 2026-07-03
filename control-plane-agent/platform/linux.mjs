// Linux platform provider (systemd).
//
// - Service:     a systemd unit (Restart=always, WantedBy=multi-user.target) so the supervisor
//                auto-starts and survives reboot.
// - Reboot:      `shutdown -r` (the enabled unit re-registers after boot).
// - Atomic swap: symlink flip via rename() over `current` — atomic on POSIX (no race window).
// - Download:    fetch + SHA-256 verify (shared with the data plane).
// - Extract:     tar (.tar/.tar.gz) or unzip (.zip).
//
// The command/unit builders are exported as pure functions so they can be unit-tested without
// a Linux host; full lifecycle (systemctl/shutdown) verification requires one.

import { spawn } from "node:child_process";
import { mkdir, symlink, rename, writeFile, rm } from "node:fs/promises";
import { PlatformProvider } from "./contract.mjs";
import { run, downloadToFile } from "./exec.mjs";

export class LinuxPlatform extends PlatformProvider {
  get name() {
    return "linux";
  }

  async reboot({ delaySeconds = 5, reason = "WebInspector control-plane reboot" } = {}) {
    const [cmd, args] = rebootArgs(delaySeconds, reason);
    await run(cmd, args);
    return { rebooting: true, delaySeconds };
  }

  async installService({ name = "webinspector-controlplane-agent", execStart, binPath, user = "root", workingDirectory, environment } = {}) {
    const exec = execStart || binPath;
    if (!exec) throw new Error("installService requires execStart or binPath");
    const unit = systemdUnit({ execStart: exec, user, workingDirectory, environment });
    const unitPath = `/etc/systemd/system/${name}.service`;
    await writeFile(unitPath, unit, "utf8");
    await run("systemctl", ["daemon-reload"]);
    await run("systemctl", ["enable", name]);
    return { installed: name, unitPath };
  }

  startService(name) {
    return run("systemctl", ["start", name]);
  }
  stopService(name) {
    return run("systemctl", ["stop", name]);
  }
  restartService(name) {
    return run("systemctl", ["restart", name]);
  }

  async startProcess({ command, args = [], cwd, env } = {}) {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, detached: false });
    return { pid: child.pid, handle: child };
  }
  async stopProcess(handle, { force = false } = {}) {
    const pid = handle?.pid || handle;
    if (!pid) return;
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  async swapCurrent(linkPath, targetDir) {
    // Create a temp symlink, then rename() it over `current` — an atomic replace on POSIX.
    const tmp = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
    await rm(tmp, { force: true }).catch(() => {});
    try {
      await symlink(targetDir, tmp, "dir");
    } catch {
      await symlink(targetDir, tmp);
    }
    await rename(tmp, linkPath);
    return { linkPath, targetDir };
  }

  async downloadFile(url, destPath, opts = {}) {
    return downloadToFile(url, destPath, opts);
  }

  async extractBundle(bundlePath, destDir) {
    await mkdir(destDir, { recursive: true });
    const [cmd, args] = extractArgs(bundlePath, destDir);
    await run(cmd, args);
    return { destDir };
  }

  async isElevated() {
    return typeof process.geteuid === "function" && process.geteuid() === 0;
  }
}

// --- pure builders (unit-testable) ---

export function systemdUnit({ description = "WebInspector ControlPlane Agent", execStart, user = "root", workingDirectory, environment = {} } = {}) {
  if (!execStart) throw new Error("systemdUnit requires execStart");
  const envLines = Object.entries(environment || {}).map(([k, v]) => `Environment=${k}=${v}`);
  return [
    "[Unit]",
    `Description=${description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    ...(workingDirectory ? [`WorkingDirectory=${workingDirectory}`] : []),
    `User=${user}`,
    ...envLines,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function rebootArgs(delaySeconds = 0, reason = "reboot") {
  // `shutdown -r` uses minute granularity; sub-minute delays reboot ~now.
  const when = delaySeconds >= 60 ? `+${Math.round(delaySeconds / 60)}` : "now";
  return ["shutdown", ["-r", when, reason]];
}

export function extractArgs(bundlePath, destDir) {
  if (/\.tar\.gz$|\.tgz$/i.test(bundlePath)) return ["tar", ["-xzf", bundlePath, "-C", destDir]];
  if (/\.tar$/i.test(bundlePath)) return ["tar", ["-xf", bundlePath, "-C", destDir]];
  return ["unzip", ["-o", "-q", bundlePath, "-d", destDir]];
}
