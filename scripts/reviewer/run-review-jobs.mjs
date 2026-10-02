#!/usr/bin/env node
/**
 * run-review-jobs.mjs — the host-side driver for a review build (tpsdev-ai/cli#435).
 *
 * review-build-ok is ADVISORY EVIDENCE for the reviewer, not a merge gate: CI
 * stays the gate. What this driver holds is the isolation boundary the
 * in-container launcher cannot: one sandbox container per job, each from its
 * own fresh clone, so state inside .git/, a process that starts its own session
 * (setsid), and anything else a job leaves in its tree cannot reach the next
 * job. The driver attaches no host mount beyond that job's own clone.
 *
 * Per job of the named job's `needs` closure, in dependency order, it:
 *   1. makes a FRESH clone of the assigned commit from the read-only source the
 *      host provides (a bare clone, or a checkout; never written to);
 *   2. starts ONE sandbox container with that job's clone bound (writable) at
 *      /workspace, in OpenClaw's run model (read-only root, tmpfs on /tmp,
 *      /var/tmp and /run, no network, all caps dropped, no-new-privileges), and
 *      runs /opt/reviewer/bin/reviewer-launch in it — which runs that one job;
 *   3. removes the container, refusing the build if that removal fails, and
 *      DISCARDS the job's directory.
 * A job runs only if the jobs it needs succeeded (or its `if:` is always()), and
 * it reports review-build-ok only when every job ran to a job-ok verdict that
 * names that job and its launcher exited 0, and every executed `run:` step exited 0,
 * with allowed `uses:` steps recorded as skipped.
 *
 * The assignment the launcher reads from its container init's environment is set
 * here, in the container's create-time env file, never in the launcher's caller.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planJob } from "./ci-job.mjs";
import { RESERVED_ENV_KEYS } from "./reviewer-launch.mjs";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LAUNCHER = "/opt/reviewer/bin/reviewer-launch";
/** The container init's environment carries the assignment; nothing else does. */
export const ENV_KEYS = Object.freeze({ workflow: "REVIEWER_CI_WORKFLOW", job: "REVIEWER_CI_JOB", base: "REVIEWER_CI_BASE" });
/** How long past a job's timeout-minutes the driver waits for its container. */
export const CONTAINER_GRACE_MS = 60_000;
export const LABEL = "tps.reviewer.job";
/** The job's clone belongs to whoever runs this driver; run the sandbox as that user. */
const currentUser = () => (typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid()}` : undefined);

const ok = (value) => ({ ok: true, ...value });
/** A job's captured launcher output, bounded to its tail before it is reported. */
const tailOutput = (text, maxChars = 8192) => { const s = String(text ?? ""); return s.length <= maxChars ? s : s.slice(s.length - maxChars); };
const refuse = (kind, message, output) => ({ ok: false, refusal: output ? { kind, message, output: tailOutput(output) } : { kind, message } });

/** The default docker runner: one argv, a hard timeout, stdout and stderr captured (up to 16 MiB each). */
export function dockerRunner(args, { timeoutMs = 120_000 } = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { status: null, errorCode: r.error.code, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error.code ?? "error"}: ${r.error.message}` };
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The default git runner (read-only against the source). */
export function gitRunner(args, { timeoutMs = 120_000 } = {}) {
  const r = spawnSync("/usr/bin/git", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { status: null, errorCode: r.error.code, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error.code ?? "error"}: ${r.error.message}` };
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** `git clone` args for a fresh depth-1 (or full) clone of the source. */
export function cloneArgs({ source, dir, depth }) {
  const shallow = depth === 0 ? [] : ["--depth", "1", "--no-tags"];
  return ["clone", "--quiet", ...shallow, `file://${source}`, dir];
}

/** `docker create` args for one job's sandbox, in OpenClaw's run model: the
 * job's own clone at /workspace and NO other host mount. */
export function containerArgs({ image, dir, envFile, jobId, user }) {
  return [
    "create",
    "--init",
    "--read-only",
    "--tmpfs", "/tmp",
    "--tmpfs", "/var/tmp",
    "--tmpfs", "/run",
    "--network", "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    ...(user ? ["--user", user] : []),
    "--workdir", "/workspace",
    "-v", `${dir}:/workspace`,
    "--env-file", envFile,
    "--label", `${LABEL}=${jobId}`,
    image,
    "sleep", "infinity",
  ];
}

const lastJsonLine = (text) => {
  const lines = String(text).split("\n").filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // not the verdict line
    }
  }
  return null;
};

/**
 * Run one job in its own container, from a fresh clone of the source.
 * @returns {{ok:true, job, steps} | {ok:false, refusal, stop?}}
 */
function runOneJob({ job, source, scratch, image, workflow, base, docker, git }) {
  const dir = join(scratch, job.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const clone = git(cloneArgs({ source, dir, depth: job.fetchDepth }));
  if (clone.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return refuse("clone-failed", `job ${job.id}: cloning the assigned commit from the source failed: ${(clone.stderr ?? "").split("\n")[0]}`);
  }
  // Best effort: the sandbox runs as this user, so it can write the bind;
  // widen the permissions anyway.
  try {
    execFileSync("chmod", ["-R", "a+rX", dir], { stdio: "ignore" });
    execFileSync("chmod", ["0777", dir], { stdio: "ignore" });
  } catch {
    // best effort; on a host whose reviewer uid owns the tree, no chmod is needed
  }

  const envFile = join(scratch, `${job.id}.env`);
  writeFileSync(envFile, `${ENV_KEYS.workflow}=${workflow}\n${ENV_KEYS.job}=${job.id}\n${ENV_KEYS.base}=${base}\n`, { mode: 0o600 });

  const created = docker(containerArgs({ image, dir, envFile, jobId: job.id, user: currentUser() }));
  const cid = (created.stdout ?? "").trim();
  if (created.status !== 0 || cid === "") {
    rmSync(dir, { recursive: true, force: true });
    return refuse("container-create", `job ${job.id}: the sandbox container could not be created: ${(created.stderr ?? "").split("\n")[0]}`);
  }
  const timeoutMs = job.timeoutMinutes * 60_000 + CONTAINER_GRACE_MS;
  let execStatus = null;
  let result = null;
  let output = "";
  let removeFailure = null;
  try {
    const started = docker(["start", cid]);
    if (started.status !== 0) {
      result = { ok: false, kind: "container-start", message: `job ${job.id}: the sandbox container could not be started: ${(started.stderr ?? "").split("\n")[0]}` };
    } else {
      const exec = docker(["exec", cid, LAUNCHER], { timeoutMs });
      output = exec.stderr ?? "";
      execStatus = exec.status;
      if (exec.status === null) {
        result = exec.errorCode === "ETIMEDOUT"
          ? { ok: false, kind: "container-timeout", message: `job ${job.id}: the sandbox container did not finish within ${Math.round(timeoutMs / 1000)} s` }
          : { ok: false, kind: "container-exec", message: `job ${job.id}: the sandbox exec failed (${exec.errorCode ?? "unknown error"})` };
      } else {
        const verdict = lastJsonLine(exec.stdout);
        result =
          verdict && typeof verdict === "object"
            ? verdict
            : { ok: false, kind: "launcher-unreadable", message: `job ${job.id}: the launcher in the sandbox wrote no verdict (exit ${exec.status})` };
      }
    }
  } finally {
    const removed = docker(["rm", "-f", cid]);
    rmSync(dir, { recursive: true, force: true });
    rmSync(envFile, { force: true });
    if (removed.status !== 0) removeFailure = `job ${job.id}: the sandbox container could not be removed: ${(removed.stderr ?? "").split("\n")[0]}`;
  }
  // A container that could not be removed leaves the host dirty: stop the build
  // before the next job starts, whatever the job's own verdict was.
  if (removeFailure) return { ok: false, stop: true, refusal: { kind: "container-remove", message: removeFailure } };
  // A job passes only on a job-ok verdict that names THIS job and a launcher
  // that exited 0: a crash after printing `ok:true`, another job's verdict, or a
  // non-zero exit carrying `ok:true` is not a pass.
  if (execStatus === 0 && result.ok === true && result.status === "job-ok" && result.job === job.id) {
    return ok({ job: job.id, steps: result.jobs?.[0]?.steps ?? [] });
  }
  return refuse(result.kind ?? "job-failed", result.message ?? `job ${job.id}: the launcher did not report job-ok (exit ${execStatus})`, output);
}

/**
 * Run the named job's `needs` closure, one sandbox container per job.
 * @returns {{ok:true, status:"review-build-ok", image, jobs:object[]}
 *          | {ok:false, refusal:{kind,message}}}
 */
export function runReviewJobs({
  image,
  source,
  scratch,
  workflow,
  job,
  base,
  docker = dockerRunner,
  git = gitRunner,
  now = () => Date.now(),
} = {}) {
  for (const [name, value] of Object.entries({ image, source, scratch, workflow, job, base })) {
    if (typeof value !== "string" || value === "") return refuse("bad-input", `${name} is required`);
  }
  const sourceReal = resolve(source);
  if (!existsSync(sourceReal)) return refuse("bad-input", `the source ${sourceReal} does not exist`);
  mkdirSync(scratch, { recursive: true });

  const read = git(["-C", sourceReal, "show", `HEAD:${workflow}`]);
  if (read.status !== 0) return refuse("no-ci-job", `the source has no ${workflow} (${(read.stderr ?? "").split("\n")[0]})`);
  const plan = planJob({ workflowText: read.stdout, workflowFile: workflow, jobId: job, baseBranch: base, reservedEnvKeys: RESERVED_ENV_KEYS });
  if (!plan.ok) return plan;

  const status = new Map();
  const jobs = [];
  const startedAt = now();
  let failure = null;
  for (const current of plan.jobs) {
    const blocked = current.needs.filter((n) => status.get(n) !== "ok");
    if (blocked.length > 0 && current.when !== "always") {
      status.set(current.id, "skipped");
      jobs.push({ job: current.id, skipped: `needs ${blocked.join(", ")}, which did not succeed` });
      continue;
    }
    const r = runOneJob({ job: current, source: sourceReal, scratch, image, workflow, base, docker, git });
    if (!r.ok) {
      status.set(current.id, "failed");
      jobs.push({ job: current.id, failed: r.refusal });
      failure ??= r.refusal;
      // A container that could not be removed stops the build here.
      if (r.stop) break;
      continue;
    }
    jobs.push({ job: current.id, steps: r.steps });
    status.set(current.id, "ok");
  }
  if (failure) return { ok: false, refusal: failure, jobs };
  const notOk = plan.jobs.find((j) => status.get(j.id) !== "ok");
  if (notOk) {
    const entry = jobs.find((j) => j.job === notOk.id);
    return { ok: false, refusal: { kind: "stage-failed", message: `job ${notOk.id}: ${entry?.skipped ?? "it did not run"}` }, jobs };
  }
  return ok({ status: "review-build-ok", image, jobs, wall_ms: now() - startedAt });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `usage: run-review-jobs.mjs --image <ref> --source <git-dir> --scratch <dir>
         --workflow <.github/workflows/x.yml> --job <name> --base <branch>`;

function parseArgs(argv) {
  const out = {};
  const names = { image: "image", source: "source", scratch: "scratch", workflow: "workflow", job: "job", base: "base" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = a.startsWith("--") ? names[a.slice(2)] : undefined;
    if (!key) return { error: `unknown argument ${a}` };
    const v = argv[++i];
    if (v === undefined) return { error: `${a} needs a value` };
    out[key] = v;
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`${args.error}\n${USAGE}\n`);
    return 2;
  }
  const missing = ["image", "source", "scratch", "workflow", "job", "base"].filter((k) => typeof args[k] !== "string");
  if (missing.length > 0) {
    process.stderr.write(`missing required: ${missing.join(", ")}\n${USAGE}\n`);
    return 2;
  }
  const result = runReviewJobs(args);
  if (result.ok) {
    process.stdout.write(`${JSON.stringify({ status: result.status, image: result.image, jobs: result.jobs })}\n`);
    return 0;
  }
  process.stderr.write(`refused: ${result.refusal.kind}: ${result.refusal.message}\n`);
  if (result.refusal.output) process.stderr.write(`${result.refusal.output}\n`);
  process.stdout.write(`${JSON.stringify({ status: "refused", ...result.refusal, jobs: result.jobs })}\n`);
  return 1;
}

if (process.argv[1]?.endsWith("run-review-jobs.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
