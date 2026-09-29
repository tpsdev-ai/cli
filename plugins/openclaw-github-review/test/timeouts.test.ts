/**
 * timeouts.test.ts — every outbound request is bounded by REQUEST_TIMEOUT_MS:
 * the GitHub GETs (fetchPull, listReviews), the GitHub POST (createReview) and
 * the Flair audit POST. Each is tested with a fetch that NEVER answers and
 * ignores its abort signal: the call still returns, the signal it was given
 * has aborted, and the result is classified — a timed-out GitHub POST is
 * AMBIGUOUS (the dispatch stays latched; a further review is a fresh
 * dispatch), and a timed-out Flair write takes the existing retention path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePendingAuditStore, FileReconcileStore } from "../src/audit.js";
import { FlairHttpAuditSink } from "../src/flair-sink.js";
import { HttpGitHubApi } from "../src/github.js";
import { runGithubReview } from "../src/handler.js";
import { REQUEST_TIMEOUT_MS } from "../src/request-timeout.js";
import type { OrgEventDraft } from "../src/types.js";
import { COMMIT, makeDeps, PR, REPO, scenario, session, validInput, writeEd25519Key } from "./helpers.js";

const SHORT_MS = 50;
/** Well under bun's per-test timeout: a call that did not time out fails the bound. */
const BOUND_MS = 3000;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gr-timeout-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fetch that never answers and ignores its signal; records each init. */
function neverFetch() {
  const seen: RequestInit[] = [];
  const fn = ((_url: unknown, init?: RequestInit) => {
    seen.push(init ?? {});
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;
  return { fn, seen };
}

/** Settle `p` or give up after BOUND_MS, so a call that never times out FAILS
 *  the test instead of hanging it. */
async function bounded<T>(p: Promise<T>): Promise<{ settled: true; value?: T; error?: unknown } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<{ settled: false }>((r) => {
    timer = setTimeout(() => r({ settled: false }), BOUND_MS);
  });
  try {
    return await Promise.race([
      p.then(
        (value) => ({ settled: true as const, value }),
        (error: unknown) => ({ settled: true as const, error }),
      ),
      guard,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const event: OrgEventDraft = {
  id: "evt-t",
  authorId: "anvil",
  kind: "pr_review_posted",
  scope: REPO,
  refId: String(PR),
  targetIds: [String(PR), COMMIT],
  summary: "s",
  detail: "{}",
  createdAt: "2026-09-29T00:00:00.000Z",
};

describe("REQUEST_TIMEOUT_MS bounds every outbound request", () => {
  test("REQUEST_TIMEOUT_MS is 30 s, and every client passes a fresh abort signal by default", async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
    const { custody } = scenario(root);
    const seen: RequestInit[] = [];
    const ok = ((_u: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return Promise.resolve(new Response(JSON.stringify({ state: "open", head: { sha: COMMIT } }), { status: 200 }));
    }) as unknown as typeof fetch;
    await new HttpGitHubApi({ custody, fetchImpl: ok }).fetchPull(REPO, PR);
    const keyPath = join(root, "k.key");
    writeEd25519Key(keyPath);
    await new FlairHttpAuditSink("anvil", "http://flair.test", keyPath, ok).record(event);
    for (const init of seen) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal!.aborted).toBe(false);
    }
    expect(seen.length).toBe(2);
  });

  test("fetchPull: a GET that never answers times out → a failed lookup", async () => {
    const { custody } = scenario(root);
    const { fn, seen } = neverFetch();
    const r = await bounded(new HttpGitHubApi({ custody, fetchImpl: fn, timeoutMs: SHORT_MS }).fetchPull(REPO, PR));
    expect(r).toMatchObject({ settled: true, value: { ok: false } });
    expect(seen[0]!.signal!.aborted).toBe(true);
  });

  test("listReviews: a GET that never answers times out → an INCOMPLETE listing, never 'no reviews'", async () => {
    const { custody } = scenario(root);
    const { fn, seen } = neverFetch();
    const r = await bounded(new HttpGitHubApi({ custody, fetchImpl: fn, timeoutMs: SHORT_MS }).listReviews(REPO, PR));
    expect(r).toMatchObject({ settled: true, value: { ok: false } });
    expect(seen[0]!.signal!.aborted).toBe(true);
  });

  test("createReview: a POST that never answers times out → AMBIGUOUS (a review may exist)", async () => {
    const { custody } = scenario(root);
    const { fn, seen } = neverFetch();
    const api = new HttpGitHubApi({ custody, fetchImpl: fn, timeoutMs: SHORT_MS });
    const r = await bounded(api.createReview({ repo: REPO, pr: PR, commitId: COMMIT, event: "APPROVE", body: "x" }));
    expect(r).toMatchObject({ settled: true, value: { ok: false, kind: "ambiguous" } });
    expect(seen[0]!.signal!.aborted).toBe(true);
  });

  test("Flair sink: a POST that never answers times out → the write THROWS (so the handler retains it)", async () => {
    const keyPath = join(root, "k.key");
    writeEd25519Key(keyPath);
    const { fn, seen } = neverFetch();
    const sink = new FlairHttpAuditSink("anvil", "http://flair.test", keyPath, fn, SHORT_MS);
    const r = await bounded(sink.record(event));
    expect(r.settled).toBe(true);
    if (r.settled) expect(r.error).toBeInstanceOf(Error);
    expect(seen[0]!.signal!.aborted).toBe(true);
  });
});

describe("timeouts end to end through the handler", () => {
  test("a GitHub POST that times out: unknown, latched reconcile_required (claim dropped), the next call refused with the fresh-dispatch remedy; 1 POST", async () => {
    const s = scenario(root);
    let posts = 0;
    const fetchImpl = ((_u: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return Promise.resolve(new Response(JSON.stringify({ state: "open", head: { sha: COMMIT } }), { status: 200 }));
      }
      posts++;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const { deps } = makeDeps(s, { github: new HttpGitHubApi({ custody: s.custody, fetchImpl, timeoutMs: SHORT_MS }) });
    const r = await bounded(runGithubReview(validInput(), session(), deps));
    expect(r).toMatchObject({ settled: true, value: { ok: true, status: "unknown", reason: "reconcile_required" } });
    const entry = new FileReconcileStore(s.config.reconcileFile!).entry("dispatch-1");
    expect(entry).toMatchObject({ latch: "reconcile_required" });
    expect(entry!.claim).toBeUndefined();
    const again = await runGithubReview(validInput(), session(), deps);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.reason).toBe("reconcile_required");
      expect(again.remedy).toContain("fresh dispatch");
    }
    expect(posts).toBe(1);
  });

  test("a Flair audit write that times out takes the retention path: posted_audit_pending, the record retained", async () => {
    const s = scenario(root);
    const { fn } = neverFetch();
    const sink = new FlairHttpAuditSink("anvil", "http://flair.test", s.config.signingKeyFile!, fn, SHORT_MS);
    const { deps, github } = makeDeps(s, { audit: sink });
    const r = await bounded(runGithubReview(validInput(), session(), deps));
    expect(r).toMatchObject({ settled: true, value: { ok: true, status: "posted_audit_pending" } });
    expect(github.reviewCalls.length).toBe(1);
    expect(new FilePendingAuditStore(s.config.pendingAuditFile!).list().length).toBe(1);
  });
});
