/**
 * secrets-guard.ts — Cred Substrate S5: Leak-Shape Pre-Flight Guard
 * (ops-568p child)
 *
 * Pure module for building fingerprint sets from a credentials manifest and
 * redacting buffer content that matches registered secrets or known type-shapes.
 *
 * No global state. Same purity contract as credentials-manifest.ts.
 */

import {
  readManifest,
  expandPath,
  CredentialEntry,
  CredentialType,
  CredentialsManifest,
} from "./credentials-manifest.js";
import { existsSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FingerprintSet {
  /** Map of literal content → entry name (for audit logging) */
  literalToEntry: Map<string, { name: string; type: CredentialType }>;
  /** Set of first-12-char fragments from each literal */
  fragments: Map<string, { name: string; type: CredentialType }>;
  /** Ordered shape patterns */
  shapes: Array<{ type: CredentialType | "shape"; regex: RegExp }>;
}

export interface RedactResult {
  redacted: string;
  matches: Record<string, number>;
  events: Array<{ type: string; name: string | null; stream: "stdout" | "stderr" }>;
}

export interface LogEvent {
  ts: string;
  cmd: string;
  type: string;
  name: string | null;
  stream: "stdout" | "stderr";
}

// ---------------------------------------------------------------------------
// Type-shape patterns (hardcoded per CredentialType)
// ---------------------------------------------------------------------------

/**
 * Type-shape patterns that trigger auto-redaction.
 * Anchored loosely so they match anywhere in output.
 * Ordered by specificity — longer/more-specific patterns first.
 */
function buildShapePatterns(): Array<{ type: CredentialType | "shape"; regex: RegExp; autoRedact: boolean }> {
  return [
    {
      type: "github-pat-fine-grained",
      regex: /github_pat_[A-Za-z0-9_]{22,}_[A-Za-z0-9_]{22,}/g,
      autoRedact: true,
    },
    {
      type: "github-pat-classic",
      regex: /ghp_[A-Za-z0-9_]{36,}/g,
      autoRedact: true,
    },
    {
      type: "discord-bot-token",
      regex: /[A-Za-z0-9._-]{50,200}\.[A-Za-z0-9._-]{50,200}/g,
      autoRedact: true,
    },
    {
      type: "shape",
      regex: /[A-Za-z0-9+/=]{40,}/g,
      autoRedact: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// buildFingerprintSet
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 64 * 1024; // 64KB

/**
 * Build a fingerprint set from the credentials manifest.
 * Called on every guard invocation — no caching.
 */
export function buildFingerprintSet(
  manifest: CredentialsManifest
): FingerprintSet {
  const literalToEntry = new Map<string, { name: string; type: CredentialType }>();
  const fragments = new Map<string, { name: string; type: CredentialType }>();

  for (const [name, entry] of Object.entries(manifest.credentials)) {
    const resolvedPath = expandPath(entry.path);

    // Skip files that don't exist or are unreadable
    if (!existsSync(resolvedPath)) continue;

    // Skip files that are too large
    let content: string;
    try {
      const stat = readFileSync(resolvedPath, { encoding: "utf-8" });
      // Check size before reading content (stat check is cheap)
      const size = Buffer.byteLength(stat, "utf-8");
      if (size > MAX_FILE_SIZE) continue;
      content = stat;
    } catch {
      continue;
    }

    // Strip trailing whitespace
    const trimmed = content.replace(/\s+$/, "");

    // Skip empty content
    if (trimmed.length === 0) continue;

    // Add exact-match literal
    literalToEntry.set(trimmed, { name, type: entry.type });

    // Add fragment fingerprint (first 12 chars)
    const fragment = trimmed.slice(0, 12);
    fragments.set(fragment, { name, type: entry.type });
  }

  const shapes = buildShapePatterns().map(({ type, regex }) => ({
    type,
    regex,
  }));

  return { literalToEntry, fragments, shapes };
}

// ---------------------------------------------------------------------------
// redactBuffer — pure redaction function
// ---------------------------------------------------------------------------

/**
 * Redact a buffer of text using the given fingerprint set.
 * Returns the redacted text, a count of matches per type, and log events.
 */
export function redactBuffer(
  input: string,
  set: FingerprintSet,
  stream: "stdout" | "stderr"
): RedactResult {
  let redacted = input;
  const matches: Record<string, number> = {};
  const events: Array<{ type: string; name: string | null; stream: "stdout" | "stderr" }> = [];

  // Sort literals by length descending so longer matches take priority
  const sortedLiterals = [...set.literalToEntry.entries()].sort(
    ([a], [b]) => b.length - a.length
  );

  // Pass 1: exact-match literal replacement
  for (const [literal, { name, type }] of sortedLiterals) {
    if (!redacted.includes(literal)) continue;
    const replacement = `[REDACTED-${type}]`;
    // Count occurrences before replacing
    const count = countOccurrences(redacted, literal);
    if (count > 0 && !redacted.includes(replacement)) {
      // safe to replace
    }
    // Use split+join for reliable replacement (skip if literal contains regex chars risk)
    // Actually, use replaceAll with string arg
    let matchesFound = 0;
    let idx = 0;
    while ((idx = redacted.indexOf(literal, idx)) !== -1) {
      // Verify it's not already inside a [REDACTED-...] tag
      if (!isInsideRedactedTag(redacted, idx)) {
        matchesFound++;
      }
      idx += literal.length;
    }

    if (matchesFound > 0) {
      redacted = redacted.split(literal).join(replacement);
      matches[type] = (matches[type] ?? 0) + matchesFound;
      for (let i = 0; i < matchesFound; i++) {
        events.push({ type, name, stream });
      }
    }
  }

  // Pass 2: fragment fingerprint replacement (only where literal didn't already match)
  const sortedFragments = [...set.fragments.entries()].sort(
    ([a], [b]) => b.length - a.length
  );

  for (const [fragment, { name, type }] of sortedFragments) {
    if (!redacted.includes(fragment)) continue;

    // Build regex that matches the fragment NOT inside [REDACTED-...]
    // Use a negative lookbehind to avoid matching inside redacted tags
    const fragmentRegex = new RegExp(
      escapeRegex(fragment),
      "g"
    );

    let matchCount = 0;
    let m: RegExpExecArray | null;
    // Reset lastIndex
    fragmentRegex.lastIndex = 0;
    while ((m = fragmentRegex.exec(redacted)) !== null) {
      if (!isInsideRedactedTag(redacted, m.index)) {
        matchCount++;
      }
    }

    if (matchCount > 0) {
      // Replace each instance that's not inside a redacted tag
      const fragmentLen = fragment.length;
      const result: string[] = [];
      let pos = 0;
      const searchRegex = new RegExp(escapeRegex(fragment), "g");
      searchRegex.lastIndex = 0;
      while ((m = searchRegex.exec(redacted)) !== null) {
        if (!isInsideRedactedTag(redacted, m.index)) {
          result.push(redacted.slice(pos, m.index));
          result.push(`[REDACTED-${type}]`);
          pos = m.index + fragmentLen;
        }
      }
      if (pos > 0) {
        result.push(redacted.slice(pos));
        redacted = result.join("");
        matches[type] = (matches[type] ?? 0) + matchCount;
        for (let i = 0; i < matchCount; i++) {
          events.push({ type, name, stream });
        }
      }
    }
  }

  // Pass 3: type-shape regex replacement (only shapes that auto-redact)
  const shapeDefs = buildShapePatterns();
  for (const { type, regex, autoRedact } of shapeDefs) {
    if (!autoRedact) continue; // skip base64 shapes — flag only

    const re = new RegExp(regex.source, regex.flags);
    let matchCount = 0;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    const matchedRanges: Array<{ start: number; end: number }> = [];

    while ((m = re.exec(redacted)) !== null) {
      if (!isInsideRedactedTag(redacted, m.index)) {
        matchedRanges.push({ start: m.index, end: m.index + m[0].length });
        matchCount++;
      }
    }

    if (matchCount > 0) {
      // Replace from end to start to preserve indices
      const parts: string[] = [];
      let pos = 0;
      for (const range of matchedRanges) {
        parts.push(redacted.slice(pos, range.start));
        parts.push(`[REDACTED-shape]`);
        pos = range.end;
      }
      parts.push(redacted.slice(pos));
      redacted = parts.join("");

      // Merge shape matches under a single key or use the type
      const matchKey = "shape";
      matches[matchKey] = (matches[matchKey] ?? 0) + matchCount;
      for (let i = 0; i < matchCount; i++) {
        events.push({ type: type as string, name: null, stream });
      }
    }
  }

  // Pass 4: base64 shape counting (flag only, no redaction)
  const base64Pattern = /[A-Za-z0-9+/=]{40,}/g;
  let b64Count = 0;
  let bm: RegExpExecArray | null;
  while ((bm = base64Pattern.exec(redacted)) !== null) {
    if (!isInsideRedactedTag(redacted, bm.index)) {
      b64Count++;
    }
  }
  if (b64Count > 0) {
    matches["shape-base64"] = b64Count;
  }

  return { redacted, matches, events };
}

// ---------------------------------------------------------------------------
// countMatches — check mode (don't redact, just count)
// ---------------------------------------------------------------------------

/**
 * Count matches in text without redacting.
 * Returns the total number of matches across all layers.
 */
export function countMatches(input: string, set: FingerprintSet): number {
  const result = redactBuffer(input, set, "stdout");
  // The matches may include the same text matched by both literal and shape.
  // For check mode, count unique matched positions.
  // Simplified: sum all match counts.
  return Object.values(result.matches).reduce((sum, n) => sum + n, 0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count non-overlapping occurrences of substr in str. */
function countOccurrences(str: string, substr: string): number {
  if (substr.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = str.indexOf(substr, idx)) !== -1) {
    if (!isInsideRedactedTag(str, idx)) {
      count++;
    }
    idx += substr.length;
  }
  return count;
}

/** Check if a position in the string is inside a [REDACTED-...] tag. */
function isInsideRedactedTag(str: string, pos: number): boolean {
  // Search backwards from pos for the nearest '[REDACTED-' opening
  const tagStart = str.lastIndexOf("[REDACTED-", pos);
  if (tagStart === -1) return false;

  // Find the closing ']' after tagStart
  const tagEnd = str.indexOf("]", tagStart);
  if (tagEnd === -1) return false;

  return pos >= tagStart && pos <= tagEnd;
}

/** Escape special regex characters in a string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Spawn & stream — wraps a command through the redactor
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const OVERLAP_BYTES = 128;

/**
 * Get the guard log path (creates parent dir if needed).
 */
export function getGuardLogPath(): string {
  const p = join(homedir(), ".tps", "credentials", "guard.log");
  mkdirSync(dirname(p), { recursive: true, mode: 0o755 });
  return p;
}

/** Append a log event line to the guard log (JSONL, mode 0644). */
export function appendGuardLog(
  events: LogEvent[],
  logPath?: string
): void {
  if (events.length === 0) return;
  const p = logPath ?? getGuardLogPath();
  const lines = events.map(e => JSON.stringify(e) + "\n").join("");
  appendFileSync(p, lines, { mode: 0o644 });
}

/**
 * Spawn a command, stream stdout/stderr through the redactor, and forward
 * the exit code. Returns the exit code so the caller can process.exit(code).
 */
export function spawnGuarded(
  cmd: string,
  args: string[],
  set: FingerprintSet,
  guardLogPath?: string
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["inherit", "pipe", "pipe"],
    });

    const allEvents: LogEvent[] = [];
    let stdoutDone = false;
    let stderrDone = false;

    function maybeDone(exitCode: number | null) {
      if (!stdoutDone || !stderrDone) return;
      // Write audit log
      appendGuardLog(allEvents, guardLogPath);
      resolve(exitCode ?? 0);
    }

    // --- stdout ---
    let stdoutPending = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stdoutPending += text;

      if (stdoutPending.length > OVERLAP_BYTES) {
        const flush = stdoutPending.slice(0, -OVERLAP_BYTES);
        stdoutPending = stdoutPending.slice(-OVERLAP_BYTES);
        const result = redactBuffer(flush, set, "stdout");
        process.stdout.write(result.redacted);
        for (const ev of result.events) {
          allEvents.push({
            ts: new Date().toISOString(),
            cmd: cmd,
            type: ev.type,
            name: ev.name,
            stream: ev.stream,
          });
        }
      }
    });

    child.stdout!.on("end", () => {
      if (stdoutPending.length > 0) {
        const result = redactBuffer(stdoutPending, set, "stdout");
        process.stdout.write(result.redacted);
        for (const ev of result.events) {
          allEvents.push({
            ts: new Date().toISOString(),
            cmd: cmd,
            type: ev.type,
            name: ev.name,
            stream: ev.stream,
          });
        }
      }
      stdoutDone = true;
    });

    // --- stderr ---
    let stderrPending = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stderrPending += text;

      if (stderrPending.length > OVERLAP_BYTES) {
        const flush = stderrPending.slice(0, -OVERLAP_BYTES);
        stderrPending = stderrPending.slice(-OVERLAP_BYTES);
        const result = redactBuffer(flush, set, "stderr");
        process.stderr.write(result.redacted);
        for (const ev of result.events) {
          allEvents.push({
            ts: new Date().toISOString(),
            cmd: cmd,
            type: ev.type,
            name: ev.name,
            stream: ev.stream,
          });
        }
      }
    });

    child.stderr!.on("end", () => {
      if (stderrPending.length > 0) {
        const result = redactBuffer(stderrPending, set, "stderr");
        process.stderr.write(result.redacted);
        for (const ev of result.events) {
          allEvents.push({
            ts: new Date().toISOString(),
            cmd: cmd,
            type: ev.type,
            name: ev.name,
            stream: ev.stream,
          });
        }
      }
      stderrDone = true;
    });

    child.on("close", (code) => {
      maybeDone(code);
    });

    child.on("error", (err) => {
      process.stderr.write(`tps secrets-guard: failed to spawn ${cmd}: ${err.message}\n`);
      stdoutDone = true;
      stderrDone = true;
      maybeDone(1);
    });
  });
}
