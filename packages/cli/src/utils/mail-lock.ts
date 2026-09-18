/**
 * mail-lock.ts — a small inter-process lock for maildir mutation.
 *
 * There is no existing lock primitive in this tree to reuse (the only
 * "lockfile" hit is an npm package-lock), so this is a purpose-built one.
 *
 * Why it exists: the replay ledger is read-modify-written (prune) and appended,
 * and the promotion moves files; without mutual exclusion, two concurrent
 * promotions can both pass the replay gate before either records the id, and an
 * append can land between a prune's read and its rename and be lost. The lock
 * must span the whole replay-check → promotion-commit/rollback critical section,
 * including the ledger prune and append.
 *
 * Properties:
 *  - acquisition is atomic and bounded (timeout): a POPULATED lock directory is
 *    built in a unique temp dir and RENAMED onto the lock path. Renaming a dir
 *    onto a non-empty dir fails (EEXIST/ENOTEMPTY), so claim+ownership is
 *    all-or-nothing — an UNOWNED lock cannot exist, and a crash mid-acquire can
 *    never leave a permanent, never-breakable wedge;
 *  - an owner is identified by pid AND process start time, never pid alone:
 *    pids are reused, so a pid-only stamp eventually mistakes a live process for
 *    a dead one, or the reverse;
 *  - a lock whose owner is provably gone may be broken; a lock whose owner
 *    cannot be verified may NOT be broken on age alone;
 *  - release is guaranteed by the caller (finally) and is ownership-checked, so
 *    a process whose lock was broken and re-taken cannot delete the new owner's
 *    lock;
 *  - nested (re)acquisition in one process fails loudly rather than deadlocking;
 *  - failure to acquire returns null — callers MUST treat that as "do not
 *    proceed" (fail-closed), never as "proceed without the lock".
 *
 * The critical section a holder runs must be SYNCHRONOUS (no await while held):
 * the in-process reentrancy guard tracks a plain set, and an await inside the
 * critical section would let a second concurrent acquisition see the set
 * populated and mistake concurrency for nesting.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const MAIL_LOCK_DIR = ".mail-lock";
const OWNER_FILE = "owner.json";
const TEMP_PREFIX = `${MAIL_LOCK_DIR}.tmp.`;
// Stranded build-temps hold no claim; reap only ones old enough that they cannot
// be an in-flight acquisition (this is cleanup policy, not a safety property).
const TEMP_MAX_AGE_MS = 10 * 60 * 1000;

export interface MailLock {
  /** Release the lock. Ownership-checked; safe to call once. */
  release(): void;
}

/** The lock directory for a mailbox root. */
export function mailLockPath(root: string): string {
  return join(root, MAIL_LOCK_DIR);
}

/** Roots currently held by THIS process (reentrancy guard). */
const heldByThisProcess = new Set<string>();

/** A stable per-process identity token: its kernel start time, or null if unreadable. */
export function processStartToken(pid: number): string | null {
  try {
    // /proc/<pid>/stat: field 22 is starttime (clock ticks). The `comm` field
    // (2) may contain spaces and parentheses, so split after the LAST ')'.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const rparen = stat.lastIndexOf(")");
    if (rparen === -1) return null;
    const fields = stat.slice(rparen + 2).split(" ");
    // fields[0] is field 3 (state); starttime is field 22 → fields[19].
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // ESRCH: no such process. EPERM: exists but owned by someone else — alive.
    return err?.code !== "ESRCH";
  }
}

interface LockOwner {
  pid?: unknown;
  startToken?: unknown;
}

function readOwner(lockDir: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(join(lockDir, OWNER_FILE), "utf-8")) as LockOwner;
  } catch {
    return null;
  }
}

/**
 * Classify a lock's owner: "dead" only when provably gone (pid gone, or pid
 * alive with a DIFFERENT start time = a reused pid). Everything unverifiable is
 * "unknown" and must not be broken on age alone.
 */
function ownerState(owner: LockOwner | null): "alive" | "dead" | "unknown" {
  if (!owner || typeof owner.pid !== "number") return "unknown";
  if (!isPidAlive(owner.pid)) return "dead";
  const token = processStartToken(owner.pid);
  if (token !== null && typeof owner.startToken === "string") {
    return token === owner.startToken ? "alive" : "dead";
  }
  // pid is alive and we cannot disprove it — never break.
  return "alive";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Reap stranded lock build-temps (crash between mkdir and rename). */
function reapStrandedLockTemps(root: string): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - TEMP_MAX_AGE_MS;
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const p = join(root, name);
    try {
      if (statSync(p).mtimeMs > cutoff) continue; // may be an in-flight build
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Acquire the mailbox lock, polling until `timeoutMs`. Returns null on timeout
 * (caller must not proceed). Throws on nested acquisition for the same root.
 */
export async function acquireMailLock(
  root: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<MailLock | null> {
  const { timeoutMs = 2000, pollMs = 25 } = opts;
  const lockDir = mailLockPath(root);

  if (heldByThisProcess.has(lockDir)) {
    throw new Error(`mail lock already held by this process for ${root} (nested acquisition)`);
  }

  mkdirSync(root, { recursive: true });
  reapStrandedLockTemps(root);
  const deadline = Date.now() + timeoutMs;
  const myToken = processStartToken(process.pid);

  const makeLock = (): MailLock => {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        releaseMailLock(lockDir);
      },
    };
  };

  for (;;) {
    // Build a POPULATED lock in a unique temp dir, then rename it onto the lock
    // path. The rename is the atomic claim: renaming a dir onto a non-empty dir
    // fails (EEXIST/ENOTEMPTY), so there is no window where the lock exists
    // unowned, and a crash mid-acquire leaves only a harmless temp dir.
    const tmpDir = join(root, `${TEMP_PREFIX}${process.pid}.${randomBytes(6).toString("hex")}`);
    try {
      mkdirSync(tmpDir);
      writeFileSync(
        join(tmpDir, OWNER_FILE),
        JSON.stringify({ pid: process.pid, startToken: myToken }),
        "utf-8",
      );
    } catch (err) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw err;
    }

    try {
      renameSync(tmpDir, lockDir);
      heldByThisProcess.add(lockDir);
      return makeLock();
    } catch (err: any) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      const code = err?.code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EISDIR" && code !== "ENOTDIR") {
        throw err;
      }
    }

    // Held. An UNOWNED lock (no owner.json) is a legacy artifact of the previous
    // mkdir-then-stamp code and is unreachable after this change; break it so an
    // upgrade cannot inherit a permanent wedge. Otherwise break only a
    // provably-dead owner.
    if (!existsSync(join(lockDir, OWNER_FILE)) || ownerState(readOwner(lockDir)) === "dead") {
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        /* someone else may have broken it first */
      }
      continue;
    }

    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

function releaseMailLock(lockDir: string): void {
  heldByThisProcess.delete(lockDir);
  const owner = readOwner(lockDir);
  // Ownership-checked: only remove a lock we still own. If it was broken and
  // re-taken, the owner differs and we leave it alone.
  if (owner && owner.pid === process.pid) {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
