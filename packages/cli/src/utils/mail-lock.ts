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
 *  - a lock with no USABLE owner (owner.json missing, unreadable, unparseable,
 *    or without a numeric pid) may be broken — there is no owner to protect;
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

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
}

type OwnerState = "alive" | "dead" | "unverifiable" | "unowned";

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
 * "unowned" — the lock carries no USABLE owner: owner.json missing, unreadable,
 * unparseable, or without a numeric pid. Classify by usability, not by which
 * corruption shape it is: a file that parses but has no pid is as unowned as a
 * truncated one. Anything but a numeric pid is unusable.
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
    return "unowned";
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

  // Resolve an owner's birth token ONCE per pid per attempt — processStartToken
  // may fork `ps`, and polling every 25 ms must not fork it repeatedly. A pid's
  // birth time is constant for its lifetime, so caching within an attempt is
  // sound.
  const tokenCache = new Map<number, string | null>();
  const resolveToken = (pid: number): string | null => {
    if (!tokenCache.has(pid)) tokenCache.set(pid, processStartToken(pid));
    return tokenCache.get(pid)!;
  };

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

    // Break ONLY a lock with no owner to protect — an UNOWNED lock (owner.json
    // missing, unreadable, unparseable, or without a numeric pid) or a
    // provably-dead owner. After the atomic acquire, this code creates a lock
    // only by renaming a fully-populated temp dir, so a corrupt owner.json
    // cannot be produced by this code: it is legacy or external, and neither is
    // an owner to protect. A live or unverifiable owner is waited on.
    const state = ownerState(readOwner(lockDir), resolveToken);
    if (state === "unowned" || state === "dead") {
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
