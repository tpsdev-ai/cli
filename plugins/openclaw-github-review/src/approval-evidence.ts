/**
 * approval-evidence.ts — the record `APPROVE` requires, for the same
 * repository, pull request, dispatch, reviewer, session and full commit;
 * `REQUEST_CHANGES` and `COMMENT` do not. scripts/reviewer/run-review-jobs.mjs
 * writes it (scripts/reviewer/approval-evidence.mjs) under a SHA-256 and an
 * HMAC-SHA256 over the same bytes with a host-held key.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readJsonStore } from "./durable-file.js";
import type { RefusalReason } from "./types.js";

export const APPROVAL_EVIDENCE_VERSION = 2;

/** One job of the selected CI job's `needs` closure: its planned `run:`
 *  scripts and its launcher's exit status. */
export interface ApprovalJob {
  job: string;
  commands: string[];
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
  /** The selected CI workflow and job. */
  workflow: string;
  job: string;
  startedAt: string;
  finishedAt: string;
  /** The closure, dependencies first; the selected job is last. */
  jobs: ApprovalJob[];
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

/** The CI job `APPROVE` requires the record to be for. */
export interface ApprovalCiJob {
  workflow: string;
  job: string;
}

/** The exact bytes the digest and the HMAC cover: the bound fields, in a fixed
 *  order. */
export function approvalEvidenceBytes(fields: ApprovalEvidenceFields): string {
  const jobs = Array.isArray(fields.jobs)
    ? fields.jobs.map((j) => ({ job: j?.job, commands: j?.commands, exitCode: j?.exitCode }))
    : fields.jobs;
  return JSON.stringify({
    version: fields.version,
    repo: fields.repo,
    pr: fields.pr,
    dispatchId: fields.dispatchId,
    reviewer: fields.reviewer,
    sessionKey: fields.sessionKey,
    commit: fields.commit,
    workflow: fields.workflow,
    job: fields.job,
    startedAt: fields.startedAt,
    finishedAt: fields.finishedAt,
    jobs,
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

/** The path with every symlink in its existing prefix resolved. */
function resolveExisting(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch (err) {
      if ((err as { code?: unknown }).code !== "ENOENT") throw err;
    }
    const parent = dirname(head);
    if (parent === head) return resolve(path);
    tail.push(basename(head));
    head = parent;
  }
}

const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** The first of `paths` that is at or under one of `roots` (each compared as
 *  given and with symlinks resolved), or that has a second hard link; null
 *  when none is. Tolerates missing paths (ENOENT); other filesystem errors throw. */
export function reachablePath(paths: string[], roots: string[]): { path: string; root: string } | null {
  const rootForms = roots.flatMap((r) => [resolve(r), resolveExisting(r)]);
  for (const p of paths) {
    for (const form of [resolve(p), resolveExisting(p)]) {
      const root = rootForms.find((r) => within(r, form));
      if (root !== undefined) return { path: p, root };
    }
    let nlink = 1;
    try {
      nlink = statSync(p).nlink;
    } catch (err) {
      if ((err as { code?: unknown }).code !== "ENOENT") throw err;
    }
    if (nlink !== 1) return { path: p, root: "(a second hard link)" };
  }
  return null;
}

/** Structural check for a stored entry. It is deliberately loose about the
 *  job list and the timestamps: a record the digest will reject must still
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
    typeof o.workflow === "string" &&
    typeof o.job === "string" &&
    typeof o.startedAt === "string" &&
    typeof o.finishedAt === "string" &&
    Array.isArray(o.jobs) &&
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

export type ApprovalEvidenceVerdict =
  | { ok: true; digest: string }
  | { ok: false; reason: RefusalReason; state: string; remedy: string };

const RERECORD = "run the review build on the host and record its evidence for this dispatch, then approve again";

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** An ISO-8601 instant with a time and a zone whose fields name a real
 *  calendar date and time, or null. */
export function parseIsoInstant(value: string): number | null {
  const m = ISO_INSTANT.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (days === undefined || d < 1 || d > days || h > 23 || mi > 59 || s > 59) return null;
  if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Check one record against the binding, the selected CI job and the host key.
 *  In order: the digest, the HMAC, the timestamps, the job list, the exit
 *  statuses, the CI job, and the repository, PR, dispatch, reviewer, session
 *  and commit. */
export function validateApprovalEvidence(
  record: ApprovalEvidenceRecord,
  binding: ApprovalEvidenceBinding,
  ciJob: ApprovalCiJob,
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
      state: "digest does not match record contents",
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
  const started = parseIsoInstant(record.startedAt);
  if (started === null) {
    return { ok: false, reason: "approval_evidence_incomplete", state: "the approval-evidence record has no valid start time", remedy: RERECORD };
  }
  const finished = parseIsoInstant(record.finishedAt);
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
  if (record.jobs.length === 0) {
    return { ok: false, reason: "approval_evidence_incomplete", state: "the approval-evidence record lists no job", remedy: RERECORD };
  }
  for (const j of record.jobs) {
    if (
      typeof j?.job !== "string" ||
      j.job === "" ||
      !Array.isArray(j.commands) ||
      j.commands.length === 0 ||
      !j.commands.every((c) => typeof c === "string" && c !== "") ||
      !Number.isInteger(j.exitCode)
    ) {
      return {
        ok: false,
        reason: "approval_evidence_incomplete",
        state: "job entry lacks a valid name, command, or integer exit status",
        remedy: RERECORD,
      };
    }
  }
  const failed = record.jobs.find((j) => j.exitCode !== 0);
  if (failed) {
    return {
      ok: false,
      reason: "approval_evidence_failed",
      state: `the review build's job "${failed.job}" exited ${failed.exitCode}`,
      remedy: "a passing review build of this commit is required before an APPROVE",
    };
  }
  if (record.workflow !== ciJob.workflow || record.job !== ciJob.job) {
    return {
      ok: false,
      reason: "approval_evidence_mismatch",
      state: "the approval-evidence record is not for the configured CI workflow and job",
      remedy: "record the configured CI job's review build for this dispatch, then approve again",
    };
  }
  if (record.jobs[record.jobs.length - 1]!.job !== record.job) {
    return {
      ok: false,
      reason: "approval_evidence_incomplete",
      state: "the approval-evidence record does not end with the selected CI job",
      remedy: RERECORD,
    };
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
