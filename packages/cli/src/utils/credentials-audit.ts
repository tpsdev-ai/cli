/**
 * credentials-audit.ts — Cred Substrate S2: Audit Log
 * (ops-8xad)
 *
 * Append-only JSONL audit log for every credential CLI operation.
 *
 * File: ~/.tps/credentials/audit.log
 * Mode: 0600
 * Format: one JSON object per line (JSONL)
 *
 * Schema (each line):
 * {
 *   "ts": "2026-05-20T20:00:00.000Z",
 *   "op": "adopt|verify|emit|rotate|list|show|scan|adopt-single|<future>",
 *   "name": "<entry-name-or-null-for-list/scan>",
 *   "result": "ok|fail|verify_failed",
 *   "reason": "<string-on-fail-only>",
 *   "caller_pid": 12345,
 *   "caller_argv0": "tps"
 * }
 *
 * Invariants:
 * - Append-only (writeFileSync with flag 'a')
 * - Mode 0600 on file
 * - NEVER log secret values
 * - Atomic per-line write (single writeFileSync, no partial lines)
 * - Audit commands that read the log do NOT write to the log
 */

import { writeFileSync, mkdirSync, chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditOp =
  | "adopt"
  | "verify"
  | "emit"
  | "rotate"
  | "register"
  | "unregister"
  | "list"
  | "show"
  | "scan"
  | "adopt-single";

export type AuditResult = "ok" | "fail" | "verify_failed";

export interface AuditLine {
  ts: string;
  op: AuditOp | string;
  name: string | null;
  result: AuditResult;
  reason?: string;
  caller_pid: number;
  caller_argv0: string;
}

export interface AuditStats {
  window: string;
  total: number;
  by_op: Record<string, number>;
  by_result: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

/** Absolute path to the audit log: ~/.tps/credentials/audit.log */
export function auditLogPath(): string {
  return join(homedir(), ".tps", "credentials", "audit.log");
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Append a single JSONL line to the audit log.
 *
 * - Creates parent dir ~/.tps/credentials/ (mode 0700) if needed
 * - Creates audit.log (mode 0600) on first write
 * - chmod 0600 on every write (defense in depth)
 * - Errors on write are caught and logged to stderr; never thrown
 */
export function appendAuditLine(opts: {
  op: AuditOp | string;
  name?: string | null;
  result: AuditResult;
  reason?: string;
}): void {
  try {
    const p = auditLogPath();

    // Ensure parent dir exists with mode 0700
    const parent = dirname(p);
    mkdirSync(parent, { recursive: true, mode: 0o700 });

    const line: AuditLine = {
      ts: new Date().toISOString(),
      op: opts.op,
      name: opts.name ?? null,
      result: opts.result,
      caller_pid: process.pid,
      caller_argv0: process.argv0 || "tps",
    };

    // reason only on failure
    if (opts.result !== "ok" && opts.reason) {
      line.reason = opts.reason;
    }

    // Append as single line
    writeFileSync(p, JSON.stringify(line) + "\n", { flag: "a", mode: 0o600 });
  } catch (err) {
    // Audit write must never block command output
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[audit] warn: failed to write audit log: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Read the full audit log (lines parseable) into an array. Returns empty on missing/invalid. */
export function readAuditLog(): AuditLine[] {
  const p = auditLogPath();
  if (!existsSync(p)) return [];

  const raw = readFileSync(p, "utf-8");
  const lines: AuditLine[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AuditLine;
      if (parsed.ts && parsed.op && parsed.result) {
        lines.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return lines;
}

/** Read the last N lines of the audit log. */
export function tailAuditLog(n = 50): AuditLine[] {
  const lines = readAuditLog();
  return lines.slice(-n);
}

/** Filter audit lines by substring match on op or name field (case-insensitive). */
export function grepAuditLog(
  pattern: string,
  lines?: AuditLine[]
): AuditLine[] {
  const haystack = lines ?? readAuditLog();
  const lower = pattern.toLowerCase();
  return haystack.filter(line => {
    return (
      line.op.toLowerCase().includes(lower) ||
      (line.name && line.name.toLowerCase().includes(lower))
    );
  });
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/**
 * Compute audit stats over a time window.
 *
 * @param window Duration string e.g. "7d", "24h", "1w"
 * @param now Reference time (default: now)
 * @returns AuditStats with counts by op and by result
 */
export function auditStats(window: string, now: Date = new Date()): AuditStats {
  const lines = readAuditLog();
  const ms = parseWindowMs(window);
  const since = ms > 0 ? now.getTime() - ms : 0;

  const by_op: Record<string, number> = {};
  const by_result: Record<string, number> = {};
  let total = 0;

  for (const line of lines) {
    const ts = new Date(line.ts).getTime();
    if (ms > 0 && ts < since) continue;

    total++;
    by_op[line.op] = (by_op[line.op] || 0) + 1;
    by_result[line.result] = (by_result[line.result] || 0) + 1;
  }

  return { window, total, by_op, by_result };
}

/** Parse a time-window string into milliseconds. */
function parseWindowMs(dur: string): number {
  const match = dur.trim().match(/^(\d+)([dhmw])$/i);
  if (!match) return 0;
  const val = parseInt(match[1], 10);
  switch (match[2].toLowerCase()) {
    case "d": return val * 24 * 60 * 60 * 1000;
    case "h": return val * 60 * 60 * 1000;
    case "m": return val * 60 * 1000;
    case "w": return val * 7 * 24 * 60 * 60 * 1000;
    default: return 0;
  }
}

// ---------------------------------------------------------------------------
// Convenience — log helpers for each command surface
// ---------------------------------------------------------------------------

export function logAdopted(name: string, ok: boolean, reason?: string): void {
  appendAuditLine({ op: "adopt", name, result: ok ? "ok" : "fail", reason });
}

export function logAdoptedSingle(name: string, ok: boolean, reason?: string): void {
  appendAuditLine({ op: "adopt-single", name, result: ok ? "ok" : "fail", reason });
}

export function logVerify(name: string | null, ok: boolean, reason?: string): void {
  appendAuditLine({ op: "verify", name, result: ok ? "ok" : "verify_failed", reason });
}

export function logList(): void {
  appendAuditLine({ op: "list", name: null, result: "ok" });
}

export function logShow(name: string): void {
  appendAuditLine({ op: "show", name, result: "ok" });
}

export function logEmit(name: string, ok: boolean, reason?: string): void {
  appendAuditLine({ op: "emit", name, result: ok ? "ok" : "fail", reason });
}

export function logRegister(name: string, ok: boolean, reason?: string): void {
  appendAuditLine({ op: "register", name, result: ok ? "ok" : "fail", reason });
}

export function logUnregister(name: string): void {
  appendAuditLine({ op: "unregister", name, result: "ok" });
}

export function logScan(): void {
  appendAuditLine({ op: "scan", name: null, result: "ok" });
}
