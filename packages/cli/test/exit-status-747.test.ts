// cli#747 — a failing command's exit status survives the built CLI under Node
// and the npm launcher. Each case spawns the real file with a throwaway HOME,
// the isolation pattern of entry-identity.test.ts:14-18.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BUILT_CLI = resolve(import.meta.dir, "../dist/bin/tps.js");
const LAUNCHER = resolve(import.meta.dir, "../bin/tps.cjs");
const NODE = "node";
const USAGE_LINE = "Usage: tps service remove <name>";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tps-exit-747-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(entry: string, args: string[]) {
  const result = spawnSync(NODE, [entry, ...args], {
    encoding: "utf-8",
    timeout: 20_000,
    cwd: home,
    // A throwaway HOME keeps the run away from a real ~/.tps registry.
    env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: home },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// The launcher prefers a platform native binary when one resolves. Run it on
// its source-install JS fallback so the assertions cover the built entry, not
// whichever binary a host or image happens to have installed.
function runLauncher(args: string[]) {
  const preload = join(home, "no-platform-package.cjs");
  writeFileSync(
    preload,
    [
      'const Module = require("node:module");',
      "const resolve = Module._resolveFilename;",
      "Module._resolveFilename = function (request, ...rest) {",
      '  if (request.startsWith("@tpsdev-ai/cli-") && request.endsWith("/package.json")) {',
      '    const error = new Error("Cannot find module: " + request);',
      '    error.code = "MODULE_NOT_FOUND";',
      "    throw error;",
      "  }",
      "  return resolve.call(this, request, ...rest);",
      "};",
      "",
    ].join("\n"),
  );
  const result = spawnSync(NODE, ["--require", preload, LAUNCHER, ...args], {
    encoding: "utf-8",
    timeout: 20_000,
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: home },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("cli#747 — built CLI under Node", () => {
  test("a failing command exits 1 and prints its usage line", () => {
    const result = run(BUILT_CLI, ["service", "remove"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(USAGE_LINE);
  });

  test("a succeeding command exits 0 and prints a version", () => {
    const result = run(BUILT_CLI, ["--version"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
    expect(result.stderr).toBe("");
  });
});

describe("cli#747 — npm launcher under Node", () => {
  test("a failing command exits 1 and prints its usage line", () => {
    const result = runLauncher(["service", "remove"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(USAGE_LINE);
  });

  test("a succeeding command exits 0 and prints a version", () => {
    const result = runLauncher(["--version"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
    expect(result.stderr).toBe("");
  });
});
