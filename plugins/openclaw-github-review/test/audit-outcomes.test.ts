/**
 * audit-outcomes.test.ts — A12 (audit fidelity), A13 (partial outcomes and
 * recovery) and A14 (attribution).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePendingAuditStore, retryPendingAudits } from "../src/audit.js";
import { runGithubReview } from "../src/handler.js";
import { createGithubReviewTool } from "../src/index.js";
import { COMMIT, makeDeps, PR, REPO, scenario, validInput } from "./helpers.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gr-audit-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const HOST = { sessionKey: "sess-1", sandboxed: false };

function sha256s(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

describe("A12 — audit fidelity and authentication", () => {
  test("the OrgEvent mirrors the posting exactly", async () => {
    const { deps, github, audit } = makeDeps(scenario(root));
    const body = "ship it \u2014 with the audit digest pinned";
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
    // The digest is over the EXACT bytes sent to GitHub.
    expect(d.body_sha256).toBe(sha256s(github.reviewCalls[0]!.body));
    expect(d.review_id).toBe(1);
    expect(d.review_url).toBe("https://example.test/tpsdev-ai/cli/pull/425#r1");
    expect(d.commit_sha).toBe(COMMIT);
    expect(d.reviewer).toBe("anvil");
    expect(d.session_correlation_id).toBe("dispatch-1");
    expect(typeof d.bun_version === "string" || d.bun_version === null).toBe(true);
    expect(typeof d.node_version).toBe("string");
    expect(d.sandbox_image_digest).toBe("sha256:deadbeef");
    expect(d.plugin_version).toBe("0.1.0-test");
    // Login comes from the provisioning evidence, not an online call.
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

  test("an ambiguous GitHub outcome is reported as unknown, not success", async () => {
    const { deps, github, audit } = makeDeps(scenario(root));
    github.reviewResult = { ok: false, kind: "ambiguous", detail: "posting returned status 502" };
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.reason).toBe("github_ambiguous");
    expect(audit.events.length).toBe(0);
  });

  test("an audit failure after a confirmed post is posted_audit_pending, not success", async () => {
    const pendingFile = join(root, "pending.json");
    const { deps, github, audit } = makeDeps(scenario(root, { pendingAuditFile: pendingFile }));
    audit.fail = true;
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok).toBe(true);
    if (o.ok) {
      expect(o.status).toBe("posted_audit_pending");
      expect(o.reviewId).toBe(1);
    }
    expect(github.reviewCalls.length).toBe(1);
    // The audit work is retained host-side.
    const store = new FilePendingAuditStore(pendingFile);
    expect(store.list().length).toBe(1);
  });

  test("a retained audit survives restart and retries WITHOUT reposting", async () => {
    const pendingFile = join(root, "pending.json");
    const first = makeDeps(scenario(root, { pendingAuditFile: pendingFile }));
    first.audit.fail = true;
    await runGithubReview(validInput(), HOST, first.deps);
    expect(first.github.reviewCalls.length).toBe(1);

    // "Restart": a brand-new store and a fresh, healthy sink.
    const store = new FilePendingAuditStore(pendingFile);
    const healthy = makeDeps(scenario(root, { pendingAuditFile: pendingFile }));
    const result = await retryPendingAudits(store, healthy.audit);
    expect(result.acknowledged.length).toBe(1);
    expect(healthy.audit.events.length).toBe(1);
    expect(new FilePendingAuditStore(pendingFile).list().length).toBe(0);
    // Recovery never posts a GitHub review.
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
    expect(e.authorId).toBe("anvil"); // reviewer from the trusted session
    expect(d.session_correlation_id).toBe("dispatch-1"); // host dispatch id
    expect(e.targetIds).toContain(COMMIT); // host-resolved head
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
