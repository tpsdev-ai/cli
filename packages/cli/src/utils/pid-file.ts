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
 * Readers accept only a trimmed whole positive decimal pid (`^[1-9]\d*$`):
 * an integer prefix, an exponent form, a second line, an empty file and a
 * non-numeric value are all invalid. For JSON records the `pid` value must be
 * a bare decimal literal for the same reason.
 */

import { existsSync, readFileSync } from "node:fs";
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
  // JSON.parse accepts `1e3`, `0x10` and `true`; re-read the pid literal so a
  // value that is not a bare decimal integer is refused, as in a text file.
  const match = /"pid"\s*:\s*([^,}\s]+)/.exec(text);
  if (!match || !WHOLE_PID.test(match[1]!)) {
    return invalid("pid is not a whole positive decimal integer");
  }
  const record = parsed as Record<string, unknown>;
  const token = record.startToken;
  if (token !== undefined && token !== null && typeof token !== "string") {
    return invalid("startToken is not a string");
  }
  if (typeof token === "string" && token.length === 0) {
    return invalid("startToken is empty");
  }
  return { kind: "record", pid: Number(match[1]), startToken: typeof token === "string" ? token : null };
}

/** Parse relay and bridge pid-file content. Nothing else is accepted. */
export function parsePidFile(raw: string): ParsedPidFile {
  const text = raw.trim();
  if (text === "") return invalid("empty");
  if (text.startsWith("{")) return parseJsonRecord(text);
  if (!WHOLE_PID.test(text)) return invalid("pid is not a whole positive decimal integer");
  return { kind: "record", pid: Number(text), startToken: null };
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
 * the pid is live but its identity cannot be checked or does not match a token
 * from another source; a caller must not signal it.
 */
export function readPidFile(
  path: string,
  resolveToken: (pid: number) => string | null = processStartToken,
): PidFileState {
  if (!existsSync(path)) return { kind: "missing" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
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
