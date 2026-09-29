/**
 * store-lock.ts — ONE exclusive lock per durable store file.
 *
 * Every read-modify-write of a store (the gateway's claim, its outcome writes
 * and releases, the host's reconciliation, pending-audit retention) runs under
 * this lock, so the check and the write of one operation are atomic with
 * respect to every other process that uses the same store file.
 *
 * MECHANISM: an O_EXCL lock file, `<store>.lock`, created with
 * open(O_CREAT|O_EXCL). Chosen over flock(2) because neither node nor bun
 * exposes flock/fcntl locking, and a native addon would add an install script
 * to a plugin whose install runs with --ignore-scripts. O_EXCL creation is
 * atomic on a local filesystem.
 *
 * SCOPE: one store file is served by the processes that share this lock —
 * processes on ONE host opening the same file on a LOCAL filesystem. A network
 * filesystem whose O_EXCL is not atomic, or processes on different hosts, are
 * outside it: two gateways on different hosts must not share a store file.
 *
 * STALE LOCKS FAIL CLOSED. An O_EXCL lock is not released when its holder
 * dies, and nothing here removes a lock it did not create. The lock is held
 * only across synchronous file operations (no await inside), so a stale lock
 * means a process died inside one. After LOCK_TIMEOUT_MS the operation fails
 * with StoreLockBusyError, which names the lock file, its recorded holder and
 * the remedy (confirm no process is working on the store, then remove it).
 */

import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";

export const LOCK_TIMEOUT_MS = 1500;
const POLL_MS = 5;

export interface LockHolder {
  pid: number | null;
  host: string | null;
  since: string | null;
  op: string | null;
}

export class StoreLockBusyError extends Error {
  constructor(
    readonly lockPath: string,
    readonly holder: LockHolder | null,
    readonly waitedMs: number,
  ) {
    super(`the store lock ${lockPath} is held (${StoreLockBusyError.describe(holder)}); waited ${waitedMs} ms`);
    this.name = "StoreLockBusyError";
  }

  static describe(holder: LockHolder | null): string {
    if (!holder) return "holder unrecorded";
    return `by pid ${holder.pid ?? "?"} on ${holder.host ?? "?"} since ${holder.since ?? "?"} for ${holder.op ?? "?"}`;
  }

  /** The operator's remedy, naming the lock file. */
  remedy(): string {
    return (
      `if no gateway or latch-admin process is working on this store, the lock is stale (its holder died holding it): ` +
      `confirm that, then remove ${this.lockPath}`
    );
  }

  /** The same, without the path, for the gateway's host log. `storeKey` names
   *  the configuration key of the store (e.g. "reconcileFile"). */
  pathFree(storeKey: string): string {
    return (
      `the lock file of ${storeKey} (${storeKey} + ".lock") is held (${StoreLockBusyError.describe(this.holder)}); ` +
      `if no gateway or latch-admin process is working on that store, the lock is stale: confirm, then remove it`
    );
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readHolder(lockPath: string): (LockHolder & { token: string | null }) | null {
  try {
    const o = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    return {
      pid: typeof o.pid === "number" ? o.pid : null,
      host: typeof o.host === "string" ? o.host : null,
      since: typeof o.since === "string" ? o.since : null,
      op: typeof o.op === "string" ? o.op : null,
      token: typeof o.token === "string" ? o.token : null,
    };
  } catch {
    return null;
  }
}

/** Run `fn` holding the exclusive lock of `storeFile`. `fn` must be
 *  synchronous. Throws StoreLockBusyError when the lock stays held past
 *  `timeoutMs`, and rethrows whatever `fn` throws. */
export function withStoreLock<T>(storeFile: string, op: string, fn: () => T, timeoutMs = LOCK_TIMEOUT_MS): T {
  const lockPath = `${storeFile}.lock`;
  const token = randomBytes(16).toString("hex");
  const start = Date.now();
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      break;
    } catch (err) {
      if ((err as { code?: unknown }).code !== "EEXIST") throw err;
      const waited = Date.now() - start;
      if (waited >= timeoutMs) {
        const holder = readHolder(lockPath);
        throw new StoreLockBusyError(lockPath, holder && { pid: holder.pid, host: holder.host, since: holder.since, op: holder.op }, waited);
      }
      sleepSync(POLL_MS);
    }
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), since: new Date().toISOString(), op, token }));
  } catch (err) {
    // We created it and could not mark it ours: remove it rather than leave a
    // lock nobody can identify.
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // It stays, and the next operation reports it as stale.
    }
    throw err;
  }
  closeSync(fd);
  try {
    return fn();
  } finally {
    releaseLock(lockPath, token);
  }
}

/** Remove the lock ONLY if it is still ours. Never throws: a lock that cannot
 *  be removed stays, and the next operation reports it as stale. */
function releaseLock(lockPath: string, token: string): void {
  try {
    if (readHolder(lockPath)?.token !== token) return;
    unlinkSync(lockPath);
  } catch {
    // The lock stays; the next operation fails closed on it with the remedy.
  }
}
