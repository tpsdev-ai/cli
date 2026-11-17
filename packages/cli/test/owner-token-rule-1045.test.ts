/**
 * cli#1045 — the cli owner classifiers changed here use the agent package's one token
 * rule (classifyOwnerToken): a live pid whose recorded `ps:` token differs is
 * unverifiable, never dead; a differing `proc:` token is still pid reuse.
 *
 * Covered: the outbox per-delivery lock (`tryAcquireMailLock`) and the launch
 * snapshot sweep (`sweepStaleLaunchSnapshots`). The `ps:` cases send
 * processStartToken to its `ps` fallback through a test-only `node:fs`
 * substitution (test/helpers/start-token-source-test.ts), and the `proc:` cases
 * stage `proc:` tokens through it, so both run the same on
 * Linux and macOS.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartToken } from "@tpsdev-ai/agent";
import { spawnLiveProcess } from "../../../test/helpers/live-process.js";
import { forcePsStartTokens, stageProcStartTokens } from "../../../test/helpers/start-token-source-test.js";
import { LAUNCH_SNAPSHOT_OWNER_FILE, LAUNCH_SNAPSHOT_PREFIX, sweepStaleLaunchSnapshots } from "../src/utils/launch-snapshots.js";
import { MailLockOwnerError, tryAcquireMailLock } from "../src/utils/mail-lock.js";

/** An intentionally non-UTC POSIX zone (UTC+13:17). */
const ODD_ZONE_ENV = { ...process.env, TZ: "XST-13:17" };

/**
 * The `ps:` text an unpinned writer in an intentionally non-UTC zone would have
 * recorded for this live pid; it differs from the pinned UTC token (each caller
 * asserts this).
 */
function legacyPsToken(pid: number): string {
  return `ps:${execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { env: ODD_ZONE_ENV, encoding: "utf-8", timeout: 5_000 }).trim()}`;
}

let root: string;
let child: ChildProcess | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "owner-token-rule-1045-"));
});
afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** A live child pid and its current start token. */
function livePid(): { pid: number; token: string } {
  child = spawnLiveProcess();
  const pid = child.pid as number;
  expect(pid).toBeGreaterThan(0);
  const token = processStartToken(pid);
  expect(token).not.toBeNull();
  return { pid, token: token as string };
}

describe("outbox per-delivery lock (tryAcquireMailLock)", () => {
  function plantLock(owner: Record<string, unknown>): { lockDir: string; ownerFile: string } {
    const lockDir = join(root, "delivery.lock");
    mkdirSync(lockDir);
    const ownerFile = join(lockDir, "owner.json");
    writeFileSync(ownerFile, JSON.stringify(owner));
    return { lockDir, ownerFile };
  }

  test("a lock naming a live pid with a different ps: token is not broken", () => {
    forcePsStartTokens();
    const { pid, token } = livePid();
    expect(token).toStartWith("ps:");
    const legacy = legacyPsToken(pid);
    expect(legacy).not.toBe(token);
    const owner = { pid, startToken: legacy };
    const { lockDir, ownerFile } = plantLock(owner);

    // An unverifiable owner is refused loudly; a dead one would be reclaimed.
    let lock: ReturnType<typeof tryAcquireMailLock> = null;
    let thrown: unknown;
    try {
      lock = tryAcquireMailLock(lockDir);
    } catch (error) {
      thrown = error;
    } finally {
      lock?.release();
    }
    expect(lock).toBeNull();
    expect(thrown).toBeInstanceOf(MailLockOwnerError);
    expect(JSON.parse(readFileSync(ownerFile, "utf-8"))).toEqual(owner);
  });

  test("a lock naming a live pid with a different proc: token is reclaimed (pid reuse)", () => {
    stageProcStartTokens();
    const { pid, token } = livePid();
    expect(token).toStartWith("proc:");
    const { lockDir, ownerFile } = plantLock({ pid, startToken: "proc:1" });

    const lock = tryAcquireMailLock(lockDir);
    try {
      expect(lock).not.toBeNull();
      expect(JSON.parse(readFileSync(ownerFile, "utf-8")).pid).toBe(process.pid);
    } finally {
      lock?.release();
    }
  });

  test("a lock naming a live pid with its own ps: token is held (not ours, not broken)", () => {
    forcePsStartTokens();
    const { pid, token } = livePid();
    const owner = { pid, startToken: token };
    const { lockDir, ownerFile } = plantLock(owner);

    expect(tryAcquireMailLock(lockDir)).toBeNull();
    expect(JSON.parse(readFileSync(ownerFile, "utf-8"))).toEqual(owner);
  });
});

describe("launch snapshot sweep (sweepStaleLaunchSnapshots)", () => {
  function plantSnapshot(owner: Record<string, unknown>): string {
    // The sweep selects only a prefix plus six letters or digits (mkdtemp's suffix).
    const dir = join(root, `${LAUNCH_SNAPSHOT_PREFIX}a1045b`);
    mkdirSync(dir);
    writeFileSync(join(dir, LAUNCH_SNAPSHOT_OWNER_FILE), JSON.stringify(owner));
    return dir;
  }

  test("a snapshot owned by a live pid with a different ps: token is kept", () => {
    forcePsStartTokens();
    const { pid, token } = livePid();
    expect(token).toStartWith("ps:");
    const legacy = legacyPsToken(pid);
    expect(legacy).not.toBe(token);
    const dir = plantSnapshot({ pid, startToken: legacy });

    expect(sweepStaleLaunchSnapshots(root, { graceMs: 0 })).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  test("a snapshot owned by a live pid with a different proc: token is swept (pid reuse)", () => {
    stageProcStartTokens();
    const { pid, token } = livePid();
    expect(token).toStartWith("proc:");
    const dir = plantSnapshot({ pid, startToken: "proc:1" });

    expect(sweepStaleLaunchSnapshots(root, { graceMs: 0 })).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
  });

  test("a snapshot owned by a live pid with its own token is kept", () => {
    forcePsStartTokens();
    const { pid, token } = livePid();
    const dir = plantSnapshot({ pid, startToken: token });

    expect(sweepStaleLaunchSnapshots(root, { graceMs: 0 })).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });
});
