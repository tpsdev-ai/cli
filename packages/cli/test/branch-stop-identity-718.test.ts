/**
 * cli#718 — `tps branch stop` signals a process only when the pid record's
 * start token matches the live process. A legacy bare pid or a mismatched
 * token whose pid is alive is refused: no signal, the file is kept, and the
 * command exits non-zero naming the file. A dead pid's record is removed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { runBranch, setBranchStopSignal } from "../src/commands/branch.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const TIMEOUT = 20_000;

let root: string;
let pidFile: string;
let savedHome: string | undefined;
let savedRoot: string | undefined;
const children: Bun.Subprocess[] = [];

function spawnChild(): Bun.Subprocess {
  const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  return child;
}

function childToken(pid: number): string {
  const token = processStartToken(pid);
  if (token === null) throw new Error(`no start token for pid ${pid}`);
  return token;
}

/**
 * A token from the same source as `real` whose value the child cannot carry,
 * so the record is a mismatch by construction on Linux and macOS. A token
 * from a different source is "unverified", not "stale", so the source prefix
 * is kept.
 */
function foreignStartToken(real: string): string {
  if (real.startsWith("ps:")) return "ps:Thu Jan 1 00:00:00 1970";
  if (real.startsWith("proc:")) return "proc:1";
  throw new Error(`unexpected start token source: ${real}`);
}

function record(pid: number, token: string | null): string {
  return `${JSON.stringify({ pid, startToken: token })}\n`;
}

/** A pid that was live and is now reaped, or null when the spawn failed or
 *  pidState(child.pid) is not "gone" at registration. */
function reapedPid(): number | null {
  const child = spawnSync("true", []);
  if (child.pid === undefined) return null;
  return pidState(child.pid) === "gone" ? child.pid : null;
}

const gonePid = reapedPid();

/** Re-probe a registration-time gone pid; a reused pid proves nothing, so
 *  fail and ask for a rerun rather than remove an unrelated process's record. */
function requireGonePid(pid: number | null): number {
  if (pid === null) throw new Error("no reaped pid was registered; rerun the test");
  if (pidState(pid) !== "gone") throw new Error(`pid ${pid} was reused after registration; rerun the test`);
  return pid;
}

async function expectRefusal(contents: string, child: Bun.Subprocess): Promise<void> {
  writeFileSync(pidFile, contents);
  const signals: number[] = [];
  const original = setBranchStopSignal((pid) => {
    signals.push(pid);
  });
  let message = "";
  try {
    await runBranch({ action: "stop" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  } finally {
    setBranchStopSignal(original);
  }
  expect(message).toContain(pidFile);
  expect(signals).toEqual([]);
  expect(existsSync(pidFile)).toBe(true);
  expect(pidState(child.pid)).toBe("alive");
}

beforeEach(() => {
  savedHome = process.env.HOME;
  savedRoot = process.env.TPS_ROOT;
  root = mkdtempSync(join(tmpdir(), "tps-branch-stop-718-"));
  process.env.HOME = root;
  process.env.TPS_ROOT = join(root, ".tps");
  mkdirSync(process.env.TPS_ROOT, { recursive: true });
  pidFile = join(process.env.TPS_ROOT, "branch.pid");
});

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }
  rmSync(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedRoot === undefined) delete process.env.TPS_ROOT;
  else process.env.TPS_ROOT = savedRoot;
});

describe("branch stop requires a matching start token", () => {
  test("a legacy bare-pid record with a live pid is refused without a signal", async () => {
    const child = spawnChild();
    await expectRefusal(`${child.pid}\n`, child);
  });

  test("a mismatched-token record with a live pid is refused without a signal", async () => {
    const child = spawnChild();
    await expectRefusal(record(child.pid, foreignStartToken(childToken(child.pid))), child);
  });

  for (const shape of ["legacy", "mismatched-token"] as const) {
    test(`the command exits non-zero naming the file for a live ${shape} record`, () => {
      const child = spawnChild();
      const contents =
        shape === "legacy"
          ? `${child.pid}\n`
          : record(child.pid, foreignStartToken(childToken(child.pid)));
      writeFileSync(pidFile, contents);

      const result = spawnSync("node", [TPS_BIN, "branch", "stop"], {
        env: { ...process.env },
        encoding: "utf8",
        timeout: TIMEOUT,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(pidFile);
      expect(existsSync(pidFile)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    });
  }

  test("a matching record is signalled and the file removed", async () => {
    const child = spawnChild();
    writeFileSync(pidFile, record(child.pid, childToken(child.pid)));
    const signals: number[] = [];
    const original = setBranchStopSignal((pid) => {
      signals.push(pid);
      process.kill(pid, "SIGTERM");
    });
    try {
      await runBranch({ action: "stop" });
    } finally {
      setBranchStopSignal(original);
    }

    expect(signals).toEqual([child.pid]);
    expect(existsSync(pidFile)).toBe(false);
  });

  test.skipIf(gonePid === null)("a stale record for a dead pid is removed", async () => {
    const pid = requireGonePid(gonePid);
    writeFileSync(pidFile, record(pid, "proc:1"));
    const signals: number[] = [];
    const original = setBranchStopSignal((signalled) => {
      signals.push(signalled);
    });
    try {
      await runBranch({ action: "stop" });
    } finally {
      setBranchStopSignal(original);
    }

    expect(signals).toEqual([]);
    expect(existsSync(pidFile)).toBe(false);
  });
});
