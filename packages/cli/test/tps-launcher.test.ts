import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SOURCE_LAUNCHER = resolve(import.meta.dir, "../bin/tps.cjs");
const TMP_PREFIX = "tps-launcher-test-";
const PLATFORM_PKG = `@tpsdev-ai/cli-${process.platform}-${process.arch}`;
// The launcher is documented to run under node (`#!/usr/bin/env node`). Run it
// with node here too: bun's require.resolve ignores `paths` and falls back to
// its global install cache, so a fake package in a temp dir would not be seen.
const NODE = "node";

const tempDirs: string[] = [];

function makeIsolatedLauncher(): string {
  const dir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  tempDirs.push(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "tps.cjs"), readFileSync(SOURCE_LAUNCHER));
  return join(binDir, "tps.cjs");
}

interface LauncherHarness {
  launcher: string;
  fallbackMarker: string;
}

// A temp tree holding the real launcher, an optional fake platform binary, and
// a JS fallback that records that it ran. The fallback marker proves the
// fallback did or did not execute.
function makeLauncherHarness(fakeBinary: string | null): LauncherHarness {
  const dir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  tempDirs.push(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "tps.cjs"), readFileSync(SOURCE_LAUNCHER));

  const fallbackMarker = join(dir, "fallback-ran.marker");
  const fallbackDir = join(dir, "dist", "bin");
  mkdirSync(fallbackDir, { recursive: true });
  writeFileSync(
    join(fallbackDir, "tps.js"),
    `require("node:fs").writeFileSync(process.env.TPS_TEST_FALLBACK_MARKER, "ran");\n`,
  );

  if (fakeBinary !== null) {
    const pkgDir = join(dir, "node_modules", PLATFORM_PKG);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: PLATFORM_PKG, version: "0.0.0" }),
    );
    writeFileSync(join(pkgDir, "tps"), fakeBinary, { mode: 0o755 });
  }

  return { launcher: join(binDir, "tps.cjs"), fallbackMarker };
}

function runLauncher(harness: LauncherHarness, args: string[]) {
  return spawnSync(NODE, [harness.launcher, ...args], {
    encoding: "utf-8",
    env: { ...process.env, TPS_TEST_FALLBACK_MARKER: harness.fallbackMarker },
  });
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

describe("tps launcher exit status", () => {
  test("propagates the platform binary's non-zero exit and does not run the fallback", () => {
    const harness = makeLauncherHarness("#!/usr/bin/env node\nprocess.exit(3);\n");
    const result = runLauncher(harness, ["mail", "send", "a", "b"]);

    expect(result.status).toBe(3);
    expect(result.stderr).not.toContain("Failed to load native binding");
    expect(existsSync(harness.fallbackMarker)).toBe(false);
  });

  test("runs the fallback when the platform binary package is missing", () => {
    const harness = makeLauncherHarness(null);
    const result = runLauncher(harness, ["roster", "list"]);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Failed to load native binding");
    expect(existsSync(harness.fallbackMarker)).toBe(true);
  });

  test("propagates a non-zero status when the platform binary is killed by a signal", () => {
    const harness = makeLauncherHarness(
      "#!/usr/bin/env node\nprocess.kill(process.pid, 'SIGTERM');\n",
    );
    const result = runLauncher(harness, ["mail", "send", "a", "b"]);

    expect(result.status).not.toBeNull();
    expect(result.status).not.toBe(0);
    expect(existsSync(harness.fallbackMarker)).toBe(false);
  });
});
