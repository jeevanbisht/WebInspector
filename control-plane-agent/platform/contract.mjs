// PlatformProvider contract.
//
// The ControlPlane Agent (supervisor) does everything OS-specific through this interface,
// so the same supervisor logic runs on Windows (first), Linux, and Kubernetes. Concrete
// providers live alongside this file; `index.mjs` selects one at runtime.
//
// Node install layout (all platforms):
//   <installRoot>/
//     control-plane-agent/         supervisor (rarely updated; self-update special-cased)
//     agent/
//       versions/<version>/        immutable installed worker versions
//       current  ->  versions/<v>  atomic pointer flipped on update (junction / symlink)
//     state/                       durable local state (never wiped on update)

export class PlatformProvider {
  get name() {
    return "abstract";
  }

  /** Reboot the machine. Supervisor is an OS service, so it re-registers after boot. */
  async reboot(_opts = {}) {
    throw new Error("reboot not implemented for this platform");
  }

  /** Install the supervisor as an auto-start OS service (survives reboot). */
  async installService(_opts = {}) {
    throw new Error("installService not implemented for this platform");
  }

  async startService(_name) {
    throw new Error("startService not implemented");
  }
  async stopService(_name) {
    throw new Error("stopService not implemented");
  }
  async restartService(_name) {
    throw new Error("restartService not implemented");
  }

  /** Start the worker Agent process; returns a handle/pid. */
  async startProcess(_spec) {
    throw new Error("startProcess not implemented");
  }
  async stopProcess(_handle, _opts = {}) {
    throw new Error("stopProcess not implemented");
  }

  /**
   * Atomically point `linkPath` at `targetDir` (the A/B version swap). Implementations
   * must make this as close to atomic as the OS allows and document any race window.
   */
  async swapCurrent(_linkPath, _targetDir) {
    throw new Error("swapCurrent not implemented");
  }

  /** Download `url` to `destPath` and verify it matches `sha256` before returning. */
  async downloadFile(_url, _destPath, { sha256 } = {}) {
    throw new Error("downloadFile not implemented");
  }

  /** Extract an update bundle (zip) into `destDir`. */
  async extractBundle(_bundlePath, _destDir) {
    throw new Error("extractBundle not implemented");
  }

  /** True if the process has the privilege needed to install services / reboot. */
  async isElevated() {
    return false;
  }
}
