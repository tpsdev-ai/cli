/**
 * audit-outcomes.test.ts — A12 (audit fidelity), A13 (partial outcomes and
 * recovery) and A14 (attribution), plus the round-2 partial-outcome semantics:
 * ambiguous/2xx-invalid outcomes are UNKNOWN with a durable per-dispatch latch,
 * a post is never followed by a throw, and an unconfigured durable store refuses
 * before any request.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePendingAuditStore, MemoryReconcileStore, retryPendingAudits } from "../src/audit.js";
import { outcomeToJson, runGithubReview } from "../src/handler.js";
import { createGithubReviewTool } from "../src/index.js";
import {
  COMMIT,
  FailingSavePendingStore,
  makeDeps,
  PR,
  REPO,
  scenario,
  session,
  validInput,
} from "./helpers.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gr-audit-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const HOST = session();

function sha256s(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

describe("A12 — audit fidelity and authentication", () => {
  test("the OrgEvent mirrors the posting exactly", async () => {
    const { deps, github, audit } = makeDeps(scenario(root));
    // Surrounding whitespace MUST survive: the digest is over the body handed to
    // the serializer, not a trimmed copy of it.
    const body = "  ship it \u2014 trailing stays \n";
    const o = await runGithubReview(validInput({ body }), HOST, deps);
    expect(o.ok).toBe(true);

    expect(audit.events.length).toBe(1);
    const e = audit.events[0]!;
    expect(e.kind).toBe("pr_review_posted");
    expect(e.scope).toBe(REPO);
    expect(e.refId).toBe(String(PR));
    expect(e.targetIds).toEqual([String(PR), COMMIT]);
    expect(e.authorId).toBe("anvil");
    expect(e.summary).not.toContain("\n");
    expect(Number.isFinite(Date.parse(e.createdAt))).toBe(true);

    const d = JSON.parse(e.detail) as Record<string, unknown>;
    expect(d.repo).toBe(REPO);
    expect(d.pr).toBe(PR);
    expect(d.commit_id).toBe(COMMIT);
    expect(d.event).toBe("APPROVE");
    // The digest is over the UTF-8 body handed to the serializer.
    expect(d.body_sha256).toBe(sha256s(github.reviewCalls[0]!.body));
    expect(github.reviewCalls[0]!.body).toBe(body);
    expect(d.body_sha256).toBe(sha256s(body));
    expect(d.body_sha256).not.toBe(sha256s(body.trim()));
    expect(d.review_id).toBe(1);
    expect(d.review_url).toBe("https://example.test/tpsdev-ai/cli/pull/425#r1");
    expect(d.commit_sha).toBe(COMMIT);
    expect(d.reviewer).toBe("anvil");
    expect(d.session_correlation_id).toBe("dispatch-1");
    // The review environment's versions/digest are section A's to supply; until
    // then they are recorded as null, never as the gateway's own values.
    expect(d.bun_version).toBeNull();
    expect(d.node_version).toBeNull();
    expect(d.sandbox_image_digest).toBeNull();
    expect(d.plugin_version).toBe("0.1.0-test");
    expect(d.github_login).toBe("anvil-reviewer");
  });

  test("caller-supplied identities or hashes are never accepted", async () => {
    const { deps, audit } = makeDeps(scenario(root));
    const o = await runGithubReview(
      validInput({ authorId: "flint", body_sha256: "0".repeat(64), reviewer: "someone" }),
      HOST,
      deps,
    );
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.reason).toBe("unsupported_field");
    expect(audit.events.length).toBe(0);
  });
});

describe("A13 — partial outcomes and recovery", () => {
  test("a GitHub refusal creates no successful-post event", async () => {
    const { deps, github, audit } = makeDeps(scenario(root));
    github.reviewResult = { ok: false, kind: "rejected", detail: "posting returned status 422" };
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.reason).toBe("github_rejected");
    expect(audit.events.length).toBe(0);
  });

  test("an ambiguous GitHub outcome is UNKNOWN and latches the dispatch", async () => {
    const { deps, github, audit } = makeDeps(scenario(root));
    github.reviewResult = { ok: false, kind: "ambiguous", detail: "posting returned status 502" };
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok).toBe(true);
    if (o.ok) {
      expect(o.status).toBe("unknown");
      if (o.status === "unknown") expect(o.reason).toBe("reconcile_required");
    }
    expect(audit.events.length).toBe(0);
  });

  test("an immediate retry after an unknown outcome does NOT post a second review", async () => {
    const { deps, github } = makeDeps(scenario(root));
    github.reviewResult = { ok: false, kind: "ambiguous", detail: "posting returned status 502" };
    const first = await runGithubReview(validInput(), HOST, deps);
    expect(first.ok).toBe(true);
    const second = await runGithubReview(validInput(), HOST, deps);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("reconcile_required");
    expect(github.reviewCalls.length).toBe(1);
  });

  test("the dispatch latch is durable and clears only when the host clears it", async () => {
    const reconcileFile = join(root, "reconcile.json");
    const s = scenario(root, { reconcileFile });
    const { deps, github } = makeDeps(s);
    github.reviewResult = { ok: false, kind: "ambiguous", detail: "posting returned status 502" };
    await runGithubReview(validInput(), HOST, deps);
    // A "restart" reads the same durable latch.
    const { deps: deps2, github: github2 } = makeDeps(s);
    const retry = await runGithubReview(validInput(), HOST, deps2);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.reason).toBe("reconcile_required");
    expect(github2.reviewCalls.length).toBe(0);
  });

  test("a 2xx with an invalid receipt is UNKNOWN and the review is RETAINED for the audit", async () => {
    const { deps, github, audit } = makeDeps(scenario(root));
    // A 2xx returns a receipt whose state does not match an APPROVE.
    github.reviewResult = { ok: true, receipt: { id: 9, url: "https://example.test/r/9", commitId: COMMIT, state: "COMMENTED" } };
    const o = await runGithubReview(validInput({ event: "APPROVE" }), HOST, deps);
    expect(o.ok).toBe(true);
    if (o.ok) {
      expect(o.status).toBe("unknown");
      if (o.status === "unknown") {
        expect(o.reason).toBe("receipt_invalid");
        expect(o.reviewId).toBe(9);
      }
    }
    // The external record is retained for the audit even though it did not validate.
    expect(audit.events.length).toBe(1);
  });

  test("an audit failure after a confirmed post is posted_audit_pending, not success", async () => {
    const pendingFile = join(root, "pending.json");
    const { deps, github, audit } = makeDeps(scenario(root, { pendingAuditFile: pendingFile }));
    audit.fail = true;
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok).toBe(true);
    if (o.ok && o.status === "posted_audit_pending") expect(o.reviewId).toBe(1);
    else throw new Error("expected posted_audit_pending");
    expect(github.reviewCalls.length).toBe(1);
    expect(new FilePendingAuditStore(pendingFile).list().length).toBe(1);
  });

  test("a pending-audit SAVE failure after a post never throws and leaks no path", async () => {
    const { deps, github } = makeDeps(scenario(root), { pendingAudits: new FailingSavePendingStore() });
    const audit = deps.audit as { fail: boolean };
    audit.fail = true;
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok).toBe(true);
    if (o.ok) expect(o.status).toBe("posted_audit_pending");
    expect(github.reviewCalls.length).toBe(1);
    expect(outcomeToJson(o)).not.toContain("/host/secret");
  });

  test("an unconfigured durable store refuses BEFORE any request", async () => {
    const { deps, github } = makeDeps(scenario(root, { pendingAuditFile: null }));
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.reason).toBe("pending_audit_unconfigured");
    expect(github.fetchPullCalls.length + github.reviewCalls.length).toBe(0);
  });

  test("a retained audit survives restart and retries WITHOUT reposting", async () => {
    const pendingFile = join(root, "pending.json");
    const first = makeDeps(scenario(root, { pendingAuditFile: pendingFile }));
    first.audit.fail = true;
    await runGithubReview(validInput(), HOST, first.deps);
    expect(first.github.reviewCalls.length).toBe(1);

    const store = new FilePendingAuditStore(pendingFile);
    const healthy = makeDeps(scenario(root, { pendingAuditFile: pendingFile }));
    const result = await retryPendingAudits(store, healthy.audit);
    expect(result.acknowledged.length).toBe(1);
    expect(healthy.audit.events.length).toBe(1);
    expect(new FilePendingAuditStore(pendingFile).list().length).toBe(0);
    expect(healthy.github.reviewCalls.length).toBe(0);
  });
});

describe("A14 — APPROVE attribution; slice-2 evidence out of scope", () => {
  test("attribution is host-derived: actor, session correlation and commit", async () => {
    const { deps, audit } = makeDeps(scenario(root));
    const o = await runGithubReview(validInput({ event: "APPROVE" }), HOST, deps);
    expect(o.ok).toBe(true);
    const e = audit.events[0]!;
    const d = JSON.parse(e.detail) as Record<string, unknown>;
    expect(e.authorId).toBe("anvil");
    expect(d.session_correlation_id).toBe("dispatch-1");
    expect(e.targetIds).toContain(COMMIT);
  });

  test("the tool exposes no evidence-binding or caller-identity field", () => {
    const { deps } = makeDeps(scenario(root));
    const tool = createGithubReviewTool(deps, HOST);
    const params = tool.parameters as unknown as {
      properties: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(Object.keys(params.properties).sort()).toEqual(["body", "commit_id", "event", "pr", "repo"]);
    expect(params.additionalProperties).toBe(false);
  });
});
