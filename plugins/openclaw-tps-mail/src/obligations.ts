/**
 * obligations.ts — the durable reply-OBLIGATION store for the tps-mail plugin
 * (slice S2 of cli#392's follow-up).
 *
 * INVARIANT (I1): a success ack requires a committed final-reply receipt for
 * THIS inbound; yield is pending; failure is durably named with an explicit
 * disposition; exactly one obligation-discharging post per inbound (an agent's
 * own explicit mails may coincide — they never discharge).
 *
 * One JSON record per inbound lives under the agent's maildir at
 * `<mailDir>/<agent>/.obligations/<inboundId>.json`. The record is the durable
 * truth behind the ack: the ack transition is keyed on a RECEIPT found by
 * scanning the reply's destination for a file whose `X-TPS-Obligation` header
 * equals this obligation's id — never on the fact that a dispatch settled.
 *
 * This module is deliberately pure of the plugin's runtime plumbing: it reads
 * and writes records and scans directories. The timer/arming and the dispatch
 * wiring live in index.ts.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

export type ObligationState = "pending" | "yielded" | "posted" | "acked" | "failed";

export const TERMINAL_STATES: ReadonlySet<ObligationState> = new Set(["acked", "failed"]);

export interface ObligationRecord {
  obligationId: string;
  /** The mail file id this obligation is keyed on (the plugin's MessageSid). */
  inboundId: string;
  inboundTimestamp: string;
  /** The VERIFIED sender — the value promote() overwrote/wrote. */
  from: string;
  /** The agent that owes the reply. */
  to: string;
  accountId: string;
  state: ObligationState;
  /** ISO deadline armed at the yield transition; null while pending. */
  deadlineAt: string | null;
  attempts: number;
  /** Named failure reason when state === "failed". */
  failure?: string;
}

export interface ObligationLog {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export function obligationsDir(mailDir: string, agent: string): string {
  return resolve(mailDir, agent, ".obligations");
}

export function obligationPath(mailDir: string, agent: string, inboundId: string): string {
  return resolve(obligationsDir(mailDir, agent), `${inboundId}.json`);
}

export function readObligation(mailDir: string, agent: string, inboundId: string): ObligationRecord | null {
  const p = obligationPath(mailDir, agent, inboundId);
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ObligationRecord;
  } catch {
    return null;
  }
}

export function listObligations(mailDir: string, agent: string): ObligationRecord[] {
  const dir = obligationsDir(mailDir, agent);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ObligationRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    try {
      out.push(JSON.parse(readFileSync(resolve(dir, name), "utf-8")) as ObligationRecord);
    } catch {
      // A torn record is not readable truth; skip it rather than crash recovery.
    }
  }
  return out;
}

/** Atomic write: stage to a dot temp in the same dir, then rename into place. */
export function writeObligation(mailDir: string, agent: string, record: ObligationRecord): void {
  const dir = obligationsDir(mailDir, agent);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${record.inboundId}.json`);
  const tmp = resolve(dir, `.${record.inboundId}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8");
  renameSync(tmp, target);
}

/**
 * Create the obligation for an inbound. KEYED ON inboundId: a second create for
 * the same inbound is a NO-OP (logged) and returns the existing record — a
 * replayed inbound must never open a second obligation.
 */
export function createObligation(
  mailDir: string,
  agent: string,
  make: () => ObligationRecord,
  log?: ObligationLog,
): { created: boolean; record: ObligationRecord } {
  const draft = make();
  const existing = readObligation(mailDir, agent, draft.inboundId);
  if (existing) {
    log?.info?.(
      `tps-mail: obligation for inbound ${draft.inboundId} already exists (${existing.obligationId}); not creating a second`,
    );
    return { created: false, record: existing };
  }
  writeObligation(mailDir, agent, draft);
  return { created: true, record: draft };
}

/**
 * One-way transition. A late event after a TERMINAL state (acked/failed) is a
 * NO-OP, logged — never a state resurrection. Transitions do not enforce a
 * strict order among non-terminal states (pending → posted → acked is the happy
 * path; pending → yielded → failed is the yield path), but terminal is final.
 */
export function transitionObligation(
  mailDir: string,
  agent: string,
  inboundId: string,
  next: ObligationState,
  patch: Partial<ObligationRecord> = {},
  log?: ObligationLog,
): ObligationRecord | null {
  const current = readObligation(mailDir, agent, inboundId);
  if (!current) return null;
  if (TERMINAL_STATES.has(current.state)) {
    log?.info?.(
      `tps-mail: obligation ${current.obligationId} is ${current.state}; ignoring late transition to ${next}`,
    );
    return current;
  }
  const updated: ObligationRecord = { ...current, ...patch, state: next };
  writeObligation(mailDir, agent, updated);
  return updated;
}

// ── receipt scan ─────────────────────────────────────────────────────────────

export type ReceiptScan =
  | { status: "found"; path: string }
  | { status: "malformed"; path: string }
  | { status: "absent" };

/** The `from` of a signed envelope body, or null when it does not parse. */
export function envelopeFrom(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.from === "string" ? parsed.from : null;
  } catch {
    return null;
  }
}

/**
 * THE RECEIPT IS THE POSTED FILE. Scan the reply's destination directories for
 * a record that carries ALL of:
 *   (a) `headers["X-TPS-Obligation"] === obligationId` — the marker this inbound
 *       minted;
 *   (b) `accountId === accountId` — the SAME account that owns the obligation;
 *   (c) `record.from === agent` — the recipient agent wrote it; and
 *   (d) `envelopeFrom(record.body) === agent` — the wrapped signed envelope's
 *       `from` also names that agent (so a re-wrapped body cannot attribute the
 *       reply to someone else).
 *
 * WHAT THIS IS NOT: the receipt is NOT signature-verified here, and this scan
 * does not claim it is. Checking the envelope's signature would not close the
 * gap on its own, for two reasons:
 *   1. the `X-TPS-Obligation` marker rides on the mail RECORD's headers, OUTSIDE
 *      the signed envelope (index.ts sets it when it writes the reply; the
 *      envelope is signed over `body` alone) — so verifying the envelope would
 *      authenticate the TEXT but would not bind the receipt to THIS inbound;
 *   2. where agents share one OS user, another agent can read BOTH the
 *      obligation record and the signing keys, so no in-band check separates
 *      them — only an OS-level boundary does (tracked separately). The
 *      obligation id is not a secret in that model: a same-user reader simply
 *      reads it, so "unguessable" is not the defence.
 * So the scan pins IDENTITY (which agent, which account) and REACHABILITY (the
 * record's destination); the marker is a routing key, not an authority.
 *
 * A `.malformed-*` quarantine (drainOutbox's quarantine for an unparseable
 * record) is FAILED, never posted — its marker cannot be read, so a malformed
 * file in the receipt dirs is reported as `malformed` only when no valid receipt
 * was found.
 */
export function scanForReceipt(
  dirs: string[],
  obligationId: string,
  agent: string,
  accountId: string,
): ReceiptScan {
  let malformed: string | null = null;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".malformed-")) {
        malformed = malformed ?? resolve(dir, name);
        continue;
      }
      if (name.startsWith(".")) continue; // staging temp
      if (!name.endsWith(".json")) continue;
      const path = resolve(dir, name);
      let record: any;
      try {
        record = JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        continue; // unparseable but not quarantined yet; not a receipt
      }
      if (record?.headers?.["X-TPS-Obligation"] !== obligationId) continue;
      if (record?.accountId !== accountId) continue;
      if (record?.from !== agent) continue;
      if (envelopeFrom(record?.body ?? "") !== agent) continue;
      return { status: "found", path };
    }
  }
  if (malformed) return { status: "malformed", path: malformed };
  return { status: "absent" };
}

/**
 * The newest session-transcript mtime under `~/.openclaw/agents/<agent>/sessions`
 * — named in the yield failure so the sender can hand-recover a composed DONE.
 * Best-effort: null when the tree is absent or unreadable.
 */
export function newestSessionTranscript(home: string, agent: string): { path: string; mtime: string } | null {
  const root = resolve(home, ".openclaw", "agents", agent, "sessions");
  let newest: { path: string; mtimeMs: number } | null = null;
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
      } else if (e.isFile()) {
        try {
          const m = statSync(p).mtimeMs;
          if (!newest || m > newest.mtimeMs) newest = { path: p, mtimeMs: m };
        } catch {
          // skip
        }
      }
    }
  };
  walk(root, 0);
  if (!newest) return null;
  const found = newest as { path: string; mtimeMs: number };
  return { path: found.path, mtime: new Date(found.mtimeMs).toISOString() };
}
