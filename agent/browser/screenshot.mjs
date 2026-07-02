// Screenshot capture (worker side). Always captured on browser validation; uploaded as an
// artifact (image/png) over the data plane.
//
// TODO: implement against a Playwright Page (full-page PNG to destPath).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function captureScreenshot(page, destPath) {
  if (!page?.screenshot) throw new Error("captureScreenshot requires a Playwright page");
  await page.screenshot({ path: destPath, fullPage: true });
  return describeFile("screenshot", destPath);
}

export async function describeFile(kind, path) {
  const buf = await readFile(path);
  return { kind, path, sizeBytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
}
