/**
 * authorization.test.ts — A4: local authorization refusals.
 *
 * Every malformed or unauthorized case is refused with a stable reason, the
 * safely resolved actor, relevant state and a remedy — and NO outbound request
 * leaves.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGithubReview } from "../src/handler.js";
import type { Outcome } from "../src/types.js";
import {
  COMMIT,
  makeDeps,
  PAST,
  PR,
  REPO,
  resolver,
  scenario,
  validAssignment,
  validInput,
  type Scenario,
} from "./helpers.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gr-auth-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const HOST = { sessionKey: "sess-1", sandboxed: false };

function refused(o: Outcome): asserts o is Extract<Outcome, { ok: false }> {
  expect(o.ok).toBe(false);
  if (o.ok) throw new Error("expected a refusal");
  expect(typeof o.reason).toBe("string");
  expect(o.state.length).toBeGreaterThan(0);
  expect(o.remedy.length).toBeGreaterThan(0);
}

async function run(s: Scenario, input: unknown, ctx = HOST) {
  const { deps, github } = makeDeps(s);
  const outcome = await runGithubReview(input, ctx, deps);
  expect(github.fetchPullCalls.length + github.reviewCalls.length).toBe(0);
  return outcome;
}

describe("A4 — local authorization refusals", () => {
  test("malformed input is refused", async () => {
    refused(await run(scenario(root), "not-an-object"));
  });

  test("an unsupported field is refused", async () => {
    const o = await run(scenario(root), validInput({ endpoint: "https://evil.test" }));
    refused(o);
    expect(o.reason).toBe("unsupported_field");
  });

  test("a repository outside the configured set is refused", async () => {
    const o = await run(scenario(root), validInput({ repo: "other/repo" }));
    refused(o);
    expect(o.reason).toBe("repo_not_configured");
  });

  test("a missing dispatch assignment is refused", async () => {
    const o = await run(scenario(root), validInput(), { sessionKey: "sess-unknown", sandboxed: false });
    refused(o);
    expect(o.reason).toBe("assignment_missing");
  });

  test("an assignment mismatch WITHIN the configured repository set is refused", async () => {
    const s = scenario(root, { allowedRepositories: [REPO, "tpsdev-ai/other"] });
    const { deps, github } = makeDeps(s, { assignments: resolver([validAssignment({ repo: REPO, pr: PR })]) });
    const o = await runGithubReview(validInput({ repo: "tpsdev-ai/other" }), HOST, deps);
    refused(o);
    expect(o.reason).toBe("assignment_mismatch");
    expect(github.fetchPullCalls.length + github.reviewCalls.length).toBe(0);
  });

  test("a reviewer identity that does not match the host signing identity is refused", async () => {
    const s = scenario(root);
    const { deps } = makeDeps(s, { assignments: resolver([validAssignment({ reviewer: "someone-else" })]) });
    const o = await runGithubReview(validInput(), HOST, deps);
    refused(o);
    expect(o.reason).toBe("assignment_mismatch");
  });

  test("an expired assignment is refused", async () => {
    const s = scenario(root);
    const { deps } = makeDeps(s, { assignments: resolver([validAssignment({ expiresAt: PAST })]) });
    const o = await runGithubReview(validInput(), HOST, deps);
    refused(o);
    expect(o.reason).toBe("assignment_expired");
  });

  test("an inactive assignment is refused", async () => {
    const s = scenario(root);
    const { deps } = makeDeps(s, { assignments: resolver([validAssignment({ active: false })]) });
    const o = await runGithubReview(validInput(), HOST, deps);
    refused(o);
    expect(o.reason).toBe("assignment_expired");
  });

  test("an unsupported event is refused", async () => {
    const o = await run(scenario(root), validInput({ event: "MERGE" }));
    refused(o);
    expect(o.reason).toBe("unsupported_event");
  });

  test("a commit_id that is not a SHA is refused", async () => {
    const o = await run(scenario(root), validInput({ commit_id: "HEAD" }));
    refused(o);
    expect(o.reason).toBe("invalid_input");
  });

  test("an oversized body is refused", async () => {
    const o = await run(scenario(root), validInput({ body: "x".repeat(70_000) }));
    refused(o);
    expect(o.reason).toBe("body_too_large");
  });

  test("an absent body limit is a configuration failure", async () => {
    const o = await run(scenario(root, { maxBodyBytes: null }), validInput());
    refused(o);
    expect(o.reason).toBe("body_limit_unconfigured");
  });

  test("a missing credential leaves posting unavailable", async () => {
    const s = scenario(root, { credentialFile: join(root, "does-not-exist") });
    const o = await run(s, validInput());
    refused(o);
    expect(o.reason).toBe("credential_unavailable");
  });

  test("the refusal names the safely resolved actor once the assignment is known", async () => {
    const o = await run(scenario(root), validInput({ body: "x".repeat(70_000) }));
    refused(o);
    expect(o.actor).toBe("anvil");
  });

  test("a valid request is NOT refused (control)", async () => {
    const s = scenario(root);
    const { deps, github } = makeDeps(s);
    const o = await runGithubReview(validInput({ commit_id: COMMIT }), HOST, deps);
    expect(o.ok).toBe(true);
    expect(github.reviewCalls.length).toBe(1);
  });
});
