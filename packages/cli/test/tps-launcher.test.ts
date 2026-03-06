import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SOURCE_LAUNCHER = resolve(import.meta.dir, "../bin/tps.cjs");
const TMP_PREFIX = "tps-launcher-test-";

const tempDirs: string[] = [];

function makeIsolatedLauncher(): string {
  const dir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  tempDirs.push(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "tps.cjs"), readFileSync(SOURCE_LAUNCHER));
  return join(binDir, "tps.cjs");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("tps launcher version fallback", () => {
  test("uses TPS_CLI_VERSION for --version when package.json is unavailable", () => {
    const launcher = makeIsolatedLauncher();
    const result = spawnSync(process.execPath, [launcher, "--version"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        TPS_CLI_VERSION: "9.9.9-test",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("9.9.9-test");
    expect(result.stderr.trim()).toBe("");
  });
});
