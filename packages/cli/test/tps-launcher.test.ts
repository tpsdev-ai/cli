import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SOURCE_LAUNCHER = resolve(import.meta.dir, "../bin/tps.cjs");
const BUILT_CLI = resolve(import.meta.dir, "../dist/bin/tps.js");
const TMP_PREFIX = "tps-launcher-test-";
const PLATFORM_PKG = `@tpsdev-ai/cli-${process.platform}-${process.arch}`;
// The launcher is documented to run under node (`#!/usr/bin/env node`). Run it
// with node here too: when a package is not found under `paths`, bun's
// require.resolve falls back to its global install cache, so a fake package in
// a temp dir would not be seen.
const NODE = "node";

const tempDirs: string[] = [];

function makeIsolatedLauncher(): string {
  const dir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  tempDirs.push(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "tps.cjs"), readFileSync(SOURCE_LAUNCHER));
  writeFileSync(join(binDir, "cli-args.cjs"), readFileSync(resolve(SOURCE_LAUNCHER, "../cli-args.cjs")));
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
  writeFileSync(join(binDir, "cli-args.cjs"), readFileSync(resolve(SOURCE_LAUNCHER, "../cli-args.cjs")));

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

for (const flag of ["--version", "-v"]) {
  for (const prefix of [[], ["--no-guard", "--base-model", "fixture"], ["--config", flag], ["--"]]) {
    test(`launcher secrets-guard ${prefix.join(" ")} child receives ${flag}`, () => {
      const harness = makeLauncherHarness(null);
      const root = resolve(harness.launcher, "../..");
      writeFileSync(join(root, "dist", "bin", "tps.js"), `import(${JSON.stringify(pathToFileURL(BUILT_CLI).href)});\n`);
      const child = join(root, "child.mjs");
      writeFileSync(child, 'console.log("CHILD_ARGV=" + JSON.stringify(process.argv.slice(2)));\n');
      const result = runLauncher(harness, ["secrets-guard", ...prefix, NODE, child, flag]);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`CHILD_ARGV=${JSON.stringify([flag])}`);
    });
  }

  for (const prefix of [[], ["secrets-guard"]]) {
    test(`launcher ${prefix.join(" ")} ${flag} prints the version before a wrapped command`, () => {
      const harness = makeLauncherHarness(null);
      const result = runLauncher(harness, [...prefix, flag, NODE, "child.mjs"]);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(process.env.TPS_CLI_VERSION || process.env.npm_package_version || "dev");
      expect(existsSync(harness.fallbackMarker)).toBe(false);
    });
  }
}

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

function runWithSpawnError(error: { status?: number; signal?: string; code?: string } | null) {
  const launcher = makeIsolatedLauncher();
  const dir = join(launcher, "..");
  const marker = join(dir, "spawned");
  const preload = join(dir, "preload.cjs");
  writeFileSync(preload, `
    const fs = require('node:fs');
    require('node:child_process').execFileSync = () => {
      fs.appendFileSync(${JSON.stringify(marker)}, 'x');
      throw ${JSON.stringify(error ?? { status: 1, signal: null })};
    };
    ${error === null ? "" : `
      const Module = require('node:module');
      const resolve = Module._resolveFilename;
      Module._resolveFilename = function(id, ...args) {
        if (id === ${JSON.stringify(PLATFORM_PKG + "/package.json")}) return ${JSON.stringify(join(dir, "package.json"))};
        return resolve.call(this, id, ...args);
      };
    `}
  `);
  const result = spawnSync(NODE, ["--require", preload, launcher], { encoding: "utf8" });
  return {
    status: result.status,
    spawned: existsSync(marker) ? readFileSync(marker, "utf8").length : 0,
    stderr: result.stderr,
  };
}

test("a signal takes precedence over numeric status zero", () => {
  const result = runWithSpawnError({ status: 0, signal: "SIGTERM" });
  expect(result.status).toBe(128 + constants.signals.SIGTERM);
  expect(result.spawned).toBe(1);
  expect(result.stderr).toBe("");
});

test("missing platform package and JS entry print guidance without spawning node", () => {
  const result = runWithSpawnError(null);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Failed to load native binding");
  expect(result.stderr).toContain("no binary package available");
  expect(result.stderr).toContain("Try reinstalling main package:");
  expect(result.spawned).toBe(0);
});

test("uses the platform signal number for SIGUSR1", () => {
  const result = runWithSpawnError({ signal: "SIGUSR1" });
  expect(result.status).toBe(128 + constants.signals.SIGUSR1);
  expect(result.spawned).toBe(1);
  expect(result.stderr).toBe("");
});

test("an unknown signal exits non-zero without falling back", () => {
  const result = runWithSpawnError({ signal: "UNKNOWN_SIGNAL" });
  expect(result.status).not.toBe(0);
  expect(result.spawned).toBe(1);
  expect(result.stderr).toBe("");
});

test("a resolved binary that cannot start with no JS entry prints accurate guidance", () => {
  const result = runWithSpawnError({ code: "EACCES" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("TPS: platform binary could not be started.");
  expect(result.stderr).not.toContain("no binary package available");
  expect(result.stderr).not.toContain("Failed to load native binding");
  expect(result.stderr).toContain("Try reinstalling main package:");
  expect(result.stderr).toContain("Or install platform binary directly:");
  expect(result.spawned).toBe(1);
});

describe("tps launcher guard-mode refusals (cli#563)", () => {
  for (const flag of ["--check", "--no-guard"]) {
    test(`launcher ${flag} before the secrets-guard subcommand is refused and launches nothing`, () => {
      const harness = makeLauncherHarness(
        "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.TPS_TEST_BINARY_MARKER, 'ran');\n",
      );
      const root = resolve(harness.launcher, "../..");
      const binaryMarker = join(root, "binary-ran.marker");
      writeFileSync(join(root, "child.mjs"), 'console.log("CHILD_RAN");\n');

      const result = spawnSync(NODE, [harness.launcher, flag, "secrets-guard", NODE, join(root, "child.mjs")], {
        encoding: "utf-8",
        env: {
          ...process.env,
          TPS_TEST_FALLBACK_MARKER: harness.fallbackMarker,
          TPS_TEST_BINARY_MARKER: binaryMarker,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`InvalidSecretsGuardMode: ${flag} before the secrets-guard subcommand`);
      expect(existsSync(binaryMarker)).toBe(false);
      expect(existsSync(harness.fallbackMarker)).toBe(false);
    });
  }
});
