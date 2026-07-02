// Installed-version marker (supervisor side).
//
// Each installed version directory carries a VERSION file. `current` is a junction/symlink
// to the active version dir, so reading `<current>/VERSION` yields the running version.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function readInstalledVersion(currentDir) {
  try {
    const v = await readFile(join(currentDir, "VERSION"), "utf8");
    return v.trim() || null;
  } catch {
    return null;
  }
}

export async function writeVersionMarker(versionDir, version) {
  await mkdir(versionDir, { recursive: true });
  await writeFile(join(versionDir, "VERSION"), `${version}\n`, "utf8");
  return version;
}
