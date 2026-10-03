// The mailbox lock lives in @tpsdev-ai/agent so MailClient and promote() hold the same one.
export { acquireMailLock, acquireMailLockSync, MAIL_LOCK_DIR, type MailLock, mailLockPath, processStartToken } from "@tpsdev-ai/agent";
import { processStartToken } from "@tpsdev-ai/agent";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { MailLock } from "@tpsdev-ai/agent";

const OWNER_FILE = "owner.json";

const TEMP_PREFIX = ".mail-lock.tmp.";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code !== "ESRCH";
  }
}

interface LockOwner {
  pid?: unknown;
  startToken?: unknown;
}

type OwnerState = "alive" | "dead" | "unverifiable" | "unowned";

function tokenSource(token: string): string {
  const i = token.indexOf(":");
  return i === -1 ? token : token.slice(0, i);
}

function readOwner(lockDir: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(join(lockDir, OWNER_FILE), "utf-8")) as LockOwner;
  } catch {
    return null;
  }
}

function ownerState(
  owner: LockOwner | null,
  resolveToken: (pid: number) => string | null = processStartToken,
  strict = false,
): OwnerState {
  if (!owner || typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return "unowned";
  }
  if (strict && (typeof owner.startToken !== "string" || !/^(proc|ps):.+/.test(owner.startToken))) return "unverifiable";
  if (!isPidAlive(owner.pid)) return "dead";
  const token = resolveToken(owner.pid);
  if (token !== null && typeof owner.startToken === "string") {
    if (tokenSource(token) !== tokenSource(owner.startToken)) return "unverifiable";
    return token === owner.startToken ? "alive" : "dead";
  }
  return isPidAlive(owner.pid) ? "unverifiable" : "dead";
}

function claimLock(lockDir: string, myToken: string | null): boolean {
  const tmpDir = join(dirname(lockDir), `${TEMP_PREFIX}${process.pid}.${randomBytes(6).toString("hex")}`);
  try {
    mkdirSync(tmpDir);
    writeFileSync(join(tmpDir, OWNER_FILE), JSON.stringify({ pid: process.pid, startToken: myToken }), "utf-8");
    try {
      renameSync(tmpDir, lockDir);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EISDIR" && code !== "ENOTDIR") throw error;
      return false;
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export class MailLockOwnerError extends Error {
  constructor(lockDir: string) {
    super(`MailLockOwnerError: cannot verify owner of ${lockDir}`);
    this.name = "MailLockOwnerError";
  }
}

function removeClaim(lockDir: string): void {
  const retired = join(dirname(lockDir), `${TEMP_PREFIX}${process.pid}.${randomBytes(6).toString("hex")}`);
  renameSync(lockDir, retired);
  rmSync(retired, { recursive: true, force: true });
}

export function tryAcquireMailLock(lockDir: string): MailLock | null {
  const myToken = processStartToken(process.pid);
  if (myToken === null) throw new MailLockOwnerError(lockDir);
  for (;;) {
    if (!existsSync(lockDir) && claimLock(lockDir, myToken)) {
      let released = false;
      return { release() {
        if (released) return;
        released = true;
        const owner = readOwner(lockDir);
        if (owner?.pid === process.pid && owner.startToken === myToken) {
          removeClaim(lockDir);
        }
      } };
    }
    try {
      if (!statSync(lockDir).isDirectory()) throw new MailLockOwnerError(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const owner = readOwner(lockDir);
    const state = ownerState(owner, processStartToken, true);
    if (JSON.stringify(owner) !== JSON.stringify(readOwner(lockDir))) continue;
    if (state === "alive") {
      if (owner?.pid === process.pid) throw new MailLockOwnerError(lockDir);
      return null;
    }
    if (state !== "dead") {
      if (!existsSync(lockDir)) continue;
      throw new MailLockOwnerError(lockDir);
    }
    let reclaim: MailLock | null;
    try {
      reclaim = tryAcquireMailLock(`${lockDir}.reclaim`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!reclaim) return null;
    try {
      const currentOwner = readOwner(lockDir);
      const current = ownerState(currentOwner, processStartToken, true);
      if (current === "alive") {
        if (currentOwner?.pid === process.pid) throw new MailLockOwnerError(lockDir);
        return null;
      }
      if (current !== "dead") {
        if (!existsSync(lockDir)) continue;
        throw new MailLockOwnerError(lockDir);
      }
      removeClaim(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      reclaim.release();
    }
  }
}
