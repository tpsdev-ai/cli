/**
 * approval-driver.ts — the HOST-SIDE writer of the review build's evidence.
 *
 * This is the host boundary the in-sandbox launcher cannot be: the trusted host
 * process runs the review job, observes the commands it ran and their exit
 * statuses, the commit it cloned and the run's start and finish instants, and
 * writes ONE authenticated record (approval-evidence.ts) after the job ends.
 * The record is built from what the host observed, never from anything the
 * sandbox reports, and it is signed with a host-held key the sandbox cannot
 * read. `github_review` accepts an `APPROVE` only when such a record is present
 * and verifies; this module writes it.
 *
 * WHERE IT HOOKS. The host process that launches the review build calls
 * `recordApprovalEvidence` with its own job runner (`runJob`): the function that
 * runs the sandboxed job and returns the host's observations of it. In the
 * tpsdev-ai/cli repository that process is the review-job driver
 * (`scripts/reviewer/run-review-jobs.mjs`, tpsdev-ai/cli#435): it plans the job
 * and runs it, one sandbox container per job, and calls this writer with the
 * steps it ran. Until that driver is wired to it on a host, the evidence for an
 * `APPROVE` is simply absent, and `APPROVE` is refused
 * (`approval_evidence_missing`).
 *
 * STORE LOCATION. `evidenceFile` and `keyFile` must be absolute and OUTSIDE the
 * review worktree the sandbox mounts (the driver refuses a path inside it): the
 * sandbox mounts the worktree writable at /workspace and nothing else, so a
 * record under it would be writable — and the key under it readable — from
 * inside the sandbox.
 */
import { isAbsolute, relative, resolve } from "node:path";
import {
  buildApprovalEvidence,
  readHostKey,
  writeApprovalEvidence,
  type ApprovalCommand,
  type ApprovalCommandRole,
  type ApprovalEvidenceRecord,
} from "./approval-evidence.js";

/** One command the host ran, as the host observed it. */
export interface ObservedCommand {
  command: string;
  exitCode: number;
}

/** The host's observation of one completed job. */
export interface JobObservation {
  /** The full commit the job cloned and ran against. */
  commit: string;
  /** ISO-8601 instant the job started. */
  startedAt: string;
  /** ISO-8601 instant the job finished. */
  finishedAt: string;
  commands: ObservedCommand[];
}

/** What the host must know to run the job: the dispatch it belongs to and the
 *  CI job to run. */
export interface ReviewJob {
  repo: string;
  pr: number;
  dispatchId: string;
  reviewer: string;
  sessionKey: string;
  commit: string;
  workflow: string;
  jobId: string;
  base: string;
}

/** The host's job runner: runs the sandboxed job and returns its observations. */
export type JobRunner = (job: ReviewJob) => JobObservation;

export interface RecordApprovalInput {
  job: ReviewJob;
  /** Absolute path of the host-only evidence store (outside the worktree). */
  evidenceFile: string;
  /** Absolute path of the host-held HMAC key file (outside the worktree). */
  keyFile: string;
  /** The review worktree the sandbox mounts, if the host knows it: a store at
   *  or under this path is refused. */
  worktreeDir?: string;
  runJob: JobRunner;
}

export type RecordApprovalResult = { ok: true; record: ApprovalEvidenceRecord } | { ok: false; refusal: { kind: string; message: string } };

const refuse = (kind: string, message: string): RecordApprovalResult => ({ ok: false, refusal: { kind, message } });

/** The stage a planned command contributes: a test command, a build command,
 *  or neither. The rule is by word in the command text (`test`/`tests`,
 *  case-insensitive and word-bounded, wins over `build`). */
export function classifyCommandRole(command: string): ApprovalCommandRole {
  if (/\btests?\b/i.test(command)) return "test";
  if (/\bbuild\b/i.test(command)) return "build";
  return "other";
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const isoInstant = (value: string): number | null => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? ms : null;
};

/**
 * Run one review job on the host and write its authenticated evidence.
 * Refuses (writing nothing) when a store path is missing, relative or inside the
 * worktree; when the key cannot be read; when the job's commit is not the bound
 * commit; when a timestamp is not a valid ordered pair of instants; when any
 * command failed; or when no build or no test command is present.
 */
export function recordApprovalEvidence({
  job,
  evidenceFile,
  keyFile,
  worktreeDir,
  runJob,
}: RecordApprovalInput): RecordApprovalResult {
  for (const [name, value] of Object.entries({ evidenceFile, keyFile })) {
    if (typeof value !== "string" || value === "" || !isAbsolute(value)) {
      return refuse("bad-input", `${name} must be an absolute path`);
    }
  }
  if (worktreeDir && (inside(worktreeDir, evidenceFile) || inside(worktreeDir, keyFile))) {
    return refuse("store-in-worktree", "the evidence store and its key must be outside the review worktree the sandbox mounts");
  }
  let key: Buffer;
  try {
    key = readHostKey(keyFile);
  } catch {
    return refuse("key-unreadable", "the host key for the approval evidence could not be read");
  }

  let observed: JobObservation;
  try {
    observed = runJob(job);
  } catch (err) {
    return refuse("job-failed", `the review job could not be run: ${(err as Error)?.message ?? "error"}`);
  }
  if (observed.commit !== job.commit) {
    return refuse("commit-mismatch", "the review job ran against a commit other than the bound commit");
  }
  const started = isoInstant(observed.startedAt);
  const finished = isoInstant(observed.finishedAt);
  if (started === null || finished === null || finished < started) {
    return refuse("bad-timestamps", "the review job's start and finish times are not a valid ordered pair of instants");
  }
  if (!Array.isArray(observed.commands) || observed.commands.length === 0) {
    return refuse("no-commands", "the review job ran no command");
  }
  const commands: ApprovalCommand[] = observed.commands.map((c) => ({
    command: c.command,
    role: classifyCommandRole(c.command),
    exitCode: c.exitCode,
  }));
  const failed = commands.find((c) => c.exitCode !== 0);
  if (failed) {
    return refuse("job-failed", `the review job's command "${failed.command}" exited ${failed.exitCode}`);
  }
  for (const role of ["build", "test"] as const) {
    if (!commands.some((c) => c.role === role)) {
      return refuse("no-stages", `the review job ran no ${role} command`);
    }
  }

  const record = buildApprovalEvidence(
    {
      repo: job.repo,
      pr: job.pr,
      dispatchId: job.dispatchId,
      reviewer: job.reviewer,
      sessionKey: job.sessionKey,
      commit: job.commit,
      startedAt: observed.startedAt,
      finishedAt: observed.finishedAt,
      commands,
    },
    key,
  );
  try {
    writeApprovalEvidence(evidenceFile, record);
  } catch {
    return refuse("store-unwritable", "the approval-evidence store could not be written");
  }
  return { ok: true, record };
}
