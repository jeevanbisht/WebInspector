// Linux platform provider (STUB — implement after Windows).
//
// Intended mapping:
//   - Service:     systemd unit (Restart=always, WantedBy=multi-user.target) so the
//                  supervisor auto-starts and survives reboot.
//   - Reboot:      systemctl reboot  (or `shutdown -r`).
//   - Atomic swap: symlink flip via rename() over `current` — atomic on POSIX.
//   - Download:    fetch + SHA-256 verify (same as Windows).
//   - Extract:     tar/unzip.

import { PlatformProvider } from "./contract.mjs";

const TODO = "LinuxPlatform not implemented yet (Windows-first). See file header for the intended mapping.";

export class LinuxPlatform extends PlatformProvider {
  get name() {
    return "linux";
  }
  async reboot() {
    throw new Error(TODO);
  }
  async installService() {
    throw new Error(TODO);
  }
  async swapCurrent() {
    // NOTE: on Linux this becomes a truly atomic symlink swap via rename().
    throw new Error(TODO);
  }
  async downloadFile() {
    throw new Error(TODO);
  }
  async extractBundle() {
    throw new Error(TODO);
  }
}
