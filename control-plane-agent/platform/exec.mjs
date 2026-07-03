// Shared platform exec helpers (Linux + Kubernetes providers).
//
// `run` spawns a process and resolves stdout/stderr (rejecting on non-zero exit); `downloadToFile`
// streams a URL to disk and verifies its SHA-256 before returning. Windows keeps its own copies
// (left untouched); these back the POSIX providers.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, opts);
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

export async function downloadToFile(url, destPath, { sha256 } = {}) {
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
