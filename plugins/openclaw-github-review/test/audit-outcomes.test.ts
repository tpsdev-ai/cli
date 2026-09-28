/**
 * audit-outcomes.test.ts — A12 (audit fidelity), A13 (partial outcomes and
 * recovery) and A14 (attribution), plus the durable-store and one-verdict
 * semantics: ambiguous/2xx-invalid outcomes are UNKNOWN with a durable
 * per-dispatch latch; a dispatch whose review exists refuses every later call
 * (`already_posted`) and a concurrent call is refused while one is in flight;
 * the durable stores fail closed (never read as empty, never overwritten when
 * unparsable, proved usable before any request); and a post is never followed
 * by a throw.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePendingAuditStore, FileReconcileStore, retryPendingAudits } from "../src/audit.js";
import { outcomeToJson, runGithubReview } from "../src/handler.js";
import { createGithubReviewTool } from "../src/index.js";
import type { Outcome, ReconcileStore, RefusalReason } from "../src/types.js";
import {
  COMMIT,
  FailingAddReconcileStore,
  FailingSavePendingStore,
  GatedGitHub,
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

function refusedWith(o: Outcome, reason: RefusalReason): void {
  expect(o.ok).toBe(false);
  if (!o.ok) expect(o.reason).toBe(reason);
}

describe("A13 — partial outcomes and recovery", () => {
  test("a GitHub refusal creates no successful-post event", async () => {
    const { deps, github, audit } = makeDeps(scenario(root));
    github.reviewResult = { ok: false, kind: "rejected", detail: "posting returned status 422" };
    const o = await runGithubReview(validInput(), HOST, deps);
    refusedWith(o, "github_rejected");
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
    refusedWith(second, "reconcile_required");
    expect(github.reviewCalls.length).toBe(1);
  });

  test("a retry after a receipt_invalid outcome is refused reconcile_required, with exactly 1 POST", async () => {
    const { deps, github } = makeDeps(scenario(root));
    github.reviewResult = { ok: true, receipt: { id: 9, url: "https://example.test/r/9", commitId: COMMIT, state: "COMMENTED" } };
    const first = await runGithubReview(validInput({ event: "APPROVE" }), HOST, deps);
    expect(first.ok && first.status === "unknown" && first.reason === "receipt_invalid").toBe(true);
    const retry = await runGithubReview(validInput({ event: "APPROVE" }), HOST, deps);
    refusedWith(retry, "reconcile_required");
    expect(github.reviewCalls.length).toBe(1);
  });

  test("the dispatch latch is durable, and posting resumes only once the HOST clears it", async () => {
    const s = scenario(root);
    const { deps, github } = makeDeps(s);
    github.reviewResult = { ok: false, kind: "ambiguous", detail: "posting returned status 502" };
    await runGithubReview(validInput(), HOST, deps);
    expect(github.reviewCalls.length).toBe(1);
    // A "restart" reads the same durable latch.
    const restarted = makeDeps(s);
    refusedWith(await runGithubReview(validInput(), HOST, restarted.deps), "reconcile_required");
    expect(restarted.github.reviewCalls.length).toBe(0);
    // The host reconciles and clears the latch; the next call posts.
    expect(new FileReconcileStore(s.config.reconcileFile!).clear("dispatch-1")).toBe(true);
    const after = await runGithubReview(validInput(), HOST, restarted.deps);
    expect(after.ok && after.status === "posted").toBe(true);
    expect(restarted.github.reviewCalls.length).toBe(1);
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

  test("an audit failure whose RETENTION also fails is posted_audit_unretained: no throw, one path-free host log line", async () => {
    const { deps, github, audit, logs } = makeDeps(scenario(root), { pendingAudits: new FailingSavePendingStore() });
    audit.fail = true;
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok).toBe(true);
    if (o.ok) expect(o.status).toBe("posted_audit_unretained");
    expect(github.reviewCalls.length).toBe(1);
    expect(outcomeToJson(o)).not.toContain("/host/secret");
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("could not be retained");
    if (o.ok && o.status !== "unknown") expect(logs[0]).toContain(o.auditEventId);
    expect(logs[0]).not.toContain("/host/secret");
  });

  test("an unset pendingAuditFile refuses BEFORE any request", async () => {
    const { deps, github } = makeDeps(scenario(root, { pendingAuditFile: null }));
    refusedWith(await runGithubReview(validInput(), HOST, deps), "store_unconfigured");
    expect(github.fetchPullCalls.length + github.reviewCalls.length).toBe(0);
  });

  test("an unset reconcileFile refuses BEFORE any request", async () => {
    const { deps, github } = makeDeps(scenario(root, { reconcileFile: null }));
    refusedWith(await runGithubReview(validInput(), HOST, deps), "store_unconfigured");
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

describe("B2 — the durable stores fail closed", () => {
  const PATH_FREE = (o: Outcome) => expect(outcomeToJson(o)).not.toContain(root);

  test("an unparsable latch store refuses store_unavailable BEFORE any request and is left untouched", async () => {
    const s = scenario(root);
    writeFileSync(s.config.reconcileFile!, "{not json", { mode: 0o600 });
    const { deps, github } = makeDeps(s);
    const o = await runGithubReview(validInput(), HOST, deps);
    refusedWith(o, "store_unavailable");
    PATH_FREE(o);
    expect(github.fetchPullCalls.length + github.reviewCalls.length).toBe(0);
    expect(readFileSync(s.config.reconcileFile!, "utf8")).toBe("{not json");
  });

  test("a latch store with an unrecognised shape refuses store_unavailable", async () => {
    const s = scenario(root);
    writeFileSync(s.config.reconcileFile!, JSON.stringify({ dispatchIds: ["dispatch-1"] }), { mode: 0o600 });
    const { deps, github } = makeDeps(s);
    refusedWith(await runGithubReview(validInput(), HOST, deps), "store_unavailable");
    expect(github.fetchPullCalls.length + github.reviewCalls.length).toBe(0);
  });

  test("an unparsable pending-audit store refuses store_unavailable BEFORE any request and is left untouched", async () => {
    const s = scenario(root);
    writeFileSync(s.config.pendingAuditFile!, "[[", { mode: 0o600 });
    const { deps, github } = makeDeps(s);
    const o = await runGithubReview(validInput(), HOST, deps);
    refusedWith(o, "store_unavailable");
    PATH_FREE(o);
    expect(github.fetchPullCalls.length + github.reviewCalls.length).toBe(0);
    expect(readFileSync(s.config.pendingAuditFile!, "utf8")).toBe("[[");
  });

  for (const which of ["reconcileFile", "pendingAuditFile"] as const) {
    test(`an unwritable ${which} directory refuses store_unavailable BEFORE any request`, async () => {
      const dir = join(root, `ro-${which}`);
      mkdirSync(dir);
      const s = scenario(root, { [which]: join(dir, "store.json") });
      chmodSync(dir, 0o500);
      try {
        const { deps, github } = makeDeps(s);
        const o = await runGithubReview(validInput(), HOST, deps);
        refusedWith(o, "store_unavailable");
        PATH_FREE(o);
        expect(github.fetchPullCalls.length + github.reviewCalls.length).toBe(0);
      } finally {
        chmodSync(dir, 0o700);
      }
    });
  }

  test("a latch store that cannot be READ at the latch check refuses store_unavailable, even if its probe passes", async () => {
    const reconcile: ReconcileStore = {
      get: () => {
        throw new Error("latch store path /host/secret/reconcile.json is unreadable");
      },
      add: () => {},
      clear: () => {},
      probe: () => {},
    };
    const { deps, github } = makeDeps(scenario(root), { reconcile });
    const o = await runGithubReview(validInput(), HOST, deps);
    refusedWith(o, "store_unavailable");
    expect(outcomeToJson(o)).not.toContain("/host/secret");
    expect(github.fetchPullCalls.length + github.reviewCalls.length).toBe(0);
  });

  test("FileReconcileStore reads a MISSING file as empty and throws on every other read failure", () => {
    const missing = new FileReconcileStore(join(root, "absent.json"));
    expect(missing.get("d")).toBeNull();
    const garbled = join(root, "garbled.json");
    writeFileSync(garbled, "{", { mode: 0o600 });
    expect(() => new FileReconcileStore(garbled).get("d")).toThrow();
    const unreadable = join(root, "unreadable.json");
    writeFileSync(unreadable, JSON.stringify({ latches: [] }), { mode: 0o600 });
    chmodSync(unreadable, 0o000);
    try {
      expect(() => new FileReconcileStore(unreadable).get("d")).toThrow();
    } finally {
      chmodSync(unreadable, 0o600);
    }
  });

  test("FileReconcileStore.add never overwrites a file it could not parse", () => {
    const garbled = join(root, "garbled.json");
    writeFileSync(garbled, '{"latches":[{"dispatchId":"other","latch":"posted"}', { mode: 0o600 });
    const store = new FileReconcileStore(garbled);
    expect(() => store.add("dispatch-new", "reconcile_required")).toThrow();
    expect(readFileSync(garbled, "utf8")).toBe('{"latches":[{"dispatchId":"other","latch":"posted"}');
  });

  test("FilePendingAuditStore reads a MISSING file as empty and never overwrites one it could not parse", () => {
    expect(new FilePendingAuditStore(join(root, "absent.json")).list()).toEqual([]);
    const garbled = join(root, "garbled-pending.json");
    writeFileSync(garbled, '{"events":[{"id":1}]}', { mode: 0o600 });
    const store = new FilePendingAuditStore(garbled);
    expect(() => store.list()).toThrow();
    expect(() =>
      store.save({ id: "e", authorId: "a", kind: "pr_review_posted", scope: REPO, refId: "1", targetIds: [], summary: "s", detail: "{}", createdAt: "t" }),
    ).toThrow();
    expect(readFileSync(garbled, "utf8")).toBe('{"events":[{"id":1}]}');
  });

  test("an ambiguous post whose durable latch write fails is still latched (in memory): no throw, 1 POST, one path-free log line", async () => {
    const reconcile = new FailingAddReconcileStore();
    const { deps, github, logs } = makeDeps(scenario(root), { reconcile });
    github.reviewResult = { ok: false, kind: "ambiguous", detail: "posting returned status 502" };
    const first = await runGithubReview(validInput(), HOST, deps);
    expect(first.ok && first.status === "unknown").toBe(true);
    refusedWith(await runGithubReview(validInput(), HOST, deps), "reconcile_required");
    expect(github.reviewCalls.length).toBe(1);
    expect(reconcile.addCalls).toEqual([{ dispatchId: "dispatch-1", latch: "reconcile_required" }]);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("held in memory");
    expect(logs[0]).not.toContain("/host/secret");
  });

  test("a receipt_invalid post whose durable latch write fails is still latched (in memory)", async () => {
    const reconcile = new FailingAddReconcileStore();
    const { deps, github, logs } = makeDeps(scenario(root), { reconcile });
    github.reviewResult = { ok: true, receipt: { id: 9, url: "https://example.test/r/9", commitId: COMMIT, state: "COMMENTED" } };
    const first = await runGithubReview(validInput({ event: "APPROVE" }), HOST, deps);
    expect(first.ok && first.status === "unknown").toBe(true);
    refusedWith(await runGithubReview(validInput({ event: "APPROVE" }), HOST, deps), "reconcile_required");
    expect(github.reviewCalls.length).toBe(1);
    expect(logs.length).toBe(1);
  });

  test("a posted review whose durable latch write fails is still latched (in memory): the next call is already_posted", async () => {
    const reconcile = new FailingAddReconcileStore();
    const { deps, github, logs } = makeDeps(scenario(root), { reconcile });
    const first = await runGithubReview(validInput(), HOST, deps);
    expect(first.ok && first.status === "posted").toBe(true);
    refusedWith(await runGithubReview(validInput(), HOST, deps), "already_posted");
    expect(github.reviewCalls.length).toBe(1);
    expect(logs.length).toBe(1);
  });
});

describe("EXACTLY ONE VERDICT PER DISPATCH", () => {
  const params = validInput();

  test("the tool declares executionMode sequential", () => {
    const { deps } = makeDeps(scenario(root));
    expect(createGithubReviewTool(deps, HOST).executionMode).toBe("sequential");
  });

  test("two PARALLEL calls in one message post exactly once: the second is refused while the first is in flight", async () => {
    const github = new GatedGitHub();
    const { deps } = makeDeps(scenario(root), { github });
    const tool = createGithubReviewTool(deps, HOST);
    const first = tool.execute("call-1", params);
    const second = await tool.execute("call-2", params);
    const secondOut = JSON.parse((second.content[0] as { text: string }).text) as { status: string; reason?: string };
    expect(secondOut).toMatchObject({ status: "refused", reason: "dispatch_in_flight" });
    github.open();
    const firstOut = JSON.parse(((await first).content[0] as { text: string }).text) as { status: string };
    expect(firstOut.status).toBe("posted");
    expect(github.reviewCalls.length).toBe(1);
  });

  test("two SEQUENTIAL calls: the second is refused already_posted, durably across a restart", async () => {
    const s = scenario(root);
    const { deps, github } = makeDeps(s);
    const first = await runGithubReview(validInput(), HOST, deps);
    expect(first.ok && first.status === "posted").toBe(true);
    refusedWith(await runGithubReview(validInput({ event: "COMMENT" }), HOST, deps), "already_posted");
    expect(github.reviewCalls.length).toBe(1);
    const restarted = makeDeps(s);
    refusedWith(await runGithubReview(validInput(), HOST, restarted.deps), "already_posted");
    expect(restarted.github.reviewCalls.length).toBe(0);
    expect(new FileReconcileStore(s.config.reconcileFile!).get("dispatch-1")).toBe("posted");
  });

  test("a posted_audit_pending outcome also latches the dispatch", async () => {
    const { deps, github, audit } = makeDeps(scenario(root));
    audit.fail = true;
    const first = await runGithubReview(validInput(), HOST, deps);
    expect(first.ok && first.status === "posted_audit_pending").toBe(true);
    refusedWith(await runGithubReview(validInput(), HOST, deps), "already_posted");
    expect(github.reviewCalls.length).toBe(1);
  });

  test("a refused post releases the dispatch: a corrected retry posts", async () => {
    const { deps, github } = makeDeps(scenario(root));
    github.reviewResult = { ok: false, kind: "rejected", detail: "posting returned status 422" };
    refusedWith(await runGithubReview(validInput(), HOST, deps), "github_rejected");
    github.reviewResult = {
      ok: true,
      receipt: { id: 2, url: `https://example.test/${REPO}/pull/${PR}#r2`, commitId: COMMIT, state: "APPROVED" },
    };
    const retry = await runGithubReview(validInput(), HOST, deps);
    expect(retry.ok && retry.status === "posted").toBe(true);
    expect(github.reviewCalls.length).toBe(2);
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
