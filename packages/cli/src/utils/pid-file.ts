/**
 * Strict pid-file parsing shared by the mail relay and bridge pid files.
 *
 * A current record is one JSON object per file:
 *
 *   {"pid":12345,"startToken":"proc:1234567"}
 *
 * `startToken` is `processStartToken(pid)` from `@tpsdev-ai/agent` — the same
 * per-process birth identity the mail lock uses. A record whose token is null
 * cannot verify the process later.
 *
 * A legacy file is a bare decimal pid or a JSON object without `startToken`
 * (the bridge used to write `{pid, adapter}`). It names a process but cannot
 * prove that process is the one that wrote the file.
 *
 * Accepted forms: surrounding whitespace is trimmed; the content is either a
 * bare decimal integer 1..2147483647, or a JSON object whose top-level `pid` is
 * such an integer and whose `startToken` is a non-empty string, null or absent.
 * Other JSON fields are ignored. Anything else is invalid.
 *
 * A JSON record is classified by one JSON.parse, so a duplicate key has one
 * interpretation: the last one.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { processIsGone, processStartToken } from "@tpsdev-ai/agent";

export interface PidRecord {
  pid: number;
  startToken: string | null;
}

export type ParsedPidFile =
  | { kind: "record"; pid: number; startToken: string | null }
  | { kind: "invalid"; reason: string };

const WHOLE_PID = /^[1-9]\d*$/;

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
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1 || pid > 2147483647) {
    return invalid("pid is not an integer in 1..2147483647");
  }
  const token = record.startToken;
  if (token !== undefined && token !== null && typeof token !== "string") {
    return invalid("startToken is not a string");
  }
  if (typeof token === "string" && token.length === 0) {
    return invalid("startToken is empty");
  }
  return { kind: "record", pid, startToken: typeof token === "string" ? token : null };
}

/**
 * Parse relay and bridge pid-file content. Accepted: after trimming surrounding
 * whitespace, a bare decimal integer 1..2147483647, or a JSON object whose
 * top-level `pid` is such an integer and whose `startToken` is a non-empty
 * string, null or absent. Other JSON fields are ignored; anything else is
 * invalid.
 */
export function parsePidFile(raw: string): ParsedPidFile {
  const text = raw.trim();
  if (text === "") return invalid("empty");
  if (text.startsWith("{")) return parseJsonRecord(text);
  if (!WHOLE_PID.test(text)) return invalid("pid is not a whole positive decimal integer");
  const pid = Number(text);
  if (pid > 2147483647) return invalid("pid is not an integer in 1..2147483647");
  return { kind: "record", pid, startToken: null };
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
  | { kind: "unreadable"; path: string }
  | { kind: "invalid"; path: string; reason: string }
  | { kind: "stale"; path: string; pid: number }
  | { kind: "running"; path: string; pid: number; startToken: string }
  | { kind: "unverified"; path: string; pid: number; startToken: string | null };

/**
 * Classify a pid file.
 *
 * "stale" — the recorded process is gone, or its pid is alive with a different
 * start token from the same source (`processIsGone`). "running" — the pid is
 * alive and its current start token equals the recorded one. "unverified" —
 * the pid is not proven gone and its identity is not confirmed; a caller must
 * not signal it. A pid outside 1..2147483647 is "invalid", never
 * "unverified".
 */
export function readPidFile(
  path: string,
  resolveToken: (pid: number) => string | null = processStartToken,
): PidFileState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    // No evidence the process is gone: keep the file and refuse to signal.
    return { kind: "unreadable", path };
  }
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
