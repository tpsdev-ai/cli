/**
 * cli#702 — `tps branch stop` classifies its SIGTERM refusal with the shared
 * pidState classifier: EPERM is a live process this user may not stop, so the
 * pid file stays and the command fails; ESRCH still clears a stale pid file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runBranch } from "../src/commands/branch.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const isRoot = process.getuid?.() === 0;
const saved: Record<string, string | undefined> = {};

let root: string;
let pidFile: string;

beforeEach(() => {
  for (const key of ["HOME", "TPS_ROOT"]) saved[key] = process.env[key];
  root = mkdtempSync(join(tmpdir(), "tps-branch-stop-702-"));
  process.env.HOME = root;
  process.env.TPS_ROOT = join(root, ".tps");
  mkdirSync(process.env.TPS_ROOT, { recursive: true });
  pidFile = join(process.env.TPS_ROOT, "branch.pid");
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("branch stop signal classification", () => {
  // pid 1 always exists; a non-root user's SIGTERM to it is refused with EPERM.
  // Root may signal it, so the case is skipped there (as in cli#683).
  test.skipIf(isRoot)("EPERM keeps the pid file and fails the stop", async () => {
    writeFileSync(pidFile, "1\n");

    await expect(runBranch({ action: "stop" })).rejects.toThrow(/could not be stopped \(pid 1\)/);
    expect(existsSync(pidFile)).toBe(true);
  });

  test.skipIf(isRoot)("the stop command exits non-zero on EPERM and names the pid", () => {
    writeFileSync(pidFile, "1\n");

    const result = spawnSync("node", [TPS_BIN, "branch", "stop"], {
      env: process.env,
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not be stopped (pid 1)");
    expect(existsSync(pidFile)).toBe(true);
  });

  test("ESRCH removes the stale pid file", async () => {
    writeFileSync(pidFile, "2147483647\n");

    await runBranch({ action: "stop" });

    expect(existsSync(pidFile)).toBe(false);
  });
});
