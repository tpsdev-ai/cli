/**
 * approval-evidence.ts — the host-side record of a review's build/test run.
 *
 * `APPROVE` requires one, for the same repository, pull request, dispatch,
 * reviewer, session and full commit; `REQUEST_CHANGES` and `COMMENT` do not.
 * A record binds those fields, the commands of the review build with their exit
 * statuses and their roles, and the run's start and finish times, under a
 * SHA-256 over those fields AND an HMAC-SHA256 over the same bytes with a
 * HOST-HELD key the sandbox cannot read (see the plugin README for the key's
 * path and why it is unreachable from the sandbox).
 *
 * It is written HOST-SIDE, by the process that runs the review build (see
 * approval-driver.ts). `github_review` re-computes the digest and re-computes
 * the HMAC, so a record edited after it was written fails the digest, and one
 * rewritten with a matching digest still fails the HMAC unless the editor holds
 * the host key.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { readJsonStore, writeJsonStore } from "./durable-file.js";
import { withStoreLock } from "./store-lock.js";
import type { RefusalReason } from "./types.js";

export const APPROVAL_EVIDENCE_VERSION = 1;

/** What a command contributed to the run. `build` and `test` are the stages
 *  `github_review` requires; every other planned step is `other`. */
export type ApprovalCommandRole = "build" | "test" | "other";

/** One executed command of the review build, its stage and its exit status. */
export interface ApprovalCommand {
  command: string;
  role: ApprovalCommandRole;
  exitCode: number;
}

/** A complete record: the fields the digest and the HMAC cover, plus both. */
export interface ApprovalEvidenceRecord {
  version: number;
  repo: string;
  pr: number;
  dispatchId: string;
  reviewer: string;
  sessionKey: string;
  commit: string;
  startedAt: string;
  finishedAt: string;
  commands: ApprovalCommand[];
  digest: string;
  mac: string;
}

export type ApprovalEvidenceFields = Omit<ApprovalEvidenceRecord, "digest" | "mac">;

/** The binding `github_review` requires the record to carry. */
export interface ApprovalEvidenceBinding {
  repo: string;
  pr: number;
  dispatchId: string;
  reviewer: string;
  sessionKey: string;
  commit: string;
}

/** The exact bytes the digest and the HMAC cover: the bound fields, in a fixed
 *  order. */
export function approvalEvidenceBytes(fields: ApprovalEvidenceFields): string {
  const commands = Array.isArray(fields.commands)
    ? fields.commands.map((c) => ({ command: c.command, role: c.role, exitCode: c.exitCode }))
    : fields.commands;
  return JSON.stringify({
    version: fields.version,
    repo: fields.repo,
    pr: fields.pr,
    dispatchId: fields.dispatchId,
    reviewer: fields.reviewer,
    sessionKey: fields.sessionKey,
    commit: fields.commit,
    startedAt: fields.startedAt,
    finishedAt: fields.finishedAt,
    commands,
  });
}

export function approvalEvidenceDigest(fields: ApprovalEvidenceFields): string {
  return createHash("sha256").update(approvalEvidenceBytes(fields), "utf8").digest("hex");
}

export function approvalEvidenceMac(fields: ApprovalEvidenceFields, key: Buffer): string {
  return createHmac("sha256", key).update(approvalEvidenceBytes(fields), "utf8").digest("hex");
}

/** Read the host-held HMAC key. The file holds the key as base64. A missing,
 *  empty or unreadable file THROWS: an unverifiable record is never accepted. */
export function readHostKey(file: string): Buffer {
  const text = readFileSync(file, "utf8").trim();
  if (text === "") throw new Error("the approval-evidence host key file is empty");
  const key = Buffer.from(text, "base64");
  if (key.length === 0) throw new Error("the approval-evidence host key file is not base64");
  return key;
}

/** Build a record from the host's observed fields, computing its digest and
 *  its keyed MAC. */
export function buildApprovalEvidence(
  input: {
    repo: string;
    pr: number;
    dispatchId: string;
    reviewer: string;
    sessionKey: string;
    commit: string;
    startedAt: string;
    finishedAt: string;
    commands: ApprovalCommand[];
  },
  key: Buffer,
): ApprovalEvidenceRecord {
  const fields: ApprovalEvidenceFields = { version: APPROVAL_EVIDENCE_VERSION, ...input };
  return { ...fields, digest: approvalEvidenceDigest(fields), mac: approvalEvidenceMac(fields, key) };
}

/** Structural check for a stored entry. It is deliberately loose about the
 *  command list and the timestamps: a record the digest will reject must still
 *  LOAD, so the handler can report it as invalid rather than as an unreadable
 *  store. */
function isRecord(v: unknown): v is ApprovalEvidenceRecord {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  return (
    o !== null &&
    o.version === APPROVAL_EVIDENCE_VERSION &&
    typeof o.repo === "string" &&
    typeof o.pr === "number" &&
    typeof o.dispatchId === "string" &&
    typeof o.reviewer === "string" &&
    typeof o.sessionKey === "string" &&
    typeof o.commit === "string" &&
    typeof o.startedAt === "string" &&
    typeof o.finishedAt === "string" &&
    Array.isArray(o.commands) &&
    typeof o.digest === "string" &&
    typeof o.mac === "string"
  );
}

/** Every record the store holds. A missing file is empty; anything else it
 *  cannot parse THROWS (never read as empty). */
export function readApprovalEvidence(file: string): ApprovalEvidenceRecord[] {
  const parsed = readJsonStore(file);
  if (parsed === undefined) return [];
  const approvals = typeof parsed === "object" && parsed !== null ? (parsed as { approvals?: unknown }).approvals : undefined;
  if (!Array.isArray(approvals) || !approvals.every(isRecord)) {
    throw new Error("the approval-evidence store has an unrecognised shape");
  }
  return approvals;
}

export type ApprovalEvidenceLookup =
  | { status: "found"; record: ApprovalEvidenceRecord }
  | { status: "missing" }
  | { status: "mismatch"; record: ApprovalEvidenceRecord }
  | { status: "ambiguous" }
  | { status: "unreadable" };

export interface ApprovalEvidenceStore {
  find(binding: ApprovalEvidenceBinding): ApprovalEvidenceLookup;
}

const sameBinding = (a: ApprovalEvidenceRecord, b: ApprovalEvidenceBinding): boolean =>
  a.repo === b.repo &&
  a.pr === b.pr &&
  a.dispatchId === b.dispatchId &&
  a.reviewer === b.reviewer &&
  a.sessionKey === b.sessionKey &&
  a.commit === b.commit;

/** The host-only store the handler reads. A read failure is `unreadable`
 *  (fail closed), never `missing`. More than one matching record is
 *  `ambiguous`: it is not resolved by position. */
export class FileApprovalEvidenceStore implements ApprovalEvidenceStore {
  constructor(private readonly file: string) {}

  find(binding: ApprovalEvidenceBinding): ApprovalEvidenceLookup {
    let approvals: ApprovalEvidenceRecord[];
    try {
      approvals = readApprovalEvidence(this.file);
    } catch {
      return { status: "unreadable" };
    }
    const matches = approvals.filter((a) => sameBinding(a, binding));
    if (matches.length === 1) return { status: "found", record: matches[0]! };
    if (matches.length > 1) return { status: "ambiguous" };
    // The store holds evidence, but none that matches the binding: hand back one
    // so the caller reports WHY it does not match, rather than as "missing".
    if (approvals.length > 0) return { status: "mismatch", record: approvals[0]! };
    return { status: "missing" };
  }
}

/** HOST: record one build's evidence. Upserts by the bound fields, durably,
 *  under the store lock; throws when it cannot write. */
export function writeApprovalEvidence(file: string, record: ApprovalEvidenceRecord): void {
  withStoreLock(file, "approval-evidence write", () => {
    const kept = readApprovalEvidence(file).filter((a) => !sameBinding(a, record));
    kept.push(record);
    writeJsonStore(file, { approvals: kept });
  });
}

export type ApprovalEvidenceVerdict =
  | { ok: true; digest: string }
  | { ok: false; reason: RefusalReason; state: string; remedy: string };

const RERECORD = "run the review build on the host and record its evidence for this dispatch, then approve again";

/** An ISO-8601 instant, or null. */
function isoInstant(value: string): number | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  // Date.parse accepts a date-only string; require a full instant with a time.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? ms : null;
}

/** Check one record against the binding and the host key. In order: the record
 *  is intact (its digest matches), it is authenticated (its HMAC matches),
 *  its timestamps are a valid ordered pair of instants, it lists commands with
 *  exit statuses INCLUDING one build and one test, no command failed, and it is
 *  for this repository, PR, dispatch, reviewer, session and commit. */
export function validateApprovalEvidence(
  record: ApprovalEvidenceRecord,
  binding: ApprovalEvidenceBinding,
  key: Buffer,
): ApprovalEvidenceVerdict {
  if (!isRecord(record)) {
    return { ok: false, reason: "approval_evidence_invalid", state: "the approval-evidence record is not well-formed", remedy: RERECORD };
  }
  const { digest, mac, ...fields } = record;
  let expectedDigest: string;
  let expectedMac: string;
  try {
    expectedDigest = approvalEvidenceDigest(fields);
    expectedMac = approvalEvidenceMac(fields, key);
  } catch {
    return { ok: false, reason: "approval_evidence_invalid", state: "the approval-evidence record cannot be read", remedy: RERECORD };
  }
  if (digest.length !== 64 || digest !== expectedDigest) {
    return {
      ok: false,
      reason: "approval_evidence_invalid",
      state: "the approval-evidence record's digest does not match its contents (it was edited after it was written)",
      remedy: RERECORD,
    };
  }
  const macBuf = Buffer.from(mac, "hex");
  const expectedBuf = Buffer.from(expectedMac, "hex");
  if (macBuf.length !== expectedBuf.length || !timingSafeEqual(macBuf, expectedBuf)) {
    return {
      ok: false,
      reason: "approval_evidence_unauthenticated",
      state: "the approval-evidence record was not authenticated by the host key",
      remedy: RERECORD,
    };
  }
  const started = isoInstant(record.startedAt);
  if (started === null) {
    return { ok: false, reason: "approval_evidence_incomplete", state: "the approval-evidence record has no valid start time", remedy: RERECORD };
  }
  const finished = isoInstant(record.finishedAt);
  if (finished === null) {
    return { ok: false, reason: "approval_evidence_incomplete", state: "the approval-evidence record has no valid finish time", remedy: RERECORD };
  }
  if (finished < started) {
    return {
      ok: false,
      reason: "approval_evidence_incomplete",
      state: "the approval-evidence record finishes before it starts",
      remedy: RERECORD,
    };
  }
  if (record.commands.length === 0) {
    return { ok: false, reason: "approval_evidence_incomplete", state: "the approval-evidence record lists no command", remedy: RERECORD };
  }
  for (const c of record.commands) {
    if (typeof c?.command !== "string" || c.command === "" || typeof c.role !== "string" || !Number.isInteger(c.exitCode)) {
      return {
        ok: false,
        reason: "approval_evidence_incomplete",
        state: "a command in the approval-evidence record has no exit status",
        remedy: RERECORD,
      };
    }
  }
  const failed = record.commands.find((c) => c.exitCode !== 0);
  if (failed) {
    return {
      ok: false,
      reason: "approval_evidence_failed",
      state: `the review build's command "${failed.command}" exited ${failed.exitCode}`,
      remedy: "a passing build and test run of this commit is required before an APPROVE",
    };
  }
  for (const role of ["build", "test"] as const) {
    if (!record.commands.some((c) => c.role === role)) {
      return {
        ok: false,
        reason: "approval_evidence_incomplete",
        state: `the approval-evidence record lists no ${role} command`,
        remedy: RERECORD,
      };
    }
  }
  if (!sameBinding(record, binding)) {
    return {
      ok: false,
      reason: "approval_evidence_mismatch",
      state: "the approval-evidence record is not for this repository, PR, dispatch, reviewer, session and commit",
      remedy: "approve the commit this session was dispatched to review, with evidence recorded for it",
    };
  }
  return { ok: true, digest: record.digest };
}
