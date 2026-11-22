import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The built module a node rerun imports. Without a rebuild, a source mutation
 * is tested against stale bytes, so refuse when the build is missing or older
 * than the source it was built from.
 */
export function requireFreshDist(sourceMail: string, distMail: string): string {
  if (!fs.existsSync(distMail)) {
    throw new Error(`node rerun needs a build: ${distMail} is missing; run bun run build in packages/cli`);
  }
  if (fs.statSync(distMail).mtimeMs < fs.statSync(sourceMail).mtimeMs) {
    throw new Error(`node rerun cannot use ${distMail}: it is older than the source ${sourceMail}; rebuild with bun run build`);
  }
  return distMail;
}

/** requireFreshDist for this package's own mail module, given a test file's import.meta.url. */
export function freshDistMail(importMetaUrl: string): string {
  const testDir = dirname(fileURLToPath(importMetaUrl));
  return requireFreshDist(
    join(testDir, "..", "src", "utils", "mail.ts"),
    join(testDir, "..", "dist", "src", "utils", "mail.js"),
  );
}
