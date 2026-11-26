/**
 * TPS Mail Relay — standalone daemon that routes outbox → recipient inboxes.
 *
 * Watches all {mailDir}/*\/outbox/ dirs, moves messages to {mailDir}/{to}/new/.
 * Runs as a separate process: `tps mail relay start|stop|status`
 *
 * This is the correct mail infrastructure, not a per-agent hack. Eventually
 * this becomes the bridge to remote agents over wire protocol.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { processStartToken } from "@tpsdev-ai/agent";
import snooplogg from "snooplogg";
import { homeDir } from "./home.js";
import { acquireMailLockSync, mailLockPath } from "./mail-lock.js";
import { pidRecordBytesEqual, removePidFile, serializePidRecord, snapshotPidRecord, type PidFileState, type PidRecordSnapshot } from "./pid-file.js";
const { log: slog, warn: swarn, error: serror } = snooplogg("tps:mail");


/** The relay pid file path. */
export function relayPidPath(): string {
  return join(homeDir(), ".tps", "relay.pid");
}
const RELAY_POLL_MS = 500;

/** agentId validation — same rule as everywhere else */
function isValidAgentId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

/**
 * Scan all agent outboxes and deliver messages to recipient inboxes.
 * Returns number of messages delivered.
 */
export function deliverPendingMail(mailDir: string): number {
  let delivered = 0;

  if (!existsSync(mailDir)) return 0;

  const agents = readdirSync(mailDir).filter((d) => isValidAgentId(d));

  for (const agent of agents) {
    const outbox = join(mailDir, agent, "outbox");
    if (!existsSync(outbox)) continue;

    const files = readdirSync(outbox).filter(
      (f) => !f.startsWith(".") && f.endsWith(".json"),
    );

    for (const file of files) {
      const srcPath = join(outbox, file);
      try {
        const raw = readFileSync(srcPath, "utf-8");
        const msg = JSON.parse(raw) as {
          to: string;
          body: string;
          sentAt: string;
        };

        if (!msg.to || !isValidAgentId(msg.to)) {
          // Invalid recipient — dead-letter (move to dead/ dir)
          const dead = join(mailDir, agent, "dead");
          mkdirSync(dead, { recursive: true });
          renameSync(srcPath, join(dead, file));
          continue;
        }

        const recipientInbox = join(mailDir, msg.to, "new");
        mkdirSync(recipientInbox, { recursive: true });

        // Stable filename: sentAt + original filename (prevents collisions)
        const safeTs = (msg.sentAt ?? new Date().toISOString()).replace(
          /[:.]/g,
          "-",
        );
        const destFile = `${safeTs}-${agent}-${file}`;
        renameSync(srcPath, join(recipientInbox, destFile));

        delivered++;
      } catch {
        // Leave in outbox — will retry next poll
      }
    }
  }

  return delivered;
}

export const RELAY_PID_LOCK_TIMEOUT_MS = 5000;

/** A lock acquired after a caller's shared deadline. Callers treat it as a stop
 *  condition, not another attempt failure, so the last real failure can stay
 *  the reported reason. */
export class RelayPidLockDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayPidLockDeadlineError";
  }
}

/** The lock root for the relay pid record. The record lock is separate from the
 *  record path so a claim under the record path stays the exclusive create. */
export function relayPidLockRoot(path: string = relayPidPath()): string {
  return `${path}.lock`;
}

/** Hold the relay pid record lock across a synchronous critical section. A
 *  timeout is a refusal, not a proceed. A caller with a shared budget passes
 *  the remaining time and the deadline; the deadline is re-checked under the
 *  lock so a late acquisition cannot start another critical section. */
export function withRelayPidLock<T>(
  action: string,
  fn: () => T,
  budget?: { timeoutMs?: number; deadline?: number },
): T {
  const root = relayPidLockRoot();
  const timeoutMs = budget?.timeoutMs ?? RELAY_PID_LOCK_TIMEOUT_MS;
  const lock = acquireMailLockSync(root, { timeoutMs });
  if (lock === null) {
    throw new Error(
      `Mail relay pid record lock ${mailLockPath(root)} could not be acquired within ${timeoutMs} ms; refusing to ${action}.`,
    );
  }
  try {
    if (budget?.deadline !== undefined) {
      relayWriteTestHooks.beforeDeadlineCheck?.(budget.deadline);
      if (Date.now() >= budget.deadline) {
        throw new RelayPidLockDeadlineError(
          `Mail relay pid record lock ${mailLockPath(root)} was acquired after the handoff deadline; refusing to ${action}.`,
        );
      }
    }
    return fn();
  } finally {
    lock.release();
  }
}

export function serializeRelayClaimRecord(pid: number, startToken: string | null): string {
  return `${JSON.stringify({ pid, startToken, relayClaim: true })}\n`;
}

function isRelayClaim(raw: Buffer | null): boolean {
  if (raw === null) return false;
  try {
    const parsed = JSON.parse(raw.toString("utf-8")) as unknown;
    return typeof parsed === "object" && parsed !== null && (parsed as { relayClaim?: unknown }).relayClaim === true;
  } catch {
    return false;
  }
}

/** Keep abandoned start claims: their children may still be running. */
export function classifyRelayPidSnapshot(snapshot: PidRecordSnapshot): RelayPidState {
  const state = snapshot.state;
  if (state.kind === "stale" && isRelayClaim(snapshot.raw)) {
    return { kind: "abandoned-claim", path: state.path, pid: state.pid };
  }
  if ((state.kind === "running" || state.kind === "unverified") && isRelayClaim(snapshot.raw)) {
    return { kind: "claim", path: state.path, pid: state.pid, startToken: state.startToken, identityVerified: state.kind === "running" };
  }
  return state;
}

/** Read the relay pid record and keep the bytes the classification used. */
export function snapshotRelayPidRecord(): { state: RelayPidState; raw: Buffer | null } {
  const snapshot = snapshotPidRecord(relayPidPath());
  return { state: classifyRelayPidSnapshot(snapshot), raw: snapshot.raw };
}

/** Test hooks: `writeRecordBytes` replaces the exclusive create-and-fill step
 *  (so a failure can be injected at the write), and `afterTempWrite` observes
 *  between the temporary write and its publication. */
export const relayWriteTestHooks: {
  afterTempWrite?: (tmpPath: string, recordPath: string) => void;
  writeRecordBytes?: (path: string, text: string) => void;
  beforeDeadlineCheck?: (deadline: number) => void;
} = {};

function writeRecordBytes(path: string, text: string): void {
  if (relayWriteTestHooks.writeRecordBytes) {
    relayWriteTestHooks.writeRecordBytes(path, text);
    return;
  }
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function tempRecordPath(path: string): string {
  return join(dirname(path), `.relay.pid.tmp.${process.pid}.${randomBytes(6).toString("hex")}`);
}

/** Create the record at a free path; EEXIST means another claimant won. The
 *  record bytes are complete before the hard link publishes them, and the
 *  temporary file is removed in a finally block. */
export function claimRelayPidRecord(path: string, text: string): void {
  const tmp = tempRecordPath(path);
  try {
    writeRecordBytes(tmp, text);
    linkSync(tmp, path);
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Rename a same-directory temporary file over an existing record without
 *  exposing partial bytes; an absent path stays absent until the rename. */
export function writeRelayPidRecordAtomically(path: string, text: string): void {
  const tmp = tempRecordPath(path);
  try {
    writeRecordBytes(tmp, text);
    relayWriteTestHooks.afterTempWrite?.(tmp, path);
    renameSync(tmp, path);
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Try to remove the relay's matching record on SIGTERM or SIGINT. */
function removeOwnPidFile(ownRecord: string): void {
  const path = relayPidPath();
  const ownBytes = Buffer.from(ownRecord, "utf-8");
  try {
    withRelayPidLock("remove the relay pid record", () => {
      const snapshot = snapshotPidRecord(path);
      if (snapshot.state.kind === "missing" || snapshot.raw === null) return;
      if (!pidRecordBytesEqual(snapshot.raw, ownBytes)) return;
      removePidFile(path);
    });
  } catch {
    /* exit path: nothing left to report to */
  }
}

/**
 * Run the relay daemon loop. Polls until SIGTERM/SIGINT.
 */
export async function runRelayDaemon(mailDir: string): Promise<void> {
  // Write the pid file. The writer attempts to record a start token; the agent
  // API may return null or a token derived from ps, so the record can carry
  // either. A stop compares a non-null token with the live process's token; a
  // null token is never compared — with a live pid the record is unverified, so
  // a stop refuses it.
  mkdirSync(join(homeDir(), ".tps"), { recursive: true });
  const ownRecord = serializePidRecord(process.pid, processStartToken(process.pid));
  withRelayPidLock("write the relay pid record", () => writeRelayPidRecordAtomically(relayPidPath(), ownRecord));

  process.on("SIGTERM", () => {
    removeOwnPidFile(ownRecord);
    process.exit(0);
  });
  process.on("SIGINT", () => {
    removeOwnPidFile(ownRecord);
    process.exit(0);
  });

  slog(
    `[relay] TPS mail relay started (pid=${process.pid}, mailDir=${mailDir})`,
  );

  while (true) {
    try {
      const n = deliverPendingMail(mailDir);
      if (n > 0) slog(`[relay] Delivered ${n} message(s)`);
    } catch (err: any) {
      serror(`[relay] Error:`, err?.message ?? err);
    }
    await new Promise((r) => setTimeout(r, RELAY_POLL_MS));
  }
}

export type RelayPidState =
  | PidFileState
  | { kind: "abandoned-claim"; path: string; pid: number }
  | { kind: "claim"; path: string; pid: number; startToken: string | null; identityVerified: boolean };

export function describeRelayClaim(state: Extract<RelayPidState, { kind: "claim" }>): string {
  return state.identityVerified
    ? `The start claim names a live process (pid ${state.pid}) whose start token matches the claim; it may or may not have started a relay (pid file ${state.path}).`
    : `The start claim names pid ${state.pid}, which could not be shown to have exited; whether it is the claimant could not be verified (pid file ${state.path}).`;
}

/** Classify the relay pid file. */
export function readRelayPidFile(): RelayPidState {
  return classifyRelayPidSnapshot(snapshotPidRecord(relayPidPath()));
}

