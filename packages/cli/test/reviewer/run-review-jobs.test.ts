/**
 * run-review-jobs.test.ts — the host-side review-build driver (tpsdev-ai/cli#435):
 * one sandbox container per job of the `needs` closure, each from a fresh clone
 * of the read-only source, with the assignment set in the container's
 * create-time env file; needs gating, aggregation, and the discard of each job's
 * directory.
 *
 * Docker is not available in every lane, so the driver takes an injected
 * `docker` runner: these tests drive a fake one and a REAL git source. The real
 * container path is exercised by scripts/reviewer/per-job-isolation-checks.sh.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloneArgs, containerArgs, gitRunner, runReviewJobs } from "../../../../scripts/reviewer/run-review-jobs.mjs";

const CHECKOUT = "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683";
const SETUP_BUN = "oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76";
const GIT_ENV = () => ({ PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" });
const git = (cwd: string, ...args: string[]) => spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8", env: GIT_ENV() });

let root: string;
let src: string;
let source: string;
let scratch: string;

/** A pull_request workflow with `build` and `review` (needs: build) plus extra jobs. */
function writeWorkflow(jobs = "", reviewExtra = "") {
  const base = `on:\n  pull_request:\n    branches: [main]\njobs:\n${jobs}  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${CHECKOUT}\n      - uses: ${SETUP_BUN}\n        with:\n          bun-version: "1.3.10"\n      - run: echo b\n  review:\n    runs-on: ubuntu-latest\n    needs: build\n${reviewExtra}    steps:\n      - uses: ${CHECKOUT}\n      - uses: ${SETUP_BUN}\n        with:\n          bun-version: "1.3.10"\n      - run: echo r\n`;
  mkdirSync(join(src, ".github", "workflows"), { recursive: true });
  writeFileSync(join(src, ".github", "workflows", "ci.yml"), base);
}

/** A fake docker: records creates/execs by container id; the exec verdict is per job. */
function fakeDocker(verdicts: Record<string, unknown> = {}, onExec?: (job: string, dir: string) => void) {
  const byId = new Map<string, { job: string; dir: string; env: Record<string, string> }>();
  const seen = { creates: [] as { job: string; dir: string; args: string[] }[], execs: [] as string[], removed: [] as string[] };
  const envById = new Map<string, Record<string, string>>();
  let n = 0;
  const run = (args: string[]) => {
    if (args[0] === "create") {
      const envFile = args[args.indexOf("--env-file") + 1];
      const env = Object.fromEntries(
        readFileSync(envFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
      const dir = args[args.indexOf("-v") + 1].split(":")[0];
      const id = `cid${++n}`;
      byId.set(id, { job: env.REVIEWER_CI_JOB, dir, env });
      envById.set(env.REVIEWER_CI_JOB, env);
      seen.creates.push({ job: env.REVIEWER_CI_JOB, dir, args });
      return { status: 0, stdout: `${id}\n`, stderr: "" };
    }
    if (args[0] === "start") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "exec") {
      const id = args[1];
      const c = byId.get(id);
      if (!c) return { status: 1, stdout: "", stderr: "no such container" };
      seen.execs.push(c.job);
      onExec?.(c.job, c.dir);
      const v = verdicts[c.job] ?? { ok: true, status: "job-ok", job: c.job, jobs: [{ job: c.job, steps: [] }] };
      return { status: (v as { ok?: boolean }).ok === false ? 1 : 0, stdout: `${JSON.stringify(v)}\n`, stderr: "" };
    }
    if (args[0] === "rm") {
      seen.removed.push(args[2]);
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, seen, dirOf: (job: string) => seen.creates.find((c) => c.job === job)?.dir, envOf: (job: string) => envById.get(job) };
}

function drive(docker: (a: string[], o?: unknown) => unknown, overrides: Record<string, unknown> = {}) {
  return runReviewJobs({
    image: "reviewer-image:fixture",
    source,
    scratch,
    workflow: ".github/workflows/ci.yml",
    job: "review",
    base: "main",
    docker,
    ...overrides,
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "run-review-jobs-")));
  src = join(root, "src");
  source = join(root, "source.git");
  scratch = join(root, "jobs");
  mkdirSync(src);
  mkdirSync(scratch);
  writeFileSync(join(src, "package.json"), JSON.stringify({ name: "fixture", private: true, packageManager: "bun@1.3.10", engines: { node: "22.x" } }));
  git(src, "init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function publish() {
  writeWorkflow();
  git(src, "add", "-A");
  git(src, "-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "-q", "-m", "fixture");
  const r = spawnSync("/usr/bin/git", ["clone", "-q", "--bare", src, source], { encoding: "utf8", env: GIT_ENV() });
  if (r.status !== 0) throw new Error(`bare clone failed: ${r.stderr}`);
}

describe("#435 — one sandbox container per job, from a fresh clone", () => {
  test("runs the needs closure dependencies first, one container per job, each from its own clone, and discards the tree", async () => {
    publish();
    const d = fakeDocker({}, (job, dir) => {
      // The clone exists inside the container's bind when the launcher runs.
      if (!existsSync(join(dir, ".git"))) throw new Error(`no clone for ${job} at ${dir}`);
    });
    const r = await drive(d.run);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("review-build-ok");
    expect(r.jobs.map((j: { job: string }) => j.job)).toEqual(["build", "review"]);
    expect(d.seen.execs).toEqual(["build", "review"]);
    const buildDir = d.dirOf("build")!;
    const reviewDir = d.dirOf("review")!;
    expect(buildDir).not.toBe(reviewDir);
    expect(buildDir.endsWith("/build")).toBe(true);
    expect(reviewDir.endsWith("/review")).toBe(true);
    // Each container's create-time env names the ONE job it runs, read from /proc/1/environ by the launcher.
    expect(d.envOf("build")?.REVIEWER_CI_JOB).toBe("build");
    expect(d.envOf("review")?.REVIEWER_CI_JOB).toBe("review");
    expect(d.envOf("review")?.REVIEWER_CI_WORKFLOW).toBe(".github/workflows/ci.yml");
    // Every container is removed and every job's directory discarded.
    expect(d.seen.removed.length).toBe(2);
    expect(existsSync(buildDir)).toBe(false);
    expect(existsSync(reviewDir)).toBe(false);
    expect(existsSync(join(scratch, "build.env"))).toBe(false);
  });

  test("the container runs the launcher in OpenClaw's run model, with the job's clone bound writable at /workspace", () => {
    const args = containerArgs({ image: "img", dir: "/jobs/review", envFile: "/jobs/review.env", jobId: "review" });
    expect(args).toContain("--read-only");
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args[args.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(args[args.indexOf("--workdir") + 1]).toBe("/workspace");
    expect(args[args.indexOf("--env-file") + 1]).toBe("/jobs/review.env");
    expect(args).toContain("/jobs/review:/workspace");
    expect(args[args.indexOf("--label") + 1]).toBe("tps.reviewer.job=review");
    expect(args.slice(-2)).toEqual(["sleep", "infinity"]);
    // a read-only clone source is the host's; the container gets only the job's tree.
    expect(args.filter((a) => a.includes(":/workspace")).length).toBe(1);
    // Exactly one host mount: the job's own clone. No other host path is shared.
    expect(args.filter((a) => a === "-v").length).toBe(1);
    expect(args[args.indexOf("-v") + 1]).toBe("/jobs/review:/workspace");
  });

  test("the CLI refuses any extra host bind", () => {
    const driver = fileURLToPath(new URL("../../../../scripts/reviewer/run-review-jobs.mjs", import.meta.url));
    const r = spawnSync(process.execPath, [driver, "--image", "i", "--source", "/s", "--scratch", "/x", "--workflow", "w", "--job", "j", "--base", "b", "--bind", "/host:/evidence"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown argument --bind");
  });

  test("a job's sandbox runs as the user that owns its clone", () => {
    const args = containerArgs({ image: "img", dir: "/jobs/review", envFile: "/jobs/review.env", jobId: "review", user: "1000:1000" });
    expect(args[args.indexOf("--user") + 1]).toBe("1000:1000");
    // Without a user the sandbox keeps the image's own user.
    expect(containerArgs({ image: "img", dir: "/d", envFile: "/e", jobId: "review" })).not.toContain("--user");
  });

  test("a launcher that exits non-zero carrying ok:true is not a pass", async () => {
    publish();
    const docker = (args: string[]) => {
      if (args[0] === "create") return { status: 0, stdout: "cid\n", stderr: "" };
      if (args[0] === "start") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "exec")
        return { status: 1, stdout: `${JSON.stringify({ ok: true, status: "job-ok", job: "build", jobs: [{ job: "build", steps: [] }] })}\n`, stderr: "boom\n" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const r = await drive(docker);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("job-failed");
      expect(r.refusal.message).toContain("job build: the launcher did not report job-ok (exit 1)");
      expect((r.refusal as { output?: string }).output).toBe("boom\n");
    }
  });

  test("a launcher that exits 0 with a verdict that is not job-ok is not a pass", async () => {
    publish();
    const docker = (args: string[]) => {
      if (args[0] === "create") return { status: 0, stdout: "cid\n", stderr: "" };
      if (args[0] === "start") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "exec") return { status: 0, stdout: `${JSON.stringify({ ok: true, status: "self-check-ok", job: "build" })}\n`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const r = await drive(docker);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("job-failed");
      expect(r.refusal.message).toContain("job build: the launcher did not report job-ok (exit 0)");
    }
  });

  test("a timed-out exec's captured stderr reaches the refusal's output", async () => {
    publish();
    const partial = "step 2: running the build\n";
    const docker = (args: string[]) => {
      if (args[0] === "create") return { status: 0, stdout: "cid\n", stderr: "" };
      if (args[0] === "start") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "exec") return { status: null, stdout: "", stderr: partial };
      return { status: 0, stdout: "", stderr: "" };
    };
    const r = await drive(docker);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("container-timeout");
      expect((r.refusal as { output?: string }).output).toBe(partial);
    }
  });

  test("a timed-out docker runner keeps the stderr it captured and appends the error", () => {
    // A child process with a shim `docker` first on its PATH: the runner's hard
    // timeout kills the shim, which has already written to stderr.
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "docker"), "#!/bin/sh\nprintf 'partial stderr from the sandbox\\n' >&2\nexec sleep 30\n", { mode: 0o755 });
    const probe = join(root, "docker-runner-probe.mjs");
    const driver = fileURLToPath(new URL("../../../../scripts/reviewer/run-review-jobs.mjs", import.meta.url));
    writeFileSync(probe, `import { dockerRunner } from ${JSON.stringify(driver)};\nconsole.log(JSON.stringify(dockerRunner(["exec", "cid", "launcher"], { timeoutMs: 1500 })));\n`);
    const r = spawnSync(process.execPath, [probe], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 30_000 });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim()) as { status: unknown; stderr: string };
    expect(out.status).toBe(null);
    expect(out.stderr).toContain("partial stderr from the sandbox");
    expect(out.stderr).toContain("ETIMEDOUT");
  });

  test("a timed-out git runner keeps the stderr it captured and appends the error", () => {
    // A git alias that writes to stderr and then blocks: the runner's timeout
    // kills it, so the capture and the timeout error both exist.
    const r = gitRunner(["-c", "alias.blk=!printf 'partial git stderr\\n' >&2; exec sleep 30", "blk"], { timeoutMs: 1500 });
    expect(r.status).toBe(null);
    expect(r.stderr).toContain("partial git stderr");
    expect(r.stderr).toContain("ETIMEDOUT");
  });

  test("a job-ok verdict that names another job is not a pass", async () => {
    publish();
    let creates = 0;
    const docker = (args: string[]) => {
      if (args[0] === "create") {
        creates++;
        return { status: 0, stdout: `cid${creates}\n`, stderr: "" };
      }
      if (args[0] === "start") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "exec") return { status: 0, stdout: `${JSON.stringify({ ok: true, status: "job-ok", job: "someone-else", jobs: [] })}\n`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const r = await drive(docker);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.message).toContain("did not report job-ok");
    expect(creates).toBe(1);
  });

  test("a container that cannot be removed fails the run before the next job starts", async () => {
    publish();
    const d = fakeDocker();
    const docker = (args: string[]) => {
      if (args[0] === "rm") return { status: 1, stdout: "", stderr: "Error: cannot remove container\n" };
      return d.run(args);
    };
    const r = await drive(docker);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("container-remove");
      expect(r.refusal.message).toContain("could not be removed");
    }
    // The failed removal stops the build: the dependent job never runs.
    expect(d.seen.execs).toEqual(["build"]);
    expect(d.seen.creates.length).toBe(1);
  });

  test("a failed job carries the launcher's output (the step that failed) in its refusal", async () => {
    publish();
    const out = "step 3 FAILED: write tracked.txt\n";
    const docker = (args: string[]) => {
      if (args[0] === "create") return { status: 0, stdout: "cid\n", stderr: "" };
      if (args[0] === "start") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "exec") {
        const verdict = { ok: false, kind: "stage-failed", message: "job build: step 3 (change the tree) exited 1" };
        return { status: 1, stdout: `${JSON.stringify(verdict)}\n`, stderr: out };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const r = await drive(docker);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("stage-failed");
      expect((r.refusal as { output?: string }).output).toBe(out);
    }
  });

  test("depth 1 clones shallow and a full clone is not shallow", () => {
    expect(cloneArgs({ source: "/s", dir: "/d", depth: 1 })).toContain("--depth");
    expect(cloneArgs({ source: "/s", dir: "/d", depth: 1 }).slice(0, 3)).toEqual(["clone", "--quiet", "--depth"]);
    expect(cloneArgs({ source: "/s", dir: "/d", depth: 0 })).toEqual(["clone", "--quiet", "file:///s", "/d"]);
  });

  test("a job whose need fails is skipped: the dependent never runs, and the build is not ok", async () => {
    publish();
    const d = fakeDocker({ build: { ok: false, kind: "stage-failed", message: "job build: step 3 (run 3) exited 3" } });
    const r = await drive(d.run);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("stage-failed");
      expect(r.refusal.message).toBe("job build: step 3 (run 3) exited 3");
      expect(r.jobs).toEqual([{ job: "build", failed: { kind: "stage-failed", message: "job build: step 3 (run 3) exited 3" } }, { job: "review", skipped: "needs build, which did not succeed" }]);
    }
    expect(d.seen.execs).toEqual(["build"]);
  });

  test("a job with if: always() runs after a failed need, and the build is still not ok", async () => {
    publish();
    // review carries `if: always()`; add it to the workflow.
    writeWorkflow("", "    if: always()\n");
    git(src, "add", "-A");
    git(src, "-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "-q", "-m", "always");
    rmSync(source, { recursive: true, force: true });
    spawnSync("/usr/bin/git", ["clone", "-q", "--bare", src, source], { encoding: "utf8", env: GIT_ENV() });
    const d = fakeDocker({ build: { ok: false, kind: "stage-failed", message: "job build: step 3 (run 3) exited 1" } });
    const r = await drive(d.run);
    expect(r.ok).toBe(false);
    expect(d.seen.execs).toEqual(["build", "review"]);
  });

  test("a launcher refusal in a job is propagated with its kind", async () => {
    publish();
    const d = fakeDocker({ review: { ok: false, kind: "not-fresh", message: "the worktree is not the clean clone" } });
    const r = await drive(d.run);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe("not-fresh");
      expect(r.refusal.message).toContain("not the clean clone");
    }
  });

  test("a container that cannot be created is a named refusal and its job's directory is discarded", async () => {
    publish();
    let creates = 0;
    const docker = (args: string[]) => {
      if (args[0] === "create") {
        creates++;
        if (creates === 1) return { status: 125, stdout: "", stderr: "docker: Error response from daemon" };
        return { status: 0, stdout: "cid\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const r = await drive(docker);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.kind).toBe("container-create");
    expect(existsSync(join(scratch, "build"))).toBe(false);
  });

  test("a missing source, workflow or job is a named refusal before anything runs", async () => {
    publish();
    const d = fakeDocker();
    const noSource = await drive(d.run, { source: join(root, "nope") });
    expect(noSource.ok).toBe(false);
    if (!noSource.ok) expect(noSource.refusal.kind).toBe("bad-input");
    const noJob = await drive(d.run, { job: "missing" });
    expect(noJob.ok).toBe(false);
    expect(d.seen.creates.length).toBe(0);
  });
});
