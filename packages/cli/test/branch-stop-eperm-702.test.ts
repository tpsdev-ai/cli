/**
 * cli#702 — `tps branch stop` classifies its SIGTERM refusal with the shared
 * pidState classifier: EPERM is a live process this user may not stop, so the
 * pid file stays and the command fails; ESRCH still clears a stale pid file.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { processStartToken } from "@tpsdev-ai/agent";
import { runBranch, setBranchStopSignal } from "../src/commands/branch.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
/** Whether this user is refused (EPERM) when signalling pid 1, probed with
 *  signal 0, which sends nothing. Root, or a non-root user who owns pid 1 (as
 *  in some containers), may signal it, so the real-signal cases below run only
 *  when this probe is refused. */
function pid1RefusesSignals(): boolean {
  try {
    process.kill(1, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
const pid1Refused = pid1RefusesSignals();
const pid1Token = processStartToken(1);
const pid1Record = pid1Token === null ? null : `${JSON.stringify({ pid: 1, startToken: pid1Token })}\n`;
const saved: Record<string, string | undefined> = {};

let root: string;
let pidFile: string;

afterEach(() => {
  mock.restore();
});

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
  // pid 1 always exists. These cases send a real SIGTERM to it, so they run
  // only when a signal-0 probe of pid 1 is refused with EPERM (pid1Refused).
  test.skipIf(!pid1Refused || pid1Record === null)("EPERM keeps the pid file and fails the stop", async () => {
    writeFileSync(pidFile, pid1Record!);

    await expect(runBranch({ action: "stop" })).rejects.toThrow(/could not be stopped \(pid 1\)/);
    expect(existsSync(pidFile)).toBe(true);
  });

  test.skipIf(!pid1Refused || pid1Record === null)("the stop command exits non-zero on EPERM and names the pid", () => {
    writeFileSync(pidFile, pid1Record!);

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

describe("branch stop refuses an invalid pid without signalling", () => {
  for (const pidText of ["-1", "1.5"]) {
    test(`a pid file holding ${pidText} gets no SIGTERM; successful unlink removes it as invalid`, async () => {
      writeFileSync(pidFile, `${pidText}\n`);
      const signals: number[] = [];
      const original = setBranchStopSignal((pid) => {
        signals.push(pid);
      });
      const logs: string[] = [];
      const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      });
      try {
        await runBranch({ action: "stop" });
      } finally {
        logSpy.mockRestore();
        setBranchStopSignal(original);
      }

      expect(signals).toEqual([]);
      expect(existsSync(pidFile)).toBe(false);
      expect(logs.join("\n")).toMatch(/removed/i);
    });
  }
});
