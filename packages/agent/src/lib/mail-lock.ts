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
 *    an unverifiable token (another source, or a differing `ps:` token) is
 *    retained;
 *  - acquisition and stale reclamation share an atomic claim;
 *  - a stranded claim requires operator recovery;
 *  - release checks the acquisition nonce;
 *  - nested (re)acquisition in one process fails loudly rather than deadlocking;
 *  - an unreadable owner, or one whose pid is not an integer in 1..2147483647,
 *    can cause a contention timeout returning null; other filesystem errors may throw.
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
 * Fields of `/proc/<pid>/stat` after the `comm` field (2), or null when the
 * file is unreadable or contains no ')'; a truncated line yields fewer fields,
 * which callers treat as absent. `comm` may contain spaces and parentheses,
 * so the fields are split after the LAST ')'. fields[0] is field 3 (state);
 * starttime is field 22 → fields[19].
 */
function readProcStatFields(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const rparen = stat.lastIndexOf(")");
    if (rparen === -1) return null;
    return stat.slice(rparen + 2).split(" ");
  } catch {
    return null;
  }
}

/**
 * A per-process identity token — its birth time — or null only when it cannot
 * be read at all.
 *
 * Two sources, so it is portable: `/proc/<pid>/stat` (Linux; field 22 is
 * starttime), and `ps -o lstart= -p <pid>` (Darwin and Linux). Without the
 * fallback the token is always null on Darwin, and owner identity degrades to
 * pid alone — exactly the pid-reuse confusion this token exists to prevent.
 *
 * `ps` renders `lstart` in the CALLING process's timezone and locale, so the
 * fallback runs it with TZ=UTC and LC_ALL=C: one live process then yields one
 * `ps:` token whichever environment reads it (cli#1045). A `ps:` token written
 * before that pin may hold local-time text, which is why ownerState does not
 * read a `ps:` mismatch as pid reuse.
 */
export function processStartToken(pid: number): string | null {
  const fields = readProcStatFields(pid);
  if (fields) {
    const token = fields[19];
    if (token) return `proc:${token}`;
  }
  // Portable fallback. `lstart` is rendered in the caller's TZ and locale;
  // pinning both makes the text the same in every reader of one process.
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    });
    const token = out.trim();
    if (token) return `ps:${token}`;
  } catch {
    /* unreadable */
  }
  return null;
}

/** Error codes taken as process.kill rejecting its argument; Bun and Node raise ERR_INVALID_ARG_TYPE for a pid above 2147483647. */
const PID_ARGUMENT_ERRORS = new Set(["ERR_INVALID_ARG_TYPE", "ERR_OUT_OF_RANGE", "EINVAL", "ERANGE"]);

export type PidState = "alive" | "gone" | "invalid";

/** The classifier's integer-and-positive precheck: an integer of at least 1.
 *  pidState can still classify a larger integer as invalid after process.kill
 *  rejects it as an argument (PID_ARGUMENT_ERRORS). */
export function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid >= 1;
}

/**
 * Probe a recorded pid with `process.kill(pid, 0)`. "invalid": not an integer
 * of at least 1 (0 and negative pids do not name one process), or a pid
 * process.kill rejects as an argument. "gone": ESRCH, or on Linux a pid whose
 * `/proc/<pid>/stat` state is `Z` (exited but not reaped). "alive": the probe
 * succeeds or fails with any other error, EPERM (permission denied) included;
 * an unreadable stat file keeps "alive".
 */
export function pidState(pid: number, readStat: (pid: number) => string[] | null = readProcStatFields): PidState {
  if (!isValidPid(pid)) return "invalid";
  try {
    process.kill(pid, 0);
    if (process.platform === "linux" && readStat(pid)?.[0] === "Z") return "gone";
    return "alive";
  } catch (error) {
    return pidStateFromProbeError(error);
  }
}

/** How pidState classifies an error thrown by `process.kill(pid, 0)`. */
export function pidStateFromProbeError(error: unknown): PidState {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "ESRCH") return "gone";
  if (typeof code === "string" && PID_ARGUMENT_ERRORS.has(code)) return "invalid";
  return "alive";
}

export interface LockOwner {
  pid?: unknown;
  startToken?: unknown;
  nonce?: unknown;
}

export type OwnerState = "alive" | "dead" | "unverifiable";

/** A `proc:` token that carries a value. Two differing tokens of this form are classified as reuse ("dead");
 *  the value is not otherwise validated, so a malformed recorded value also compares as a difference. */
const PROC_TOKEN = /^proc:.+$/;

export type OwnerTokenState = "alive" | "dead" | "unverifiable";

/**
 * The one rule for comparing a LIVE pid's current start token with the token
 * recorded for it (cli#1045). The agent mail lock and pid files, the cli outbox
 * per-delivery lock, pid files, launch snapshot sweep, host-state ownership
 * and released-agent identity use it. A gone pid is the caller's to classify
 * (dead) before it gets here.
 *
 * "alive" — the tokens are equal.
 * "unverifiable" — anything else that differs: a differing `ps:` token, one
 * from another source, or a token that is not a `proc:` token with a value (a
 * bare `proc`, an empty `proc:`). `ps` text depended on the reader's timezone
 * and locale until cli#1045 pinned them, and a token written before the pin,
 * or by a process still running older code, may hold local-time text, so a
 * `ps:` mismatch cannot prove reuse.
 * "dead" — two differing `proc:` tokens with values: /proc starttime is
 * kernel-stable, so a different value proves the pid was reused. Only these
 * prove reuse.
 */
export function classifyOwnerToken(liveToken: string, recordedToken: string): OwnerTokenState {
  if (liveToken === recordedToken) return "alive";
  return PROC_TOKEN.test(liveToken) && PROC_TOKEN.test(recordedToken) ? "dead" : "unverifiable";
}

function readOwner(lockDir: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(join(lockDir, OWNER_FILE), "utf-8")) as LockOwner;
  } catch {
    return null;
  }
}

/**
 * Classify a lock's owner. Exported for tests (the token resolver is
 * injectable); the package index does not export it.
 *
 * "dead" — pid gone (whatever its token's source). For a live pid with both
 * tokens readable, classifyOwnerToken decides: a differing `proc:` token is
 * dead (reuse); a differing `ps:` token, or one from the other source, is
 * "unverifiable". Treating those as dead would break a live owner's lock (two
 * owners), the race this lock exists to prevent. Everything unverifiable is
 * neither broken on age nor mistaken for dead.
 */
export function ownerState(
  owner: LockOwner | null,
  resolveToken: (pid: number) => string | null = processStartToken,
): OwnerState {
  if (!owner || typeof owner.pid !== "number") return "unverifiable";
  // An invalid pid is handled as an unreadable owner record is.
  const pid = pidState(owner.pid);
  if (pid === "invalid") return "unverifiable";
  if (pid === "gone") return "dead";
  const token = resolveToken(owner.pid);
  if (token !== null && typeof owner.startToken === "string") return classifyOwnerToken(token, owner.startToken);
  // pid is alive and we cannot disprove it — never break.
  return "unverifiable";
}

/**
 * cli#617 slice (b): is the process named by (pid, start token) provably gone?
 * The same rule a lock owner is reclaimed by (ownerState): the pid is gone, or
 * it is alive with a different `proc:` start token. A live pid whose identity
 * cannot be checked — a differing `ps:` token included (cli#1045) — is NOT gone.
 */
export function processIsGone(pid: number, startToken: string | null): boolean {
  return ownerState({ pid, startToken }) === "dead";
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
  const attempt = mailLockAttempts(root, opts);
  for (;;) {
    const step = attempt.next();
    if (step.done) return step.value;
    await sleep(step.value);
  }
}

export function acquireMailLockSync(
  root: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): MailLock | null {
  const attempt = mailLockAttempts(root, opts);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const step = attempt.next();
    if (step.done) return step.value;
    Atomics.wait(wait, 0, 0, step.value);
  }
}

function* mailLockAttempts(
  root: string,
  opts: { timeoutMs?: number; pollMs?: number },
): Generator<number, MailLock | null, void> {
  // `pollMs` overrides the default retry interval of 2 ms.
  const { timeoutMs = 2000, pollMs = 2 } = opts;
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
    yield pollMs;
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
