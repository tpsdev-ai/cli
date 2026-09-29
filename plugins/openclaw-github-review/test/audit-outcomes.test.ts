/**
 * audit-outcomes.test.ts — A12 (audit fidelity), A13 (partial outcomes and
 * recovery) and A14 (attribution), plus the durable-store and one-verdict
 * semantics: the dispatch is durably RESERVED before the POST (no reservation,
 * no POST); ambiguous/2xx-invalid outcomes are UNKNOWN; a reservation left by a
 * crash or a failed outcome write refuses `reconcile_required` until the host
 * reconciles; a dispatch whose review exists refuses every later call
 * (`already_posted`) and a concurrent call is refused while one is in flight;
 * the durable stores fail closed; and nothing after a POST throws.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FilePendingAuditStore, FileReconcileStore, retryPendingAudits } from "../src/audit.js";
import { outcomeToJson, runGithubReview } from "../src/handler.js";
import { createGithubReviewTool } from "../src/index.js";
import { DispatchLedger } from "../src/dispatch-ledger.js";
import { HttpGitHubApi } from "../src/github.js";
import { runLatchAdmin } from "../src/latch-admin.js";
import type { ExistingReview, Outcome, ReconcileStore, RefusalReason } from "../src/types.js";
import {
  COMMIT,
  FailingSavePendingStore,
  FakeGitHub,
  FakeReviewLister,
  fakeFlairFetch,
  FlakyReconcileStore,
  GatedGitHub,
  makeDeps,
  pluginConfigOf,
  PR,
  REPO,
  scenario,
  session,
  TOKEN,
  validInput,
  type Scenario,
} from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
/** A test that runs real child processes: allow for a loaded host. */
const PROCESS_TEST_TIMEOUT_MS = 60_000;

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

  test("an ambiguous GitHub outcome is UNKNOWN and latches the dispatch reconcile_required", async () => {
    const s = scenario(root);
    const { deps, github, audit } = makeDeps(s);
    github.reviewResult = { ok: false, kind: "ambiguous", detail: "posting returned status 502" };
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok).toBe(true);
    if (o.ok) {
      expect(o.status).toBe("unknown");
      if (o.status === "unknown") expect(o.reason).toBe("reconcile_required");
    }
    expect(audit.events.length).toBe(0);
    expect(new FileReconcileStore(s.config.reconcileFile!).get("dispatch-1")).toBe("reconcile_required");
  });

  test("an immediate retry after an unknown outcome does NOT post a second review", async () => {
    const { deps, github } = makeDeps(scenario(root));
    github.reviewResult = { ok: false, kind: "ambiguous", detail: "posting returned status 502" };
    const first = await runGithubReview(validInput(), HOST, deps);
    expect(first.ok).toBe(true);
    const second = await runGithubReview(validInput(), HOST, deps);
    refusedWith(second, "reconcile_required");
    expect(github.reviewCalls.length).toBe(1);
    // The latch refuses BEFORE any request: the retry did not even look the PR up.
    expect(github.fetchPullCalls.length).toBe(1);
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

  test("a receipt_invalid outcome records reconcile_required WITH the receipt's review id (what reconciliation matches on)", async () => {
    const s = scenario(root);
    const { deps, github } = makeDeps(s);
    github.reviewResult = { ok: true, receipt: { id: 9, url: "https://example.test/r/9", commitId: "c".repeat(40), state: "APPROVED" } };
    await runGithubReview(validInput(), HOST, deps);
    expect(new FileReconcileStore(s.config.reconcileFile!).entry("dispatch-1")).toMatchObject({ latch: "reconcile_required", reviewId: 9 });
  });

  test("the dispatch latch is durable, and posting resumes only once the HOST's reconciliation finds no review", async () => {
    const s = scenario(root);
    const { deps, github } = makeDeps(s);
    github.reviewResult = { ok: false, kind: "ambiguous", detail: "posting returned status 502" };
    await runGithubReview(validInput(), HOST, deps);
    expect(github.reviewCalls.length).toBe(1);
    // A "restart" reads the same durable latch.
    const restarted = makeDeps(s);
    refusedWith(await runGithubReview(validInput(), HOST, restarted.deps), "reconcile_required");
    expect(restarted.github.reviewCalls.length).toBe(0);
    // The host reconciles: GitHub shows no review for the dispatch, so it is released.
    expect(await hostReconcile(s, [])).toBe(0);
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
      entry: () => {
        throw new Error("latch store path /host/secret/reconcile.json is unreadable");
      },
      reserve: () => null,
      settle: () => {},
      release: () => {},
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

  test("FileReconcileStore.replaceIf removes ONLY the named dispatch, and only if it is unchanged", () => {
    const store = new FileReconcileStore(join(root, "latches.json"));
    store.put({ dispatchId: "a", latch: "reserved" });
    store.put({ dispatchId: "b", latch: "posted" });
    expect(store.replaceIf("a", { dispatchId: "a", latch: "reconcile_required" }, null)).toBe(false);
    expect(store.replaceIf("a", { dispatchId: "a", latch: "reserved" }, null)).toBe(true);
    expect(store.list().map((e) => [e.dispatchId, e.latch])).toEqual([["b", "posted"]]);
  });

  test("FileReconcileStore: settle and release act ONLY for the claim that holds the dispatch", () => {
    const store = new FileReconcileStore(join(root, "claims.json"));
    const details = { repo: REPO, pr: PR, commit: COMMIT, login: "l", credentialSha256: "f", reservedAt: "now" };
    expect(store.reserve("d", details, { token: "mine", pid: 1, host: "h", at: "now" })).toBeNull();
    // A second claim of the same dispatch gets the existing entry and writes nothing.
    expect(store.reserve("d", details, { token: "other", pid: 2, host: "h", at: "now" })).toMatchObject({ claim: { token: "mine" } });
    const before = readFileSync(join(root, "claims.json"), "utf8");
    expect(() => store.settle("d", "other", "posted")).toThrow();
    expect(() => store.release("d", "other")).toThrow();
    expect(readFileSync(join(root, "claims.json"), "utf8")).toBe(before);
    store.settle("d", "mine", "reconcile_required", { reviewId: 3 });
    expect(store.entry("d")).toMatchObject({ latch: "reconcile_required", reviewId: 3 });
    expect(store.entry("d")!.claim).toBeUndefined();
    // Settled: the reservation is no longer the claim's to release.
    expect(() => store.release("d", "mine")).toThrow();
    expect(store.get("d")).toBe("reconcile_required");
  });

  test("FileReconcileStore writes never overwrite a file they could not parse", () => {
    const garbled = join(root, "garbled.json");
    writeFileSync(garbled, '{"latches":[{"dispatchId":"other","latch":"posted"}', { mode: 0o600 });
    const store = new FileReconcileStore(garbled);
    const claim = { token: "t", pid: 1, host: "h", at: "now" };
    const details = { repo: REPO, pr: PR, commit: COMMIT, login: "l", credentialSha256: "f", reservedAt: "now" };
    expect(() => store.reserve("dispatch-new", details, claim)).toThrow();
    expect(() => store.put({ dispatchId: "dispatch-new", latch: "posted" })).toThrow();
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

  test("an ambiguous post whose outcome write fails stays RESERVED with its claim: no throw, 1 POST, then refused, one path-free log attempt", async () => {
    const reconcile = new FlakyReconcileStore(["reconcile_required"]);
    const { deps, github, logs } = makeDeps(scenario(root), { reconcile });
    github.reviewResult = { ok: false, kind: "ambiguous", detail: "posting returned status 502" };
    const first = await runGithubReview(validInput(), HOST, deps);
    expect(first.ok && first.status === "unknown").toBe(true);
    expect(reconcile.entry("dispatch-1")).toMatchObject({ latch: "reserved", claim: expect.any(Object) });
    refusedWith(await runGithubReview(validInput(), HOST, deps), "dispatch_in_flight");
    expect(github.reviewCalls.length).toBe(1);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("stays reserved");
    expect(logs[0]).not.toContain("/host/secret");
  });

  test("a receipt_invalid post whose outcome write fails stays RESERVED with its claim", async () => {
    const reconcile = new FlakyReconcileStore(["reconcile_required"]);
    const { deps, github, logs } = makeDeps(scenario(root), { reconcile });
    github.reviewResult = { ok: true, receipt: { id: 9, url: "https://example.test/r/9", commitId: COMMIT, state: "COMMENTED" } };
    const first = await runGithubReview(validInput({ event: "APPROVE" }), HOST, deps);
    expect(first.ok && first.status === "unknown").toBe(true);
    refusedWith(await runGithubReview(validInput({ event: "APPROVE" }), HOST, deps), "dispatch_in_flight");
    expect(github.reviewCalls.length).toBe(1);
    expect(logs.length).toBe(1);
  });

  test("a posted review whose `posted` write fails is still posted, stays RESERVED with its claim, and the next call is refused", async () => {
    const reconcile = new FlakyReconcileStore(["posted"]);
    const { deps, github, logs } = makeDeps(scenario(root), { reconcile });
    const first = await runGithubReview(validInput(), HOST, deps);
    expect(first.ok && first.status === "posted").toBe(true);
    expect(reconcile.get("dispatch-1")).toBe("reserved");
    refusedWith(await runGithubReview(validInput(), HOST, deps), "dispatch_in_flight");
    expect(github.reviewCalls.length).toBe(1);
    expect(logs.length).toBe(1);
  });

  test("a rejected post whose reservation cannot be removed stays RESERVED: github_rejected, then refused", async () => {
    const reconcile = new FlakyReconcileStore(["release"]);
    const { deps, github, logs } = makeDeps(scenario(root), { reconcile });
    github.reviewResult = { ok: false, kind: "rejected", detail: "posting returned status 422" };
    refusedWith(await runGithubReview(validInput(), HOST, deps), "github_rejected");
    refusedWith(await runGithubReview(validInput(), HOST, deps), "dispatch_in_flight");
    expect(github.reviewCalls.length).toBe(1);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("could not be removed");
  });
});

describe("R5 — the durable reservation BEFORE the POST", () => {
  test("a failed reservation write means NO POST: store_unavailable, path-free", async () => {
    const reconcile = new FlakyReconcileStore(["reserve"]);
    const { deps, github } = makeDeps(scenario(root), { reconcile });
    const o = await runGithubReview(validInput(), HOST, deps);
    refusedWith(o, "store_unavailable");
    expect(outcomeToJson(o)).not.toContain("/host/secret");
    expect(github.reviewCalls.length).toBe(0);
    expect(reconcile.writes).toEqual([{ dispatchId: "dispatch-1", op: "reserve" }]);
  });

  test("the reservation is DURABLE on disk, with the attempt's details, when the POST leaves", async () => {
    const s = scenario(root);
    const seen: unknown[] = [];
    class ObservingGitHub extends FakeGitHub {
      override async createReview(input: Parameters<FakeGitHub["createReview"]>[0]) {
        seen.push(new FileReconcileStore(s.config.reconcileFile!).entry("dispatch-1"));
        return super.createReview(input);
      }
    }
    const { deps } = makeDeps(s, { github: new ObservingGitHub() });
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok && o.status === "posted").toBe(true);
    expect(seen).toEqual([
      expect.objectContaining({
        dispatchId: "dispatch-1",
        latch: "reserved",
        repo: REPO,
        pr: PR,
        commit: COMMIT,
        login: "anvil-reviewer",
        credentialSha256: s.custody.bindingSha256(),
        claim: expect.objectContaining({ pid: process.pid, token: expect.any(String) }),
      }),
    ]);
    const settled = new FileReconcileStore(s.config.reconcileFile!).entry("dispatch-1");
    expect(settled).toMatchObject({ latch: "posted", reviewId: 1, credentialSha256: s.custody.bindingSha256() });
    expect(settled!.claim).toBeUndefined();
    expect(JSON.stringify(settled)).not.toContain(TOKEN);
  });

  test("a latch that appears while the PR is being fetched is honoured at the reservation: no POST", async () => {
    const s = scenario(root);
    class LatchingGitHub extends FakeGitHub {
      override async fetchPull(repo: string, pr: number) {
        new FileReconcileStore(s.config.reconcileFile!).put({ dispatchId: "dispatch-1", latch: "posted" });
        return super.fetchPull(repo, pr);
      }
    }
    const github = new LatchingGitHub();
    const { deps } = makeDeps(s, { github });
    refusedWith(await runGithubReview(validInput(), HOST, deps), "already_posted");
    expect(github.reviewCalls.length).toBe(0);
  });

  test("a 2xx whose receipt partly throws when read: UNKNOWN (receipt_invalid) with the readable id, latched with it, never a throw", async () => {
    const s = scenario(root);
    const { deps, github, audit } = makeDeps(s);
    const receipt = { id: 5, url: "https://example.test/r/5", state: "APPROVED" } as { id: number; url: string; state: string; commitId: string };
    Object.defineProperty(receipt, "commitId", {
      get() {
        throw new Error("receipt unreadable");
      },
    });
    github.reviewResult = { ok: true, receipt };
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o).toMatchObject({ ok: true, status: "unknown", reason: "receipt_invalid", reviewId: 5, auditEventId: null });
    expect(new FileReconcileStore(s.config.reconcileFile!).entry("dispatch-1")).toMatchObject({ latch: "reconcile_required", reviewId: 5 });
    expect(audit.events.length).toBe(0);
    refusedWith(await runGithubReview(validInput(), HOST, deps), "reconcile_required");
    expect(github.reviewCalls.length).toBe(1);
  });

  test("an injected client whose EVERY receipt getter throws — or whose result's `ok` getter throws — never makes the handler throw", async () => {
    const throwing = (keys: string[], base: Record<string, unknown> = {}) => {
      const o: Record<string, unknown> = { ...base };
      for (const k of keys) {
        Object.defineProperty(o, k, {
          get() {
            throw new Error(`${k} unreadable`);
          },
        });
      }
      return o;
    };
    const results = [
      { result: throwing(["receipt"], { ok: true }), reason: "receipt_invalid" },
      { result: { ok: true, receipt: throwing(["id", "url", "commitId", "state"]) }, reason: "receipt_invalid" },
      { result: throwing(["ok"]), reason: "reconcile_required" },
      { result: throwing(["kind", "detail"], { ok: false }), reason: "reconcile_required" },
    ];
    for (const [i, { result, reason }] of results.entries()) {
      const s = scenario(join(root, `c${i}`));
      class InjectedClient extends FakeGitHub {
        override async createReview(input: Parameters<FakeGitHub["createReview"]>[0]) {
          this.reviewCalls.push(input);
          return result as never;
        }
      }
      const github = new InjectedClient();
      const { deps } = makeDeps(s, { github });
      const o = await runGithubReview(validInput(), HOST, deps);
      expect(o).toMatchObject({ ok: true, status: "unknown", reason, reviewId: null, reviewUrl: null, commitId: COMMIT, auditEventId: null });
      const e = new FileReconcileStore(s.config.reconcileFile!).entry("dispatch-1");
      expect(e).toMatchObject({ latch: "reconcile_required" });
      expect(e!.claim).toBeUndefined();
      expect(github.reviewCalls.length).toBe(1);
    }
  });

  test("an injected ledger whose outcome write THROWS, with a receipt whose getters work ONCE then throw: the fallback re-reads nothing — no throw", async () => {
    const s = scenario(root);
    class ThrowingSettleLedger extends DispatchLedger {
      override settle(): boolean {
        throw new Error("settle exploded");
      }
    }
    const once = (value: unknown) => {
      let reads = 0;
      return {
        get() {
          if (reads++ > 0) throw new Error("read twice");
          return value;
        },
      };
    };
    const receipt = {};
    Object.defineProperty(receipt, "id", once(5));
    Object.defineProperty(receipt, "url", once("https://example.test/r/5"));
    Object.defineProperty(receipt, "commitId", once(COMMIT));
    Object.defineProperty(receipt, "state", once("APPROVED"));
    const result = {};
    Object.defineProperty(result, "ok", once(true));
    Object.defineProperty(result, "receipt", once(receipt));
    class InjectedClient extends FakeGitHub {
      override async createReview(input: Parameters<FakeGitHub["createReview"]>[0]) {
        this.reviewCalls.push(input);
        return result as never;
      }
    }
    const github = new InjectedClient();
    const { deps } = makeDeps(s, { github, ledger: new ThrowingSettleLedger(new FileReconcileStore(s.config.reconcileFile!)) });
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o).toMatchObject({ ok: true, status: "unknown", reason: "reconcile_required", reviewId: 5, reviewUrl: "https://example.test/r/5" });
    // The outcome was not recorded, so the durable reservation and claim still hold the dispatch.
    expect(new FileReconcileStore(s.config.reconcileFile!).entry("dispatch-1")).toMatchObject({ latch: "reserved", claim: expect.any(Object) });
    expect(github.reviewCalls.length).toBe(1);
  });

  test("a final in-process release that throws does not change the returned outcome", async () => {
    const s = scenario(root);
    class ThrowingLeaveLedger extends DispatchLedger {
      override leave(): void {
        throw new Error("leave failed");
      }
    }
    const { deps } = makeDeps(s, { ledger: new ThrowingLeaveLedger(new FileReconcileStore(s.config.reconcileFile!)) });
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok && o.status === "posted").toBe(true);
  });

  for (const status of [408, 429]) {
    test(`a ${status} from the real client — even carrying GitHub's request id — is AMBIGUOUS: unknown, latched reconcile_required, 1 POST`, async () => {
      const s = scenario(root);
      const calls: string[] = [];
      const fetchImpl = (async (url: unknown, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(url)}`);
        if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ state: "open", head: { sha: COMMIT } }), { status: 200 });
        return new Response("slow down", { status, headers: { "x-github-request-id": "ABCD:1234" } });
      }) as unknown as typeof fetch;
      const { deps } = makeDeps(s, { github: new HttpGitHubApi({ custody: s.custody, fetchImpl }) });
      const o = await runGithubReview(validInput(), HOST, deps);
      expect(o).toMatchObject({ ok: true, status: "unknown", reason: "reconcile_required" });
      expect(new FileReconcileStore(s.config.reconcileFile!).get("dispatch-1")).toBe("reconcile_required");
      refusedWith(await runGithubReview(validInput(), HOST, deps), "reconcile_required");
      expect(calls.filter((c) => c.startsWith("POST")).length).toBe(1);
    });
  }

  test("a 422 produced by GitHub (request id present) PROVES non-creation: github_rejected, the reservation is removed, a corrected retry posts", async () => {
    const s = scenario(root);
    let postStatus = 422;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ state: "open", head: { sha: COMMIT } }), { status: 200 });
      if (postStatus === 422) return new Response("{}", { status: 422, headers: { "x-github-request-id": "ABCD:1" } });
      return new Response(JSON.stringify({ id: 3, html_url: "https://example.test/r/3", commit_id: COMMIT, state: "APPROVED" }), { status: 200 });
    }) as unknown as typeof fetch;
    const { deps } = makeDeps(s, { github: new HttpGitHubApi({ custody: s.custody, fetchImpl }) });
    refusedWith(await runGithubReview(validInput(), HOST, deps), "github_rejected");
    expect(new FileReconcileStore(s.config.reconcileFile!).get("dispatch-1")).toBeNull();
    postStatus = 200;
    const retry = await runGithubReview(validInput(), HOST, deps);
    expect(retry.ok && retry.status === "posted").toBe(true);
  });

  test("a createReview that THROWS is treated as ambiguous: unknown, and the dispatch refuses until reconciled", async () => {
    class ThrowingGitHub extends FakeGitHub {
      override async createReview(input: Parameters<FakeGitHub["createReview"]>[0]): Promise<never> {
        this.reviewCalls.push(input);
        throw new Error("socket hang up");
      }
    }
    const github = new ThrowingGitHub();
    const { deps } = makeDeps(scenario(root), { github });
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok && o.status === "unknown").toBe(true);
    refusedWith(await runGithubReview(validInput(), HOST, deps), "reconcile_required");
    expect(github.reviewCalls.length).toBe(1);
  });

  test("the event id and timestamp are prepared BEFORE the reservation: a failing id source aborts with no reservation and no POST", async () => {
    const s = scenario(root);
    const { deps, github } = makeDeps(s, {
      newId: () => {
        throw new Error("id source failed");
      },
    });
    await expect(runGithubReview(validInput(), HOST, deps)).rejects.toThrow("id source failed");
    expect(github.reviewCalls.length).toBe(0);
    expect(new FileReconcileStore(s.config.reconcileFile!).get("dispatch-1")).toBeNull();
  });

  test("nothing after the POST throws: a throwing host logger, a failing audit and a failing retention still return posted_audit_unretained", async () => {
    const { deps, github, audit } = makeDeps(scenario(root), {
      pendingAudits: new FailingSavePendingStore(),
      log: () => {
        throw new Error("logger down");
      },
    });
    audit.fail = true;
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok && o.status === "posted_audit_unretained").toBe(true);
    expect(github.reviewCalls.length).toBe(1);
  });

  test("a CRASH between the reservation and the POST: the next call is refused (the claim is held); the host proves non-creation and releases; exactly ONE POST in all", async () => {
    const s = scenario(root);
    const { res, posts } = childRun(s, { mode: "crash-before-post" });
    expect(res.signal).toBe("SIGKILL");
    expect(res.stdout).toBe("");
    expect(posts()).toBe(0);
    expect(new FileReconcileStore(s.config.reconcileFile!).entry("dispatch-1")).toMatchObject({ latch: "reserved", claim: expect.any(Object) });

    const restarted = makeDeps(s);
    refusedWith(await runGithubReview(validInput(), HOST, restarted.deps), "dispatch_in_flight");
    expect(restarted.github.reviewCalls.length).toBe(0);

    // The claim outlived its process: without --stale-claim reconcile refuses.
    expect(await hostReconcile(s, [])).toBe(1);
    expect(await hostReconcile(s, [], { staleClaim: true })).toBe(0);
    const after = await runGithubReview(validInput(), HOST, restarted.deps);
    expect(after.ok && after.status === "posted").toBe(true);
    expect(posts() + restarted.github.reviewCalls.length).toBe(1);
  }, PROCESS_TEST_TIMEOUT_MS);

  test("a CRASH between the POST and the `posted` write: refused until the host finds the review and latches posted; exactly ONE POST in all", async () => {
    const s = scenario(root);
    const { res, posts } = childRun(s, { mode: "crash-after-post" });
    expect(res.signal).toBe("SIGKILL");
    expect(posts()).toBe(1);
    expect(new FileReconcileStore(s.config.reconcileFile!).get("dispatch-1")).toBe("reserved");

    const restarted = makeDeps(s);
    refusedWith(await runGithubReview(validInput(), HOST, restarted.deps), "dispatch_in_flight");

    const review: ExistingReview = {
      id: 1,
      login: "anvil-reviewer",
      commitId: COMMIT,
      state: "APPROVED",
      url: "https://example.test/r/1",
      submittedAt: new Date().toISOString(),
    };
    expect(await hostReconcile(s, [review], { staleClaim: true })).toBe(0);
    refusedWith(await runGithubReview(validInput(), HOST, restarted.deps), "already_posted");
    expect(posts() + restarted.github.reviewCalls.length).toBe(1);
  }, PROCESS_TEST_TIMEOUT_MS);
});

describe("R6 — one lock, real processes", () => {
  test("TWO PROCESSES claim the same dispatch at once (store read-modify-write widened): exactly ONE POST", async () => {
    const s = scenario(root);
    const goFile = join(root, "go");
    const postLog = join(root, "posts.log");
    const a = childStart(s, { mode: "race", goFile, widenMs: 400, postLog }, "a");
    const b = childStart(s, { mode: "race", goFile, widenMs: 400, postLog }, "b");
    writeFileSync(goFile, "go");
    const [ra, rb] = await Promise.all([a, b]);
    const outcomes = [ra, rb].map((r) => JSON.parse(r.stdout.trim()) as { status?: string; reason?: string });
    const posts = readFileSync(postLog, "utf8").split("\n").filter(Boolean);
    expect(posts.length).toBe(1);
    expect(outcomes.filter((o) => o.status === "posted").length).toBe(1);
    const other = outcomes.find((o) => o.status !== "posted")!;
    expect(["dispatch_in_flight", "already_posted"]).toContain(other.reason!);
    expect(new FileReconcileStore(s.config.reconcileFile!).get("dispatch-1")).toBe("posted");
  }, PROCESS_TEST_TIMEOUT_MS);

  test("TWO PROCESSES updating DIFFERENT dispatches at once lose neither update", async () => {
    const store = join(root, "shared.json");
    const script = join(root, "put.ts");
    const go = join(root, "go2");
    writeFileSync(
      script,
      [
        `import { spyOn } from "bun:test";`,
        `import * as fs from "node:fs";`,
        `import { FileReconcileStore } from ${JSON.stringify(join(here, "..", "src", "audit.ts"))};`,
        `const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);`,
        `const realOpen = fs.openSync.bind(fs);`,
        `spyOn(fs, "openSync").mockImplementation(((p: any, f: any, m: any) => { if (String(p).endsWith(".tmp")) sleep(300); return realOpen(p, f ?? "r", m); }) as any);`,
        `while (!fs.existsSync(${JSON.stringify(go)})) sleep(5);`,
        `new FileReconcileStore(${JSON.stringify(store)}).put({ dispatchId: process.argv[2]!, latch: "posted" });`,
      ].join("\n"),
    );
    const pa = spawnAsync(process.execPath, [script, "d-a"]);
    const pb = spawnAsync(process.execPath, [script, "d-b"]);
    writeFileSync(go, "go");
    const [ra, rb] = await Promise.all([pa, pb]);
    expect([ra.code, rb.code]).toEqual([0, 0]);
    expect(new FileReconcileStore(store).list().map((e) => e.dispatchId).sort()).toEqual(["d-a", "d-b"]);
  }, PROCESS_TEST_TIMEOUT_MS);

  test("TWO PROCESSES retaining DIFFERENT audit records at once lose neither (the pending-audit store is locked too)", async () => {
    const store = join(root, "pending.json");
    const script = join(root, "save.ts");
    const go = join(root, "go3");
    writeFileSync(
      script,
      [
        `import { spyOn } from "bun:test";`,
        `import * as fs from "node:fs";`,
        `import { FilePendingAuditStore } from ${JSON.stringify(join(here, "..", "src", "audit.ts"))};`,
        `const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);`,
        `const realOpen = fs.openSync.bind(fs);`,
        `spyOn(fs, "openSync").mockImplementation(((p: any, f: any, m: any) => { if (String(p).endsWith(".tmp")) sleep(300); return realOpen(p, f ?? "r", m); }) as any);`,
        `while (!fs.existsSync(${JSON.stringify(go)})) sleep(5);`,
        `const id = process.argv[2]!;`,
        `new FilePendingAuditStore(${JSON.stringify(store)}).save({ id, authorId: "a", kind: "pr_review_posted", scope: "r", refId: "1", targetIds: [], summary: "s", detail: "{}", createdAt: "t" });`,
      ].join("\n"),
    );
    const pa = spawnAsync(process.execPath, [script, "e-a"]);
    const pb = spawnAsync(process.execPath, [script, "e-b"]);
    writeFileSync(go, "go");
    const [ra, rb] = await Promise.all([pa, pb]);
    expect([ra.code, rb.code]).toEqual([0, 0]);
    expect(new FilePendingAuditStore(store).list().map((e) => e.id).sort()).toEqual(["e-a", "e-b"]);
  }, PROCESS_TEST_TIMEOUT_MS);

  test("RECONCILE racing an IN-FLIGHT POST in another process is refused (claim held); after the POST the dispatch is posted and final", async () => {
    const s = scenario(root);
    const inPostFile = join(root, "in-post");
    const releaseFile = join(root, "release");
    const postLog = join(root, "posts.log");
    const later = new Date(Date.now() + 3_600_000);
    const child = childStart(s, { mode: "hold", inPostFile, releaseFile, postLog }, "hold");
    await waitFor(() => existsSync(inPostFile));
    const childPid = Number(readFileSync(inPostFile, "utf8"));
    const errors: string[] = [];
    // Without --stale-claim: the claim is held.
    expect(await hostReconcile(s, [], { err: errors, now: later })).toBe(1);
    expect(errors.join("\n")).toContain(`claim held by pid ${childPid}`);
    // With --stale-claim: the claiming process is alive on this host.
    expect(await hostReconcile(s, [], { staleClaim: true, err: errors, now: later })).toBe(1);
    expect(errors.join("\n")).toContain(`pid ${childPid} is still running`);
    expect(new FileReconcileStore(s.config.reconcileFile!).get("dispatch-1")).toBe("reserved");
    writeFileSync(releaseFile, "go");
    const r = await child;
    expect((JSON.parse(r.stdout.trim()) as { status: string }).status).toBe("posted");
    expect(new FileReconcileStore(s.config.reconcileFile!).get("dispatch-1")).toBe("posted");
    expect(await hostReconcile(s, [], { staleClaim: true, now: later })).toBe(1);
    expect(new FileReconcileStore(s.config.reconcileFile!).get("dispatch-1")).toBe("posted");
  }, PROCESS_TEST_TIMEOUT_MS);

  test("a STALE store lock (its holder died) fails the claim closed: store_unavailable, no POST, a path-free log naming the lock and remedy", async () => {
    const s = scenario(root);
    const lock = `${s.config.reconcileFile!}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: 999999, host: "gone", since: "2026-01-01T00:00:00Z", op: "reserve", token: "x" }));
    const { deps, github, logs } = makeDeps(s);
    const o = await runGithubReview(validInput(), HOST, deps);
    refusedWith(o, "store_unavailable");
    expect(github.reviewCalls.length).toBe(0);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('reconcileFile + ".lock"');
    expect(logs[0]).toContain("pid 999999");
    expect(logs[0]).toContain("stale");
    expect(logs[0]).not.toContain(root);
    expect(existsSync(lock)).toBe(true);
    expect(new FileReconcileStore(s.config.reconcileFile!).get("dispatch-1")).toBeNull();
  });
});

/** Run the gateway child synchronously (crash modes). */
function childRun(s: Scenario, extra: Record<string, unknown>) {
  const postLog = join(root, "posts.log");
  const specFile = join(root, "child-spec.json");
  writeFileSync(specFile, JSON.stringify({ pluginConfig: pluginConfigOf(s), postLog, ...extra }), { mode: 0o600 });
  const res = spawnSync(process.execPath, [join(here, "gateway-child.ts"), specFile], {
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  const posts = () => (existsSync(postLog) ? readFileSync(postLog, "utf8").split("\n").filter(Boolean).length : 0);
  return { res, posts };
}

/** Start the gateway child without waiting (race and hold modes). */
function childStart(s: Scenario, extra: Record<string, unknown>, name: string) {
  const specFile = join(root, `child-${name}.json`);
  writeFileSync(specFile, JSON.stringify({ pluginConfig: pluginConfigOf(s), ...extra }), { mode: 0o600 });
  return spawnAsync(process.execPath, [join(here, "gateway-child.ts"), specFile]);
}

function spawnAsync(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The host's audited reconciliation of dispatch-1 against a given review
 *  listing, run as if 11 minutes after the attempt unless `now` is given. */
async function hostReconcile(
  s: Scenario,
  reviews: ExistingReview[],
  opts: { staleClaim?: boolean; now?: Date; err?: string[] } = {},
): Promise<number> {
  const configFile = join(root, "plugin-config.json");
  writeFileSync(configFile, JSON.stringify(pluginConfigOf(s)), { mode: 0o600 });
  const { fetchImpl } = fakeFlairFetch(200);
  const now = opts.now ?? new Date(Date.now() + 11 * 60_000);
  return runLatchAdmin(
    ["reconcile", configFile, "dispatch-1", ...(opts.staleClaim ? ["--stale-claim"] : [])],
    () => {},
    (l) => opts.err?.push(l),
    { lister: new FakeReviewLister({ ok: true, reviews }), fetchImpl, clock: () => now },
  );
}

describe("ONE VERDICT PER DISPATCH (in flight and after a post)", () => {
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
