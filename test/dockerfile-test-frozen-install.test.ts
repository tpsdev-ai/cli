import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOCKERFILE = join(import.meta.dir, "..", "Dockerfile.test");

test("Dockerfile.test installs with exactly RUN bun install --frozen-lockfile, and names bun install nowhere else", () => {
  // This pins the text of Dockerfile.test's one dependency install. It does not detect other install spellings (`bun i`, `bun add`, npm) or installs outside this file; the runtime guard in #948 is the enforcement.
  const content = readFileSync(DOCKERFILE, "utf8");
  const lines = content.split("\n").map((line) => line.trim());

  const installLines = lines.filter((line) => line === "RUN bun install --frozen-lockfile");
  expect(installLines.length).toBe(1);

  expect(content.split("bun install").length - 1).toBe(1);
});
