// Build an immutable, content-addressed update bundle for a component.
//
// New agent/supervisor versions are packaged here as they are developed, then registered
// with the ControlPlane's bundle registry so they can be pushed centrally. The bundle is a
// zip; its SHA-256 is what the supervisor verifies before applying.
//
// Usage:
//   node deploy/scripts/build-bundle.mjs --component agent --version 3.1.0 --src ./agent [--out ./dist]
//
// Output: <out>/<component>-<version>.zip + <component>-<version>.manifest.json
// Pass --signing-key <pem-file> (or WEBINSPECTOR_BUNDLE_SIGNING_KEY_FILE) to sign the bundle;
// the ed25519 signature is emitted into the manifest and published via x-bundle-signature.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { signBundle } from "../../shared/protocol/bundle-signing.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[++i];
  return a;
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { windowsHide: true });
    let err = "";
    c.stderr?.on("data", (d) => (err += d));
    c.on("error", rej);
    c.on("close", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}: ${err}`))));
  });
}

async function zipDir(srcDir, outZip) {
  if (process.platform === "win32") {
    await run("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${outZip}' -Force`]);
  } else {
    await run("zip", ["-r", "-q", outZip, "."], { cwd: srcDir }); // requires `zip`
  }
}

async function main() {
  const args = parseArgs();
  const component = args.component;
  const version = args.version;
  const src = resolve(args.src || `./${component}`);
  const outDir = resolve(args.out || "./dist");
  if (!["agent", "control-plane-agent"].includes(component)) throw new Error("--component must be agent|control-plane-agent");
  if (!version) throw new Error("--version is required");

  await mkdir(outDir, { recursive: true });
  const zipPath = join(outDir, `${component}-${version}.zip`);
  console.log(`[build-bundle] zipping ${src} → ${zipPath}`);
  await zipDir(src, zipPath);

  const buf = await readFile(zipPath);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const { size } = await stat(zipPath);

  // Sign the bundle when a signing key is provided (--signing-key <pem-file> or
  // WEBINSPECTOR_BUNDLE_SIGNING_KEY_FILE). The signature binds (component, version, sha256);
  // publish it to the ControlPlane via the x-bundle-signature header.
  let signature = null;
  const keyFile = args["signing-key"] || process.env.WEBINSPECTOR_BUNDLE_SIGNING_KEY_FILE;
  if (keyFile) {
    const privateKey = await readFile(resolve(keyFile), "utf8");
    signature = signBundle({ component, version, sha256, privateKey });
  }

  const manifest = { component, version, sha256, sizeBytes: size, signature, createdAt: new Date().toISOString() };
  const manifestPath = join(outDir, `${component}-${version}.manifest.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`[build-bundle] sha256=${sha256} size=${size} signature=${signature ? "present" : "none (unsigned)"}`);
  console.log(`[build-bundle] manifest → ${manifestPath}`);
  console.log(`[build-bundle] register with the ControlPlane, then set desiredVersions.${component === "agent" ? "agentVersion" : "controlPlaneAgentVersion"}=${version}`);
}

// CLI entry only (import-safe).
if (process.argv[1]?.endsWith("build-bundle.mjs")) {
  main().catch((e) => {
    console.error(`[build-bundle] failed: ${e.message}`);
    process.exit(1);
  });
}