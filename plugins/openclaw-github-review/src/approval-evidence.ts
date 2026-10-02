/**
 * approval-evidence.ts — the host-side record of a review's build/test run.
 *
 * `APPROVE` requires one, for the same reviewer, session and commit;
 * `REQUEST_CHANGES` and `COMMENT` do not. A record binds the reviewer, the
 * session key, the full commit SHA, the commands of the review build with their
 * exit statuses and a finish time, under a SHA-256 over those fields.
 *
 * It is written HOST-SIDE, by the process that runs the review build, to
 * `approvalEvidenceFile` (see the plugin README). Nothing inside the sandbox
 * can write or read-modify that file: the sandbox mounts only the review
 * worktree and has no host filesystem access. `github_review` re-computes the
 * digest, so a record edited after it was written no longer matches.
 */

import { createHash } from "node:crypto";
import { readJsonStore, writeJsonStore } from "./durable-file.js";
import { withStoreLock } from "./store-lock.js";
import type { RefusalReason } from "./types.js";

export const APPROVAL_EVIDENCE_VERSION = 1;

/** One command of the review build and the exit status it returned. */
export interface ApprovalCommand {
  command: string;
  exitCode: number;
}

/** A complete record: the fields the digest covers, plus the digest. */
export interface ApprovalEvidenceRecord {
  version: number;
  reviewer: string;
  sessionKey: string;
  commit: string;
  recordedAt: string;
  commands: ApprovalCommand[];
  digest: string;
}

export type ApprovalEvidenceFields = Omit<ApprovalEvidenceRecord, "digest">;

/** The binding `github_review` requires the record to carry. */
export interface ApprovalEvidenceBinding {
  reviewer: string;
  sessionKey: string;
  commit: string;
}

/** The exact bytes the digest covers: the bound fields, in a fixed order. */
export function approvalEvidenceBytes(fields: ApprovalEvidenceFields): string {
  return JSON.stringify({
    version: fields.version,
    reviewer: fields.reviewer,
    sessionKey: fields.sessionKey,
    commit: fields.commit,
    recordedAt: fields.recordedAt,
    commands: Array.isArray(fields.commands) ? fields.commands.map((c) => ({ command: c.command, exitCode: c.exitCode })) : fields.commands,
  });
}

export function approvalEvidenceDigest(fields: ApprovalEvidenceFields): string {
  return createHash("sha256").update(approvalEvidenceBytes(fields), "utf8").digest("hex");
}

/** Build a record from the host's fields, computing its digest. */
export function buildApprovalEvidence(input: {
  reviewer: string;
  sessionKey: string;
  commit: string;
  recordedAt: string;
  commands: ApprovalCommand[];
}): ApprovalEvidenceRecord {
  const fields: ApprovalEvidenceFields = { version: APPROVAL_EVIDENCE_VERSION, ...input };
  return { ...fields, digest: approvalEvidenceDigest(fields) };
}

/** Structural check for a stored entry. It is deliberately loose about the
 *  command list: a record the digest will reject must still LOAD, so the
 *  handler can report it as invalid rather than as an unreadable store. */
function isRecord(v: unknown): v is ApprovalEvidenceRecord {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  return (
    o !== null &&
    o.version === APPROVAL_EVIDENCE_VERSION &&
    typeof o.reviewer === "string" &&
    typeof o.sessionKey === "string" &&
    typeof o.commit === "string" &&
    typeof o.recordedAt === "string" &&
    Array.isArray(o.commands) &&
    typeof o.digest === "string"
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
    const matches = approvals.filter(
      (a) => a.reviewer === binding.reviewer && a.sessionKey === binding.sessionKey && a.commit === binding.commit,
    );
    if (matches.length === 1) return { status: "found", record: matches[0]! };
    if (matches.length > 1) return { status: "ambiguous" };
    // The store holds evidence, but none that matches the binding: hand back one
    // so the caller reports WHY it does not match, rather than as "missing".
    if (approvals.length > 0) return { status: "mismatch", record: approvals[0]! };
    return { status: "missing" };
  }
}

/** HOST: record one build's evidence. Upserts by reviewer/session/commit,
 *  durably, under the store lock; throws when it cannot write. */
export function writeApprovalEvidence(file: string, record: ApprovalEvidenceRecord): void {
  withStoreLock(file, "approval-evidence write", () => {
    const kept = readApprovalEvidence(file).filter(
      (a) => !(a.reviewer === record.reviewer && a.sessionKey === record.sessionKey && a.commit === record.commit),
    );
    kept.push(record);
    writeJsonStore(file, { approvals: kept });
  });
}

export type ApprovalEvidenceVerdict =
  | { ok: true; digest: string }
  | { ok: false; reason: RefusalReason; state: string; remedy: string };

const RERECORD = "record the review build's evidence for this commit on the host, then approve again";

/** Check one record against the binding. In order: the record is intact (its
 *  digest matches), it lists at least one command and every command has an exit
 *  status, no command failed, and it is for this reviewer, session and commit. */
export function validateApprovalEvidence(record: ApprovalEvidenceRecord, binding: ApprovalEvidenceBinding): ApprovalEvidenceVerdict {
  if (!isRecord(record)) {
    return { ok: false, reason: "approval_evidence_invalid", state: "the approval-evidence record is not well-formed", remedy: RERECORD };
  }
  const { digest, ...fields } = record;
  let expected: string;
  try {
    expected = approvalEvidenceDigest(fields);
  } catch {
    return { ok: false, reason: "approval_evidence_invalid", state: "the approval-evidence record cannot be read", remedy: RERECORD };
  }
  if (digest.length !== 64 || digest !== expected) {
    return {
      ok: false,
      reason: "approval_evidence_invalid",
      state: "the approval-evidence record's digest does not match its contents (it was edited after it was written)",
      remedy: RERECORD,
    };
  }
  if (record.commands.length === 0) {
    return { ok: false, reason: "approval_evidence_incomplete", state: "the approval-evidence record lists no command", remedy: RERECORD };
  }
  for (const c of record.commands) {
    if (typeof c?.command !== "string" || c.command === "" || !Number.isInteger(c.exitCode)) {
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
      remedy: "a passing build/test run of this commit is required before an APPROVE",
    };
  }
  if (record.reviewer !== binding.reviewer || record.sessionKey !== binding.sessionKey || record.commit !== binding.commit) {
    return {
      ok: false,
      reason: "approval_evidence_mismatch",
      state: "the approval-evidence record is not for this reviewer, session and commit",
      remedy: "approve the commit this session was dispatched to review, with evidence recorded for it",
    };
  }
  return { ok: true, digest: record.digest };
}
