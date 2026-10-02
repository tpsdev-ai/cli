/**
 * mail-lock.ts — a small inter-process lock for maildir mutation.
 *
 * Moved from the CLI for use by both first-delivery paths.
 *
 * Why it exists: the replay ledger is read-modify-written (prune) and appended,
 * and the promotion moves files; without mutual exclusion, two concurrent
 * promotions can both pass the replay gate before either records the id, and an
 * append can land between a prune's read and its rename and be lost. The lock
 * must span the whole replay-check → promotion-commit/rollback critical section,
 * including the ledger prune and append.
 *
 * Properties:
 *  - normal acquisition publishes a populated lock directory by rename;
 *  - ownership uses pid and process start time when readable; a live pid with
 *    an unverifiable token is retained;
 *  - acquisition and stale reclamation share an atomic claim;
 *  - a stranded claim requires operator recovery;
 *  - release checks the acquisition nonce;
 *  - nested (re)acquisition in one process fails loudly rather than deadlocking;
 *  - failure to acquire returns null — callers MUST treat that as "do not
 *    proceed" (fail-closed), never as "proceed without the lock".
 *
 * The critical section a holder runs must be SYNCHRONOUS (no await while held):
 * the in-process reentrancy guard tracks a plain set, and an await inside the
 * critical section would let a second concurrent acquisition see the set
 * populated and mistake concurrency for nesting.
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const MAIL_LOCK_DIR = ".mail-lock";
const OWNER_FILE = "owner.json";
const TEMP_PREFIX = `${MAIL_LOCK_DIR}.tmp.`;
// Best-effort cleanup of old build-temps; age does not prove inactivity.
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

/**
 * A stable per-process identity token — its kernel birth time — or null only
 * when it cannot be read at all.
 *
 * Two sources, so it is portable: `/proc/<pid>/stat` (Linux; field 22 is
 * starttime), and `ps -o lstart= -p <pid>` (Darwin and Linux). Without the
 * fallback the token is always null on Darwin, and owner identity degrades to
 * pid alone — exactly the pid-reuse confusion this token exists to prevent.
 */
export function processStartToken(pid: number): string | null {
  // /proc/<pid>/stat: the `comm` field (2) may contain spaces and parentheses,
  // so split after the LAST ')'. fields[0] is field 3 (state); starttime is
  // field 22 → fields[19].
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const rparen = stat.lastIndexOf(")");
    if (rparen !== -1) {
      const token = stat.slice(rparen + 2).split(" ")[19];
      if (token) return `proc:${token}`;
    }
  } catch {
    /* fall through to ps */
  }
  // Portable fallback — `lstart` is a stable per-process birth time string.
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const token = out.trim();
    if (token) return `ps:${token}`;
  } catch {
    /* unreadable */
  }
  return null;
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
  nonce?: unknown;
}

type OwnerState = "alive" | "dead" | "unverifiable";

/** The source component of a birth token (`proc:` / `ps:`), or the whole string. */
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

/**
 * Classify a lock's owner.
 *
 * "dead" — pid gone, or pid alive with a DIFFERENT token FROM THE SAME SOURCE.
 * A token from a different source (`proc:` vs `ps:`) for the same live process
 * is "unverifiable", NOT dead — treating it as dead would break a live owner's
 * lock (two owners), the race this lock exists to prevent. Everything
 * unverifiable is neither broken on age nor mistaken for dead.
 */
function ownerState(
  owner: LockOwner | null,
  resolveToken: (pid: number) => string | null = processStartToken,
): OwnerState {
  if (!owner || typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return "unverifiable";
  }
  if (!isPidAlive(owner.pid)) return "dead";
  const token = resolveToken(owner.pid);
  if (token !== null && typeof owner.startToken === "string") {
    if (tokenSource(token) !== tokenSource(owner.startToken)) return "unverifiable";
    return token === owner.startToken ? "alive" : "dead";
  }
  // pid is alive and we cannot disprove it — never break.
  return "unverifiable";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Attempt to reap old lock build-temps. */
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
  const nonce = randomBytes(16).toString("hex");
  const claimDir = join(root, `${MAIL_LOCK_DIR}.claim`);

  const makeLock = (): MailLock => {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        releaseMailLock(lockDir, nonce);
      },
    };
  };

  for (;;) {
    let claimed = false;
    try {
      try {
        mkdirSync(claimDir);
        claimed = true;
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;
      }
      if (claimed) {
        if (heldByThisProcess.has(lockDir)) throw new Error(`mail lock already held by this process for ${root}`);
        let lockExists = true;
        try {
          lstatSync(lockDir);
        } catch (err: any) {
          if (err?.code !== "ENOENT") throw err;
          lockExists = false;
        }
        if (lockExists && ownerState(readOwner(lockDir)) === "dead") {
          rmSync(lockDir, { recursive: true });
          lockExists = false;
        }
        if (!lockExists) {
          const tmpDir = join(root, `${TEMP_PREFIX}${process.pid}.${nonce}`);
          try {
            mkdirSync(tmpDir);
            writeFileSync(join(tmpDir, OWNER_FILE), JSON.stringify({ pid: process.pid, startToken: myToken, nonce }), "utf-8");
            renameSync(tmpDir, lockDir);
            heldByThisProcess.add(lockDir);
            return makeLock();
          } finally {
            rmSync(tmpDir, { recursive: true, force: true });
          }
        }
      }
    } finally {
      if (claimed) rmSync(claimDir, { recursive: true });
    }
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

function releaseMailLock(lockDir: string, nonce: string): void {
  heldByThisProcess.delete(lockDir);
  const owner = readOwner(lockDir);
  if (owner && owner.pid === process.pid && owner.nonce === nonce) {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
