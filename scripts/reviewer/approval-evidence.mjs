/**
 * approval-evidence.mjs — the host-side writer of the record `github_review`
 * requires for an APPROVE (tpsdev-ai/cli#426). run-review-jobs.mjs calls it.
 *
 * The record's bytes, digest and HMAC must match the verifier in
 * plugins/openclaw-github-review/src/approval-evidence.ts; the plugin suite
 * verifies a record this module wrote.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const APPROVAL_EVIDENCE_VERSION = 2;
const LOCK_TIMEOUT_MS = 1500;

/** The exact bytes the digest and the HMAC cover. */
export function approvalEvidenceBytes(f) {
  return JSON.stringify({
    version: f.version,
    repo: f.repo,
    pr: f.pr,
    dispatchId: f.dispatchId,
    reviewer: f.reviewer,
    sessionKey: f.sessionKey,
    commit: f.commit,
    workflow: f.workflow,
    job: f.job,
    startedAt: f.startedAt,
    finishedAt: f.finishedAt,
    jobs: Array.isArray(f.jobs) ? f.jobs.map((j) => ({ job: j?.job, commands: j?.commands, exitCode: j?.exitCode })) : f.jobs,
  });
}

export function buildApprovalEvidence(input, key) {
  const fields = { version: APPROVAL_EVIDENCE_VERSION, ...input };
  const bytes = approvalEvidenceBytes(fields);
  return {
    ...fields,
    digest: createHash("sha256").update(bytes, "utf8").digest("hex"),
    mac: createHmac("sha256", key).update(bytes, "utf8").digest("hex"),
  };
}

/** The path with every symlink in its existing prefix resolved. */
function resolveExisting(path) {
  let head = resolve(path);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    const parent = dirname(head);
    if (parent === head) return resolve(path);
    tail.push(basename(head));
    head = parent;
  }
}

const within = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** The first of `paths` that is at or under one of `roots` (each compared as
 *  given and with symlinks resolved), or that has a second hard link; null
 *  when none is. Throws when a path cannot be resolved. */
export function reachablePath(paths, roots) {
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
      if (err?.code !== "ENOENT") throw err;
    }
    if (nlink !== 1) return { path: p, root: "(a second hard link)" };
  }
  return null;
}

export function readHostKey(file) {
  const text = readFileSync(file, "utf8").trim();
  if (text === "") throw new Error("the approval-evidence host key file is empty");
  const key = Buffer.from(text, "base64");
  if (key.length === 0) throw new Error("the approval-evidence host key file is not base64");
  return key;
}

const refuse = (kind, message) => ({ ok: false, refusal: { kind, message } });

/**
 * Check the evidence request before the build runs: the bound fields, absolute
 * store and key paths outside every root the sandboxes mount, and a readable key.
 * @returns {{ok:true, key:Buffer} | {ok:false, refusal:{kind,message}}}
 */
export function prepareApprovalEvidence(evidence, mountRoots) {
  const { file, keyFile, repo, pr, dispatchId, reviewer, sessionKey, commit } = evidence ?? {};
  for (const [name, value] of Object.entries({ file, keyFile, repo, dispatchId, reviewer, sessionKey })) {
    if (typeof value !== "string" || value === "") return refuse("bad-input", `evidence ${name} is required`);
  }
  if (!Number.isInteger(pr) || pr <= 0) return refuse("bad-input", "evidence pr must be a positive integer");
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) return refuse("bad-input", "evidence commit must be a full commit id");
  if (!isAbsolute(file) || !isAbsolute(keyFile)) return refuse("bad-input", "the evidence store and its key must be absolute paths");
  let reachable;
  try {
    reachable = reachablePath([file, keyFile], mountRoots);
  } catch (err) {
    return refuse("evidence-reachable", `the evidence store and its key cannot be shown to be outside the sandbox mounts: ${err?.message ?? err}`);
  }
  if (reachable) return refuse("evidence-reachable", `${reachable.path} is reachable from a sandbox (${reachable.root})`);
  try {
    return { ok: true, key: readHostKey(keyFile) };
  } catch {
    return refuse("key-unreadable", "the host key for the approval evidence could not be read");
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` under the store's O_EXCL lock file (store-lock.ts's protocol). */
function withStoreLock(file, op, fn) {
  const lockPath = `${file}.lock`;
  const token = randomBytes(16).toString("hex");
  const start = Date.now();
  let fd;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      if (Date.now() - start >= LOCK_TIMEOUT_MS) throw new Error(`the store lock ${lockPath} is held`);
      sleepSync(5);
    }
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), since: new Date().toISOString(), op, token }));
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // It stays, and the next operation reports it as held.
    }
    throw err;
  }
  closeSync(fd);
  try {
    return fn();
  } finally {
    try {
      if (JSON.parse(readFileSync(lockPath, "utf8")).token === token) unlinkSync(lockPath);
    } catch {
      // The lock stays; the next operation fails closed on it.
    }
  }
}

/** Replace the store durably (durable-file.ts's protocol). */
function writeJsonStore(file, value) {
  const tmp = `${file}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  let renamed = false;
  try {
    try {
      writeSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    renamed = true;
    const dfd = openSync(dirname(file), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // inert
      }
    }
  }
}

const sameBinding = (a, b) =>
  a.repo === b.repo && a.pr === b.pr && a.dispatchId === b.dispatchId && a.reviewer === b.reviewer && a.sessionKey === b.sessionKey && a.commit === b.commit;

/** Upsert one record by its bound fields, under the store lock. Throws when it
 *  cannot read or write the store. */
export function writeApprovalEvidence(file, record) {
  withStoreLock(file, "approval-evidence write", () => {
    let approvals = [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(parsed?.approvals)) throw new Error("the approval-evidence store has an unrecognised shape");
      approvals = parsed.approvals;
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    writeJsonStore(file, { approvals: [...approvals.filter((a) => !sameBinding(a, record)), record] });
  });
}
