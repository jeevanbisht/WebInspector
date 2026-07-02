// Platform selection.
//
// Detects the host platform and returns the matching PlatformProvider. Windows is
// implemented first; Linux and Kubernetes are stubbed with clear guidance so they can be
// filled in without changing any supervisor logic.

import os from "node:os";
import { WindowsPlatform } from "./windows.mjs";
import { LinuxPlatform } from "./linux.mjs";
import { KubernetesPlatform } from "./kubernetes.mjs";

export function detectPlatform(env = process.env) {
  if (env.WEBINSPECTOR_PLATFORM) return env.WEBINSPECTOR_PLATFORM; // explicit override
  if (env.KUBERNETES_SERVICE_HOST) return "kubernetes"; // running inside a pod
  const p = os.platform();
  if (p === "win32") return "windows";
  if (p === "linux") return "linux";
  throw new Error(`unsupported platform: ${p}`);
}

export function getPlatformProvider(env = process.env) {
  const platform = detectPlatform(env);
  switch (platform) {
    case "windows":
      return new WindowsPlatform();
    case "linux":
      return new LinuxPlatform();
    case "kubernetes":
      return new KubernetesPlatform();
    default:
      throw new Error(`no provider for platform: ${platform}`);
  }
}
