/**
 * cli#677 — pidState, the pid check the mail lock and the launch-snapshot sweep
 * share, against real processes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnLiveProcess } from "../../../test/helpers/live-process.js";
import {
  acquireMailLockSync,
  mailLockPath,
  pidState,
  pidStateFromProbeError,
  processIsGone,
  processStartToken,
} from "../src/lib/mail-lock.js";

/** A pid that has exited and been reaped by this process. */
function reapedPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""], { timeout: 10_000 });
  expect(result.pid).toBeGreaterThan(0);
  return result.pid as number;
}

/** A pid state read from a Linux `/proc/<pid>/stat` line. The `comm` field may
 *  contain spaces and parentheses, so the fields are parsed after the last `)`. */
function procStatState(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] || null;
  } catch {
    return null;
  }
}

/**
 * Spawn a child that exits immediately, then block this process's event loop
 * until its SIGCHLD is pending. The child is then a zombie that `kill(pid, 0)`
 * still answers, because the parent has not reaped it.
 */
function unreapedZombie(): { child: ChildProcess; pid: number } {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid as number;
  expect(pid).toBeGreaterThan(0);
  const deadline = Date.now() + 10_000;
  while (procStatState(pid) !== "Z") {
    if (Date.now() > deadline) throw new Error(`pid ${pid} did not become a zombie`);
    // spawnSync blocks the event loop, so this process cannot reap the child.
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 50)"], { timeout: 10_000 });
  }
  return { child, pid };
}

/** A running child process and its start token. */
async function liveProcess(): Promise<{ child: ChildProcess; pid: number; token: string }> {
  const child = spawnLiveProcess();
  const pid = child.pid as number;
  expect(pid).toBeGreaterThan(0);
  let token: string | null = null;
  const deadline = Date.now() + 5_000;
  while (token === null && Date.now() < deadline) {
    token = processStartToken(pid);
    if (token === null) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  expect(token).not.toBeNull();
  return { child, pid, token: token as string };
}

describe("pidState", () => {
  test("a pid above 2147483647 is invalid", () => {
    for (const pid of [2_147_483_648, 4_294_967_297, 2 ** 53]) {
      expect(pidState(pid), String(pid)).toBe("invalid");
    }
  });

  test("a pid of 0, a negative pid and a fractional pid are invalid", () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(pidState(pid), String(pid)).toBe("invalid");
    }
  });

  test("a running process is alive, and so is pid 1", async () => {
    const { child, pid } = await liveProcess();
    try {
      expect(pidState(pid)).toBe("alive");
      expect(pidState(process.pid)).toBe("alive");
      // pid 1 always exists; when this process may not signal it, the probe fails with EPERM.
      expect(pidState(1)).toBe("alive");
    } finally {
      child.kill("SIGKILL");
    }
  }, 15_000);

  test("an exited and reaped process is gone", () => {
    expect(pidState(reapedPid())).toBe("gone");
  });
});

describe("pidState on Linux", () => {
  // A zombie's state is visible in /proc/<pid>/stat; elsewhere the
  // kill(pid, 0) answer is the whole probe, so these cases skip there.
  const children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
    }
  });

  test.skipIf(process.platform !== "linux")(
    "an exited child that is not reaped is gone",
    () => {
      const { child, pid } = unreapedZombie();
      children.push(child);
      expect(procStatState(pid)).toBe("Z");
      expect(pidState(pid)).toBe("gone");
      // processIsGone with the owner's real start token, and the lock-owner
      // reclaim, inherit the classifier.
      const token = processStartToken(pid);
      expect(token).not.toBeNull();
      expect(processIsGone(pid, token)).toBe(true);
      // acquireMailLockSync is synchronous, so the child stays unreaped.
      const root = mkdtempSync(join(tmpdir(), "mail-lock-zombie-"));
      try {
        mkdirSync(mailLockPath(root));
        writeFileSync(
          join(mailLockPath(root), "owner.json"),
          JSON.stringify({ pid, startToken: token, nonce: "planted" }),
        );
        const lock = acquireMailLockSync(root, { timeoutMs: 2_000 });
        expect(lock).not.toBeNull();
        lock?.release();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.skipIf(process.platform !== "linux")(
    "a live child is still alive",
    () => {
      const child = spawnLiveProcess();
      children.push(child);
      expect(pidState(child.pid as number)).toBe("alive");
    },
    15_000,
  );

  test.skipIf(process.platform !== "linux")(
    "a failed stat read keeps alive",
    () => {
      const child = spawnLiveProcess();
      children.push(child);
      const pid = child.pid as number;
      expect(pidState(pid, () => null)).toBe("alive");
      expect(pidState(pid, () => [])).toBe("alive");
    },
    15_000,
  );
});

describe("pidStateFromProbeError", () => {
  // Errors carrying the codes process.kill raises, so EPERM is covered on any host.
  test("classifies EPERM as alive, ESRCH as gone, an argument error as invalid, and any other error as alive", () => {
    const withCode = (code: string) => Object.assign(new Error(code), { code });
    expect(pidStateFromProbeError(withCode("EPERM"))).toBe("alive");
    expect(pidStateFromProbeError(withCode("ESRCH"))).toBe("gone");
    for (const code of ["ERR_INVALID_ARG_TYPE", "ERR_OUT_OF_RANGE", "EINVAL", "ERANGE"]) {
      expect(pidStateFromProbeError(withCode(code)), code).toBe("invalid");
    }
    expect(pidStateFromProbeError(withCode("EIO"))).toBe("alive");
    expect(pidStateFromProbeError(new Error("no code"))).toBe("alive");
    expect(pidStateFromProbeError(null)).toBe("alive");
  });
});

describe("mail lock owner pid", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mail-lock-pid-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function plantLock(owner: Record<string, unknown>): string {
    const ownerFile = join(mailLockPath(root), "owner.json");
    mkdirSync(mailLockPath(root));
    writeFileSync(ownerFile, JSON.stringify(owner));
    return ownerFile;
  }

  test("a lock whose owner pid is above 2147483647 is not reclaimed", () => {
    const owner = { pid: 2_147_483_648, startToken: processStartToken(process.pid), nonce: "planted" };
    const ownerFile = plantLock(owner);

    expect(acquireMailLockSync(root, { timeoutMs: 50 })).toBeNull();
    expect(JSON.parse(readFileSync(ownerFile, "utf-8"))).toEqual(owner);
    expect(processIsGone(owner.pid, owner.startToken)).toBe(false);
  });

  test("a lock whose owner is gone is reclaimed", () => {
    const pid = reapedPid();
    plantLock({ pid, startToken: "proc:1", nonce: "planted" });
    expect(processIsGone(pid, "proc:1")).toBe(true);

    const lock = acquireMailLockSync(root, { timeoutMs: 2_000 });
    try {
      expect(lock).not.toBeNull();
      expect(JSON.parse(readFileSync(join(mailLockPath(root), "owner.json"), "utf-8")).pid).toBe(process.pid);
    } finally {
      lock?.release();
    }
  });

  test("a lock held by a running process is not reclaimed", async () => {
    const { child, pid, token } = await liveProcess();
    try {
      const owner = { pid, startToken: token, nonce: "planted" };
      const ownerFile = plantLock(owner);

      expect(acquireMailLockSync(root, { timeoutMs: 50 })).toBeNull();
      expect(JSON.parse(readFileSync(ownerFile, "utf-8"))).toEqual(owner);
      expect(processIsGone(pid, token)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }, 15_000);
});
