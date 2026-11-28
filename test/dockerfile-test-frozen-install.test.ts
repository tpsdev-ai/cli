import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOCKERFILE = join(import.meta.dir, "..", "Dockerfile.test");

test("every install command in Dockerfile.test is frozen and has no fallback", () => {
  // This reads Dockerfile.test as text: it cannot see installs run through
  // another script, a base image, or a file it does not copy.
  const lines = readFileSync(DOCKERFILE, "utf8").split("\n");
  const installLines = lines
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => /^RUN\b/.test(line))
    .filter(({ line }) => /\b(bun install|npm install|npm ci)\b/.test(line));

  expect(installLines.length).toBeGreaterThan(0);
  for (const { line, number } of installLines) {
    expect(line, `Dockerfile.test:${number} has a || fallback`).not.toContain("||");
    const frozen = /\bbun install\b/.test(line)
      ? /\bbun install\b.*--frozen-lockfile\b/.test(line)
      : /\bnpm ci\b/.test(line);
    expect(frozen, `Dockerfile.test:${number} is not a frozen install`).toBe(true);
  }
});
