/**
 * Strict pid-file parsing shared by the mail relay and bridge pid files.
 *
 * A current record is one JSON object per file:
 *
 *   {"pid":12345,"startToken":"proc:1234567"}
 *
 * `startToken` is `processStartToken(pid)` from `@tpsdev-ai/agent` — the same
 * per-process birth identity the mail lock uses (on macOS that identity
 * resolves to one second). A record whose token is null
 * cannot verify the process later.
 *
 * A legacy file is a bare decimal pid or a JSON object without `startToken`
 * (the bridge used to write `{pid, adapter}`). It names a process but cannot
 * prove that process is the one that wrote the file.
 *
 * Accepted forms: surrounding whitespace is trimmed; the content is either a
 * decimal integer without leading zeroes, 1..2147483647, or a JSON object whose
 * top-level `pid` is such an integer and whose `startToken` is a non-empty
 * string, null or absent.
 * Other JSON fields are ignored. Anything else is invalid.
 *
 * A JSON record is classified by one JSON.parse, so a duplicate key has one
 * interpretation: the last one.
 */

import { closeSync, constants, fstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { processIsGone, processStartToken } from "@tpsdev-ai/agent";

export interface PidRecord {
  pid: number;
  startToken: string | null;
}

export type ParsedPidFile =
  | { kind: "record"; pid: number; startToken: string | null }
  | { kind: "invalid"; reason: string };

const WHOLE_PID = /^[1-9]\d*$/;

export function isPidRecordPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid >= 1 && pid <= 2147483647;
}

export function isPidRecordStartToken(token: unknown): token is string | null | undefined {
  return token === undefined || token === null || (typeof token === "string" && token.length > 0);
}

/** Serialize a pid record. `startToken` may be null when it cannot be read. */
export function serializePidRecord(pid: number, startToken: string | null): string {
  return `${JSON.stringify({ pid, startToken })}\n`;
}

function invalid(reason: string): ParsedPidFile {
  return { kind: "invalid", reason };
}

function parseJsonRecord(text: string): ParsedPidFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid("not a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalid("not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const pid = record.pid;
  if (!isPidRecordPid(pid)) {
    return invalid("pid is not an integer in 1..2147483647");
  }
  const token = record.startToken;
  if (!isPidRecordStartToken(token)) {
    return invalid(typeof token === "string" ? "startToken is empty" : "startToken is not a string");
  }
  return { kind: "record", pid, startToken: typeof token === "string" ? token : null };
}

/**
 * Parse relay and bridge pid-file content. Accepted: after trimming surrounding
 * whitespace, a decimal integer without leading zeroes, 1..2147483647, or a
 * JSON object whose top-level `pid` is such an integer and whose `startToken`
 * is a non-empty string, null or absent. Other JSON fields are ignored;
 * anything else is invalid.
 */
export function parsePidFile(raw: string): ParsedPidFile {
  const text = raw.trim();
  if (text === "") return invalid("empty");
  if (text.startsWith("{")) return parseJsonRecord(text);
  if (!WHOLE_PID.test(text)) return invalid("pid is not a whole positive decimal integer");
  const pid = Number(text);
  if (!isPidRecordPid(pid)) return invalid("pid is not an integer in 1..2147483647");
  return { kind: "record", pid, startToken: null };
}

export interface PidRecordSnapshot {
  state: PidFileState;
  raw: Buffer | null;
}

/** Read a pid record and keep the bytes the classification was made from.
 *  A failed read yields `raw: null`. */
export function snapshotPidRecord(path: string): PidRecordSnapshot {
  let bytes: Buffer | null = null;
  const state = readPidFile(path, processStartToken, (_text, raw) => {
    bytes = raw;
  });
  return { state, raw: bytes };
}

/** Byte equality for two snapshots' raw file contents; a failed read is only
 *  equal to another failed read. */
export function pidRecordBytesEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

export type PidFileRemoval = "removed" | "already gone";

/**
 * Remove a pid file and report what happened. "removed" means the unlink
 * succeeded in this call; a file that was already absent is "already gone".
 * Any other error (EACCES, EISDIR) propagates.
 */
export function removePidFile(path: string): PidFileRemoval {
  try {
    unlinkSync(path);
    return "removed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "already gone";
    throw error;
  }
}

export type PidFileState =
  | { kind: "missing" }
  | { kind: "unreadable"; path: string; reason?: string }
  | { kind: "invalid"; path: string; reason: string }
  | { kind: "stale"; path: string; pid: number }
  | { kind: "running"; path: string; pid: number; startToken: string }
  | { kind: "unverified"; path: string; pid: number; startToken: string | null };

/**
 * Classify a pid file, reading only a regular file from its opened descriptor.
 *
 * "stale" — the recorded pid is gone, or the pid is alive and its current
 * start token differs from the recorded token (same source, `processIsGone`).
 * "running" — the pid is alive and its current start token equals the recorded
 * one. "unverified" — the pid is not proven gone and its identity is not
 * confirmed; a caller must not signal it. A pid outside 1..2147483647 is
 * "invalid", never "unverified".
 */
export function readPidFile(
  path: string,
  resolveToken: (pid: number) => string | null = processStartToken,
  onRead?: (raw: string, bytes: Buffer) => void,
): PidFileState {
  let fd: number;
  try {
    // Platforms without O_NONBLOCK or O_NOFOLLOW use the available flags.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "ENOENT") return { kind: "missing" };
    const reason = code === "ELOOP" ? "could not be opened (ELOOP: symlink resolution refused)" : `could not be opened (${code})`;
    return { kind: "unreadable", path, reason };
  }
  let raw: string;
  let bytes: Buffer;
  try {
    try {
      if (!fstatSync(fd).isFile()) return { kind: "unreadable", path, reason: "is not a regular file" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      return { kind: "unreadable", path, reason: `could not be inspected (${code})` };
    }
    bytes = readFileSync(fd);
    raw = bytes.toString("utf-8");
  } catch {
    return { kind: "unreadable", path };
  } finally {
    closeSync(fd);
  }
  onRead?.(raw, bytes);
  const parsed = parsePidFile(raw);
  if (parsed.kind === "invalid") return { kind: "invalid", path, reason: parsed.reason };
  if (processIsGone(parsed.pid, parsed.startToken)) {
    return { kind: "stale", path, pid: parsed.pid };
  }
  if (parsed.startToken !== null && resolveToken(parsed.pid) === parsed.startToken) {
    return { kind: "running", path, pid: parsed.pid, startToken: parsed.startToken };
  }
  return { kind: "unverified", path, pid: parsed.pid, startToken: parsed.startToken };
}
