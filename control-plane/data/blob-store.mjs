// Content-addressed blob store (ControlPlane data plane).
//
// Stores bulk artifacts (screenshots, HAR, result bodies) on the local filesystem keyed by
// their SHA-256. Content addressing gives free dedupe + integrity: the id IS the hash, so a
// tampered blob can't masquerade as another. Swap for Azure Blob behind this interface later.

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

export function createBlobStore({ dir = "./state/blobs" } = {}) {
  async function ensure() {
    await mkdir(dir, { recursive: true });
  }

  return {
    /** Verify (if a sha256 is claimed) and store; returns metadata with artifactId = sha256. */
    async put(buffer, { kind = "file", sha256, contentType } = {}) {
      const digest = createHash("sha256").update(buffer).digest("hex");
      if (sha256 && digest.toLowerCase() !== String(sha256).toLowerCase()) {
        const e = new Error(`sha256 mismatch: got ${digest}, expected ${sha256}`);
        e.httpStatus = 400;
        throw e;
      }
      await ensure();
      await writeFile(join(dir, digest), buffer);
      const meta = { artifactId: digest, kind, sizeBytes: buffer.length, contentType: contentType || "application/octet-stream", createdAt: new Date().toISOString() };
      await writeFile(join(dir, `${digest}.json`), JSON.stringify(meta));
      return meta;
    },

    has(id) {
      return isHexId(id) && existsSync(join(dir, id));
    },
    stream(id) {
      return createReadStream(join(dir, id));
    },
    async meta(id) {
      try {
        return JSON.parse(await readFile(join(dir, `${id}.json`), "utf8"));
      } catch {
        return null;
      }
    },
  };
}

export function isHexId(id) {
  return /^[a-f0-9]{64}$/i.test(String(id || ""));
}
