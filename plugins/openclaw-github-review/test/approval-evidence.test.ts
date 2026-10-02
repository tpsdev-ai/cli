/**
 * approval-evidence.test.ts — tpsdev-ai/cli#426: APPROVE requires an
 * authenticated, passing evidence record for the same repository, PR,
 * dispatch, reviewer, session, commit and configured CI job. Each refusal case
 * asserts that NO review is posted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApprovalEvidence, writeApprovalEvidence } from "../../../scripts/reviewer/approval-evidence.mjs";
import { runReviewJobs } from "../../../scripts/reviewer/run-review-jobs.mjs";
import {
  approvalEvidenceDigest,
  parseIsoInstant,
  readApprovalEvidence,
  validateApprovalEvidence,
  type ApprovalEvidenceFields,
  type ApprovalEvidenceRecord,
} from "../src/approval-evidence.js";
import { runGithubReview } from "../src/handler.js";
import type { Outcome, RefusalReason } from "../src/types.js";
import {
  CI_JOB,
  CI_WORKFLOW,
  COMMIT,
  FakeGitHub,
  makeDeps,
  PASSING_JOBS,
  PR,
  REPO,
  REVIEWER,
  resolver,
  scenario,
  session,
  validAssignment,
  validInput,
  type Scenario,
} from "./helpers.js";

const SESSION = "sess-1";
const DISPATCH = "dispatch-1";
const OTHER = "b".repeat(40);
const HOST = session();
const CI = { workflow: CI_WORKFLOW, job: CI_JOB };

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "gr-evidence-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const BINDING = { repo: REPO, pr: PR, dispatchId: DISPATCH, reviewer: REVIEWER, sessionKey: SESSION, commit: COMMIT };

function record(s: Scenario, over: Partial<ApprovalEvidenceFields> = {}, key = s.approvalKey): ApprovalEvidenceRecord {
  return buildApprovalEvidence(
    {
      repo: REPO,
      pr: PR,
      dispatchId: DISPATCH,
      reviewer: REVIEWER,
      sessionKey: SESSION,
      commit: COMMIT,
      workflow: CI_WORKFLOW,
      job: CI_JOB,
      startedAt: "2026-10-02T00:00:00.000Z",
      finishedAt: "2026-10-02T00:10:00.000Z",
      jobs: PASSING_JOBS,
      ...over,
    },
    key,
  ) as ApprovalEvidenceRecord;
}

/** Replace the host-only store's contents. */
function setEvidence(s: Scenario, approvals: unknown): void {
  writeFileSync(s.config.approvalEvidenceFile!, JSON.stringify({ approvals }));
}

function refused(o: Outcome): asserts o is Extract<Outcome, { ok: false }> {
  expect(o.ok).toBe(false);
  if (o.ok) throw new Error("expected a refusal");
}

async function approve(s: Scenario, input: unknown = validInput()): Promise<{ o: Outcome; posts: number }> {
  const { deps, github } = makeDeps(s);
  const o = await runGithubReview(input, HOST, deps);
  return { o, posts: github.reviewCalls.length };
}

async function refusesWith(s: Scenario, reason: RefusalReason): Promise<void> {
  const { o, posts } = await approve(s);
  refused(o);
  expect(o.reason).toBe(reason);
  expect(posts).toBe(0);
}

describe("the evidence record", () => {
  test("write (scripts/reviewer/approval-evidence.mjs) → read round-trips; digest and MAC cover the bound fields", () => {
    const file = join(root, "ev.json");
    const s = scenario(join(root, "s"));
    const r = record(s);
    writeApprovalEvidence(file, r);
    expect(readApprovalEvidence(file)).toEqual([r]);
    expect(r.digest).toBe(approvalEvidenceDigest((({ digest: _d, mac: _m, ...f }) => f)(r)));
    expect(r.mac).toHaveLength(64);
    expect(validateApprovalEvidence(r, BINDING, CI, s.approvalKey)).toEqual({ ok: true, digest: r.digest });
    expect(record(s, { jobs: [PASSING_JOBS[1]!] }).digest).not.toBe(r.digest);
  });

  test("a missing file is empty; a malformed file is not read as empty", () => {
    expect(readApprovalEvidence(join(root, "absent.json"))).toEqual([]);
    const file = join(root, "bad.json");
    writeFileSync(file, "not json");
    expect(() => readApprovalEvidence(file)).toThrow();
  });

  test("a digest mismatch is invalid; a forged MAC is unauthenticated", () => {
    const s = scenario(join(root, "s"));
    const stale = validateApprovalEvidence({ ...record(s), commit: OTHER }, BINDING, CI, s.approvalKey);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("approval_evidence_invalid");

    const forged = validateApprovalEvidence(record(s, {}, Buffer.from("forger-key-0000000000000000")), BINDING, CI, s.approvalKey);
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.reason).toBe("approval_evidence_unauthenticated");
  });

  test("an instant must name a real calendar date and time", () => {
    for (const bad of ["2026-02-31T00:00:00Z", "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z", "2026-10-02T24:00:00Z", "2026-10-02T00:60:00Z", "2026-10-02T00:00:60Z", "2026-10-02T00:00:00+24:00", "2026-10-02", "not-a-time"]) {
      expect(parseIsoInstant(bad)).toBeNull();
    }
    expect(parseIsoInstant("2028-02-29T00:00:00Z")).toBe(Date.UTC(2028, 1, 29));
    expect(parseIsoInstant("2026-10-02T01:00:00.500+01:00")).toBe(Date.UTC(2026, 9, 2, 0, 0, 0, 500));
  });
});

describe("#426 — APPROVE requires an authenticated passing evidence record", () => {
  test("missing evidence refuses and posts nothing", async () => {
    const s = scenario(join(root, "m"));
    setEvidence(s, []);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_missing");
    expect(o.state.length).toBeGreaterThan(0);
    expect(o.remedy.length).toBeGreaterThan(0);
    expect(posts).toBe(0);
  });

  test("a record with no job refuses and posts nothing", async () => {
    const s = scenario(join(root, "i"));
    setEvidence(s, [record(s, { jobs: [] })]);
    await refusesWith(s, "approval_evidence_incomplete");
  });

  test("a job with no exit status, or no planned command, is incomplete", async () => {
    for (const [i, bad] of [{ job: CI_JOB, commands: ["bun run test"] }, { job: CI_JOB, commands: [], exitCode: 0 }].entries()) {
      const s = scenario(join(root, `x${i}`));
      setEvidence(s, [record(s, { jobs: [bad as never] })]);
      await refusesWith(s, "approval_evidence_incomplete");
    }
  });

  test("a malformed finish time refuses and posts nothing", async () => {
    const s = scenario(join(root, "f"));
    setEvidence(s, [record(s, { finishedAt: "not-a-finish-time" })]);
    await refusesWith(s, "approval_evidence_incomplete");
  });

  test("an impossible calendar date (2026-02-31) refuses and posts nothing", async () => {
    for (const [i, over] of [{ startedAt: "2026-02-31T00:00:00Z" }, { finishedAt: "2026-02-31T00:00:00Z" }].entries()) {
      const s = scenario(join(root, `cal${i}`));
      setEvidence(s, [record(s, { startedAt: "2026-02-01T00:00:00Z", ...over })]);
      await refusesWith(s, "approval_evidence_incomplete");
    }
  });

  test("a failed job refuses and posts nothing", async () => {
    const s = scenario(join(root, "fail"));
    setEvidence(s, [record(s, { jobs: [PASSING_JOBS[0]!, { ...PASSING_JOBS[1]!, exitCode: 1 }] })]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_failed");
    expect(o.state).toContain(`"${CI_JOB}"`);
    expect(posts).toBe(0);
  });

  test("a record for another CI job (echo build / echo test) refuses and posts nothing", async () => {
    const harmless = [{ job: "lint", commands: ["echo build", "echo test"], exitCode: 0 }];
    const cases: Array<Partial<ApprovalEvidenceFields>> = [
      { job: "lint", jobs: harmless },
      { workflow: ".github/workflows/other.yml" },
    ];
    for (const [i, over] of cases.entries()) {
      const s = scenario(join(root, `ci${i}`));
      setEvidence(s, [record(s, over)]);
      await refusesWith(s, "approval_evidence_mismatch");
    }
  });

  test("a record whose last job is not the selected CI job refuses and posts nothing", async () => {
    const s = scenario(join(root, "last"));
    setEvidence(s, [record(s, { jobs: [PASSING_JOBS[1]!, PASSING_JOBS[0]!] })]);
    await refusesWith(s, "approval_evidence_incomplete");
  });

  test("evidence for a different reviewer, session, commit, repo, PR or dispatch refuses and posts nothing", async () => {
    const cases: Array<Partial<ApprovalEvidenceFields>> = [
      { reviewer: "someone-else" },
      { sessionKey: "sess-other" },
      { commit: OTHER },
      { repo: "someone/else" },
      { pr: PR + 1 },
      { dispatchId: "dispatch-other" },
    ];
    for (const [i, over] of cases.entries()) {
      const s = scenario(join(root, `mm${i}`));
      setEvidence(s, [record(s, over)]);
      await refusesWith(s, "approval_evidence_mismatch");
    }
  });

  test("a record edited after it was written refuses on its digest", async () => {
    const s = scenario(join(root, "d"));
    setEvidence(s, [{ ...record(s), commit: OTHER }]);
    await refusesWith(s, "approval_evidence_invalid");
  });

  test("a record forged without the host key refuses and posts nothing", async () => {
    const s = scenario(join(root, "forged"));
    setEvidence(s, [record(s, {}, Buffer.from("forger-key-0000000000000000"))]);
    await refusesWith(s, "approval_evidence_unauthenticated");
  });

  test("an edited record with a recomputed digest refuses and posts nothing", async () => {
    const s = scenario(join(root, "edit"));
    const good = record(s);
    const { digest: _d, mac: _m, ...fields } = good;
    const editedFields: ApprovalEvidenceFields = { ...fields, jobs: [PASSING_JOBS[0]!, { ...PASSING_JOBS[1]!, commands: ["true"] }] };
    setEvidence(s, [{ ...editedFields, digest: approvalEvidenceDigest(editedFields), mac: good.mac }]);
    await refusesWith(s, "approval_evidence_unauthenticated");
  });

  test("an unconfigured evidence file, key, CI workflow, CI job or mount-root list refuses and posts nothing", async () => {
    const overs = [
      { approvalEvidenceFile: null },
      { approvalEvidenceKeyFile: null },
      { approvalCiWorkflow: null },
      { approvalCiJob: null },
      { sandboxMountRoots: [] },
      { sandboxMountRoots: ["relative/workspace"] },
    ];
    for (const [i, over] of overs.entries()) {
      const s = scenario(join(root, `u${i}`), over);
      await refusesWith(s, "approval_evidence_unconfigured");
    }
  });

  test("two matching records refuse (ambiguous), and nothing is posted", async () => {
    const s = scenario(join(root, "amb"));
    setEvidence(s, [record(s), record(s, { finishedAt: "2026-10-02T00:11:00.000Z" })]);
    await refusesWith(s, "approval_evidence_invalid");
  });

  test("passing evidence posts APPROVE and records the digest in the audit record", async () => {
    const s = scenario(join(root, "ok"));
    const r = record(s);
    setEvidence(s, [r]);
    const { deps, github, audit } = makeDeps(s);
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok).toBe(true);
    if (o.ok) expect(o.status).toBe("posted");
    expect(github.reviewCalls.length).toBe(1);
    expect(github.reviewCalls[0]!.event).toBe("APPROVE");
    const detail = JSON.parse(audit.events[0]!.detail) as Record<string, unknown>;
    expect(detail.approval_evidence_sha256).toBe(r.digest);
  });

  test("REQUEST_CHANGES and COMMENT post without evidence", async () => {
    for (const event of ["REQUEST_CHANGES", "COMMENT"] as const) {
      const s = scenario(join(root, event));
      setEvidence(s, []);
      const { deps, github, audit } = makeDeps(s);
      github.reviewResult = {
        ok: true,
        receipt: {
          id: 1,
          url: `https://example.test/${REPO}/pull/${PR}#r1`,
          commitId: COMMIT,
          state: event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED",
        },
      };
      const o = await runGithubReview(validInput({ event }), HOST, deps);
      expect(o.ok).toBe(true);
      if (o.ok) expect(o.status).toBe("posted");
      expect(github.reviewCalls.length).toBe(1);
      expect((JSON.parse(audit.events[0]!.detail) as Record<string, unknown>).approval_evidence_sha256).toBeNull();
    }
  });
});

describe("#426 — the store and key must be outside every sandbox mount root", () => {
  test("a store or key at or under a mount root refuses and posts nothing", async () => {
    for (const name of ["approval-evidence.json", "approval-evidence.key"]) {
      const dir = join(root, `in-${name}`);
      // A root that is the file itself (a single-file mount), and one that holds it.
      for (const mount of [join(dir, name), dir]) {
        const s = scenario(dir, { sandboxMountRoots: [join(root, "workspace"), mount] });
        await refusesWith(s, "approval_evidence_reachable");
      }
    }
  });

  test("a mount root reached through a symlink, and a key with a second hard link, refuse", async () => {
    const dir = join(root, "sym");
    mkdirSync(dir);
    const alias = join(root, "alias");
    symlinkSync(dir, alias);
    const s = scenario(dir, { sandboxMountRoots: [alias] });
    await refusesWith(s, "approval_evidence_reachable");

    const linked = scenario(join(root, "hard"));
    linkSync(linked.config.approvalEvidenceKeyFile!, join(root, "hard", "workspace-copy.key"));
    await refusesWith(linked, "approval_evidence_reachable");
  });
});

describe("#426 — the record the host driver writes is the one APPROVE accepts", () => {
  test("run-review-jobs.mjs records the planned commands, and the gate accepts the record", async () => {
    const GIT_ENV = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (cwd: string, ...args: string[]) => spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8", env: GIT_ENV });
    const src = join(root, "src");
    mkdirSync(join(src, ".github", "workflows"), { recursive: true });
    writeFileSync(join(src, "package.json"), JSON.stringify({ name: "fixture", private: true, packageManager: "bun@1.3.10", engines: { node: "22.x" } }));
    const steps = `    steps:\n      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n      - uses: oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76\n        with:\n          bun-version: "1.3.10"\n`;
    writeFileSync(
      join(src, CI_WORKFLOW),
      `on:\n  pull_request:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n${steps}      - run: bun run build\n  ${CI_JOB}:\n    runs-on: ubuntu-latest\n    needs: build\n${steps}      - run: bun run test\n`,
    );
    git(src, "init", "-q", "-b", "main");
    git(src, "add", "-A");
    git(src, "-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "-q", "-m", "fixture");
    const source = join(root, "source.git");
    expect(spawnSync("/usr/bin/git", ["clone", "-q", "--bare", src, source], { encoding: "utf8", env: GIT_ENV }).status).toBe(0);
    const sha = git(source, "rev-parse", "HEAD").stdout.trim();

    const host = join(root, "host");
    const s = scenario(host, { sandboxMountRoots: [join(root, "jobs")] });
    setEvidence(s, []);
    // The fake launcher reports other commands than the plan's; the record holds the plan's.
    const docker = (args: string[]) => {
      if (args[0] === "create") return { status: 0, stdout: `cid-${args[args.indexOf("--label") + 1]}\n`, stderr: "" };
      if (args[0] === "exec") {
        const job = args[1]!.split("=")[1]!;
        return { status: 0, stdout: `${JSON.stringify({ ok: true, status: "job-ok", job, jobs: [{ job, steps: [{ script: "echo build" }, { script: "echo test" }] }] })}\n`, stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const r = (runReviewJobs as (input: Record<string, unknown>) => { ok: boolean })({
      image: "img",
      source,
      scratch: join(root, "jobs"),
      workflow: CI_WORKFLOW,
      job: CI_JOB,
      base: "main",
      docker,
      evidence: { file: s.config.approvalEvidenceFile, keyFile: s.config.approvalEvidenceKeyFile, repo: REPO, pr: PR, dispatchId: DISPATCH, reviewer: REVIEWER, sessionKey: SESSION, commit: sha },
    });
    expect(r.ok).toBe(true);
    const [written] = readApprovalEvidence(s.config.approvalEvidenceFile!);
    expect(written!.commit).toBe(sha);
    expect(written!.jobs).toEqual([
      { job: "build", commands: ["bun run build"], exitCode: 0 },
      { job: CI_JOB, commands: ["bun run test"], exitCode: 0 },
    ]);

    const github = new FakeGitHub();
    github.pull = { ok: true, pull: { state: "open", head: sha } };
    github.reviewResult = { ok: true, receipt: { id: 1, url: `https://example.test/${REPO}/pull/${PR}#r1`, commitId: sha, state: "APPROVED" } };
    const { deps } = makeDeps(s, { github, assignments: resolver([validAssignment({ reviewedCommit: sha })]) });
    const o = await runGithubReview(validInput({ commit_id: sha }), HOST, deps);
    expect(o.ok).toBe(true);
    if (o.ok) expect(o.status).toBe("posted");
    expect(github.reviewCalls.length).toBe(1);
  });
});
