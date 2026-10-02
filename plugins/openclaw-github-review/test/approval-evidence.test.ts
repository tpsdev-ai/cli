/**
 * approval-evidence.test.ts — tpsdev-ai/cli#426: APPROVE requires a
 * host-recorded, host-authenticated passing build/test run for the same
 * repository, PR, dispatch, reviewer, session and commit. Each refusal case
 * asserts that NO review is posted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvalEvidenceDigest,
  buildApprovalEvidence,
  readApprovalEvidence,
  validateApprovalEvidence,
  writeApprovalEvidence,
  type ApprovalEvidenceFields,
  type ApprovalEvidenceRecord,
} from "../src/approval-evidence.js";
import { classifyCommandRole, recordApprovalEvidence, type JobObservation, type ReviewJob } from "../src/approval-driver.js";
import { runGithubReview } from "../src/handler.js";
import type { Outcome } from "../src/types.js";
import { COMMIT, makeDeps, PR, REPO, REVIEWER, scenario, session, validInput, type Scenario } from "./helpers.js";

const SESSION = "sess-1";
const DISPATCH = "dispatch-1";
const OTHER = "b".repeat(40);
const HOST = session();

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gr-evidence-"));
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
      startedAt: "2026-10-02T00:00:00.000Z",
      finishedAt: "2026-10-02T00:10:00.000Z",
      commands: [
        { command: "bun run build", role: "build", exitCode: 0 },
        { command: "bun run test", role: "test", exitCode: 0 },
      ],
      ...over,
    },
    key,
  );
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

describe("the evidence record", () => {
  test("build → write → read round-trips; digest and MAC cover the bound fields", () => {
    const file = join(root, "ev.json");
    const s = scenario(join(root, "s"));
    const r = record(s);
    writeApprovalEvidence(file, r);
    expect(readApprovalEvidence(file)).toEqual([r]);
    expect(r.digest).toHaveLength(64);
    expect(r.mac).toHaveLength(64);
    expect(record(s, { commands: [{ command: "bun run test", role: "test", exitCode: 0 }] }).digest).not.toBe(r.digest);
  });

  test("a missing file is empty; a malformed file is not read as empty", () => {
    expect(readApprovalEvidence(join(root, "absent.json"))).toEqual([]);
    const file = join(root, "bad.json");
    writeFileSync(file, "not json");
    expect(() => readApprovalEvidence(file)).toThrow();
  });

  test("a digest mismatch is invalid; a forged MAC is unauthenticated", () => {
    const s = scenario(join(root, "s"));
    const stale = validateApprovalEvidence({ ...record(s), commit: OTHER }, BINDING, s.approvalKey);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("approval_evidence_invalid");

    const forged = validateApprovalEvidence(record(s, {}, Buffer.from("forger-key-0000000000000000")), BINDING, s.approvalKey);
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.reason).toBe("approval_evidence_unauthenticated");
  });
});

describe("#426 — APPROVE requires host-recorded passing build/test evidence", () => {
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

  test("incomplete evidence refuses and posts nothing", async () => {
    const s = scenario(join(root, "i"));
    setEvidence(s, [record(s, { commands: [] })]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_incomplete");
    expect(posts).toBe(0);
  });

  test("a command with no exit status is incomplete", async () => {
    const s = scenario(join(root, "x"));
    setEvidence(s, [record(s, { commands: [{ command: "bun run test", role: "test" } as never] })]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_incomplete");
    expect(posts).toBe(0);
  });

  test("no build command refuses and posts nothing", async () => {
    const s = scenario(join(root, "b"));
    setEvidence(s, [record(s, { commands: [{ command: "bun run test", role: "test", exitCode: 0 }] })]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_incomplete");
    expect(posts).toBe(0);
  });

  test("a true-only command list refuses and posts nothing", async () => {
    const s = scenario(join(root, "t"));
    setEvidence(s, [record(s, { commands: [{ command: "true", role: "other", exitCode: 0 }] })]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_incomplete");
    expect(posts).toBe(0);
  });

  test("a malformed finish time refuses and posts nothing", async () => {
    const s = scenario(join(root, "f"));
    setEvidence(s, [record(s, { finishedAt: "not-a-finish-time" })]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_incomplete");
    expect(posts).toBe(0);
  });

  test("failed evidence refuses and posts nothing", async () => {
    const s = scenario(join(root, "fail"));
    setEvidence(s, [record(s, { commands: [{ command: "bun run test", role: "test", exitCode: 1 }] })]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_failed");
    expect(o.state).toContain("bun run test");
    expect(posts).toBe(0);
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
      const { o, posts } = await approve(s);
      refused(o);
      expect(o.reason).toBe("approval_evidence_mismatch");
      expect(posts).toBe(0);
    }
  });

  test("a record edited after it was written refuses on its digest", async () => {
    const s = scenario(join(root, "d"));
    setEvidence(s, [{ ...record(s), commit: OTHER }]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_invalid");
    expect(posts).toBe(0);
  });

  test("a record forged without the host key refuses and posts nothing", async () => {
    const s = scenario(join(root, "forged"));
    setEvidence(s, [record(s, {}, Buffer.from("forger-key-0000000000000000"))]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_unauthenticated");
    expect(posts).toBe(0);
  });

  test("an edited record with a recomputed digest refuses and posts nothing", async () => {
    const s = scenario(join(root, "edit"));
    const good = record(s);
    const { digest: _d, mac: _m, ...fields } = good;
    const editedFields: ApprovalEvidenceFields = {
      ...fields,
      commands: fields.commands.map((c) => (c.role === "test" ? { ...c, exitCode: 1 } : c)),
    };
    setEvidence(s, [{ ...editedFields, digest: approvalEvidenceDigest(editedFields), mac: good.mac }]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_unauthenticated");
    expect(posts).toBe(0);
  });

  test("an unconfigured evidence file or key refuses and posts nothing", async () => {
    for (const over of [{ approvalEvidenceFile: null }, { approvalEvidenceKeyFile: null }]) {
      const s = scenario(join(root, `u${String(over.approvalEvidenceFile)}${String(over.approvalEvidenceKeyFile)}`), over);
      const { o, posts } = await approve(s);
      refused(o);
      expect(o.reason).toBe("approval_evidence_unconfigured");
      expect(posts).toBe(0);
    }
  });

  test("two matching records refuse (ambiguous), and nothing is posted", async () => {
    const s = scenario(join(root, "amb"));
    setEvidence(s, [record(s), record(s, { finishedAt: "2026-10-02T00:11:00.000Z" })]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_invalid");
    expect(posts).toBe(0);
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

describe("the host-side driver (approval-driver.ts)", () => {
  const job: ReviewJob = {
    repo: REPO,
    pr: PR,
    dispatchId: DISPATCH,
    reviewer: REVIEWER,
    sessionKey: SESSION,
    commit: COMMIT,
    workflow: ".github/workflows/test.yml",
    jobId: "test",
    base: "main",
  };
  const stub = (over: Partial<JobObservation> = {}): JobObservation => ({
    commit: COMMIT,
    startedAt: "2026-10-02T00:00:00.000Z",
    finishedAt: "2026-10-02T00:09:00.000Z",
    commands: [
      { command: "bun install --frozen-lockfile", exitCode: 0 },
      { command: "bun run build", exitCode: 0 },
      { command: "bun run test", exitCode: 0 },
    ],
    ...over,
  });

  test("production path: the driver runs a stubbed job and the record it writes is accepted", async () => {
    const s = scenario(join(root, "driver"));
    const result = recordApprovalEvidence({
      job,
      evidenceFile: s.config.approvalEvidenceFile!,
      keyFile: s.config.approvalEvidenceKeyFile!,
      runJob: () => stub(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the driver to write a record");
    expect(result.record.dispatchId).toBe(DISPATCH);
    expect(readApprovalEvidence(s.config.approvalEvidenceFile!)).toEqual([result.record]);

    const { deps, github } = makeDeps(s);
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok).toBe(true);
    if (o.ok) expect(o.status).toBe("posted");
    expect(github.reviewCalls.length).toBe(1);
  });

  test("the driver tags each command's stage", () => {
    expect(classifyCommandRole("bun run build")).toBe("build");
    expect(classifyCommandRole("bun run test")).toBe("test");
    expect(classifyCommandRole("bun run test:ci")).toBe("test");
    expect(classifyCommandRole("bun install --frozen-lockfile")).toBe("other");
  });

  test("the driver refuses a store or key inside the review worktree, or a relative path", () => {
    const s = scenario(join(root, "wt"));
    const inside = recordApprovalEvidence({
      job,
      evidenceFile: join(root, "wt", "approval-evidence.json"),
      keyFile: s.config.approvalEvidenceKeyFile!,
      worktreeDir: join(root, "wt"),
      runJob: () => stub(),
    });
    expect(inside.ok).toBe(false);
    if (!inside.ok) expect(inside.refusal.kind).toBe("store-in-worktree");

    const relative = recordApprovalEvidence({
      job,
      evidenceFile: "approval-evidence.json",
      keyFile: s.config.approvalEvidenceKeyFile!,
      runJob: () => stub(),
    });
    expect(relative.ok).toBe(false);
    if (!relative.ok) expect(relative.refusal.kind).toBe("bad-input");
  });

  test("the driver writes nothing when the job ran another commit, failed, or lacks a stage", () => {
    const s = scenario(join(root, "bad"));
    const file = s.config.approvalEvidenceFile!;
    const before = readApprovalEvidence(file);
    const commitMismatch = recordApprovalEvidence({
      job,
      evidenceFile: file,
      keyFile: s.config.approvalEvidenceKeyFile!,
      runJob: () => stub({ commit: OTHER }),
    });
    expect(commitMismatch.ok).toBe(false);
    if (!commitMismatch.ok) expect(commitMismatch.refusal.kind).toBe("commit-mismatch");

    const failed = recordApprovalEvidence({
      job,
      evidenceFile: file,
      keyFile: s.config.approvalEvidenceKeyFile!,
      runJob: () => stub({ commands: [{ command: "bun run test", exitCode: 1 }] }),
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.refusal.kind).toBe("job-failed");

    const noStage = recordApprovalEvidence({
      job,
      evidenceFile: file,
      keyFile: s.config.approvalEvidenceKeyFile!,
      runJob: () => stub({ commands: [{ command: "bun run lint", exitCode: 0 }] }),
    });
    expect(noStage.ok).toBe(false);
    if (!noStage.ok) expect(noStage.refusal.kind).toBe("no-stages");
    expect(readApprovalEvidence(file)).toEqual(before);
  });
});
