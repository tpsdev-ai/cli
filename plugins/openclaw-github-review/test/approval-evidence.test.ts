/**
 * approval-evidence.test.ts — tpsdev-ai/cli#426: APPROVE requires a
 * host-recorded passing build/test run for the same reviewer, session and
 * commit. Each refusal case asserts that NO review is posted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildApprovalEvidence,
  readApprovalEvidence,
  validateApprovalEvidence,
  writeApprovalEvidence,
  type ApprovalEvidenceRecord,
} from "../src/approval-evidence.js";
import { runGithubReview } from "../src/handler.js";
import type { Outcome } from "../src/types.js";
import { COMMIT, makeDeps, PR, REPO, REVIEWER, scenario, session, validInput, type Scenario } from "./helpers.js";

const SESSION = "sess-1";
const OTHER = "b".repeat(40);
const HOST = session();

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gr-evidence-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function record(over: Partial<Parameters<typeof buildApprovalEvidence>[0]> = {}): ApprovalEvidenceRecord {
  return buildApprovalEvidence({
    reviewer: REVIEWER,
    sessionKey: SESSION,
    commit: COMMIT,
    recordedAt: "2026-10-02T00:00:00.000Z",
    commands: [
      { command: "bun run build", exitCode: 0 },
      { command: "bun run test", exitCode: 0 },
    ],
    ...over,
  });
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
  test("build → write → read round-trips; the digest covers the bound fields", () => {
    const file = join(root, "ev.json");
    const r = record();
    writeApprovalEvidence(file, r);
    expect(readApprovalEvidence(file)).toEqual([r]);
    expect(r.digest).toHaveLength(64);
    expect(record({ commands: [{ command: "bun run test", exitCode: 0 }] }).digest).not.toBe(r.digest);
  });

  test("a missing file is empty; a malformed file is not read as empty", () => {
    expect(readApprovalEvidence(join(root, "absent.json"))).toEqual([]);
    const file = join(root, "bad.json");
    writeFileSync(file, "not json");
    expect(() => readApprovalEvidence(file)).toThrow();
  });

  test("an edited record no longer matches its digest", () => {
    const v = validateApprovalEvidence({ ...record(), commit: OTHER }, { reviewer: REVIEWER, sessionKey: SESSION, commit: OTHER });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("approval_evidence_invalid");
  });
});

describe("#426 — APPROVE requires host-recorded passing build/test evidence", () => {
  test("missing evidence refuses and posts nothing", async () => {
    const s = scenario(root);
    setEvidence(s, []);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_missing");
    expect(o.state.length).toBeGreaterThan(0);
    expect(o.remedy.length).toBeGreaterThan(0);
    expect(posts).toBe(0);
  });

  test("incomplete evidence refuses and posts nothing", async () => {
    const s = scenario(root);
    setEvidence(s, [record({ commands: [] })]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_incomplete");
    expect(posts).toBe(0);
  });

  test("a command with no exit status is incomplete", async () => {
    const s = scenario(root);
    setEvidence(s, [record({ commands: [{ command: "bun run test" } as never] })]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_incomplete");
    expect(posts).toBe(0);
  });

  test("failed evidence refuses and posts nothing", async () => {
    const s = scenario(root);
    setEvidence(s, [record({ commands: [{ command: "bun run test", exitCode: 1 }] })]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_failed");
    expect(o.state).toContain("bun run test");
    expect(posts).toBe(0);
  });

  test("evidence for a different reviewer refuses and posts nothing", async () => {
    const s = scenario(root);
    setEvidence(s, [record({ reviewer: "someone-else" })]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_mismatch");
    expect(posts).toBe(0);
  });

  test("evidence for a different session refuses and posts nothing", async () => {
    const s = scenario(root);
    setEvidence(s, [record({ sessionKey: "sess-other" })]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_mismatch");
    expect(posts).toBe(0);
  });

  test("evidence for a different commit refuses and posts nothing", async () => {
    const s = scenario(root);
    setEvidence(s, [record({ commit: OTHER })]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_mismatch");
    expect(posts).toBe(0);
  });

  test("a record edited after it was written refuses on its digest", async () => {
    const s = scenario(root);
    setEvidence(s, [{ ...record(), commit: OTHER }]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_invalid");
    expect(posts).toBe(0);
  });

  test("an unconfigured evidence file refuses and posts nothing", async () => {
    const s = scenario(root, { approvalEvidenceFile: null });
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_unconfigured");
    expect(posts).toBe(0);
  });

  test("two matching records refuse (ambiguous), and nothing is posted", async () => {
    const s = scenario(root);
    setEvidence(s, [record(), record({ recordedAt: "2026-10-02T01:00:00.000Z" })]);
    const { o, posts } = await approve(s);
    refused(o);
    expect(o.reason).toBe("approval_evidence_invalid");
    expect(posts).toBe(0);
  });

  test("passing evidence posts APPROVE and records the digest in the audit record", async () => {
    const s = scenario(root);
    const r = record();
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
