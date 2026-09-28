/**
 * credential.test.ts — A7: credential readiness and custody.
 *
 * The credential is read once at start; scope is verified from trusted
 * provisioning evidence BEFORE any request; unknown or stale evidence disables
 * posting; the token is never re-read, disclosed, or placed in a tool result.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGithubReview } from "../src/handler.js";
import { makeDeps, scenario, session, TOKEN, validInput, type Scenario } from "./helpers.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gr-cred-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const HOST = session();

async function expectRefusedWith(s: Scenario, expected: string) {
  const { deps, github } = makeDeps(s);
  const o = await runGithubReview(validInput(), HOST, deps);
  expect(o.ok).toBe(false);
  if (!o.ok) expect(o.reason).toBe(expected);
  expect(github.fetchPullCalls.length + github.reviewCalls.length).toBe(0);
}

describe("A7 — credential readiness and custody", () => {
  test("missing credential file disables posting", async () => {
    await expectRefusedWith(scenario(root, { credentialFile: join(root, "nope") }), "credential_unavailable");
  });

  test("improperly protected credential file is refused", async () => {
    await expectRefusedWith(scenario(root, {}, { mode: 0o644 }), "credential_unavailable");
  });

  test("a classic token is a disallowed credential type", async () => {
    await expectRefusedWith(scenario(root, {}, { token: "ghp_" + "0".repeat(36) }), "credential_unavailable");
  });

  test("absent provisioning evidence disables posting", async () => {
    await expectRefusedWith(scenario(root, {}, { evidence: null }), "credential_unavailable");
  });

  test("evidence not bound to the installed credential is refused", async () => {
    await expectRefusedWith(scenario(root, {}, { evidence: { boundCredentialSha256: "f".repeat(64) } }), "credential_unavailable");
  });

  test("stale evidence disables posting", async () => {
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    await expectRefusedWith(scenario(root, {}, { recordedAt: old }), "credential_unavailable");
  });

  test("a login absent from the evidence is refused", async () => {
    await expectRefusedWith(scenario(root, {}, { evidence: { login: "" } }), "scope_unverified");
  });

  test("repository-coverage mismatch is refused", async () => {
    await expectRefusedWith(scenario(root, {}, { evidence: { repositories: ["someone/else"] } }), "scope_unverified");
  });

  test("insufficient permissions (no pull-request write) are refused", async () => {
    await expectRefusedWith(scenario(root, {}, { evidence: { permissions: { pull_requests: "read" } } }), "scope_unverified");
  });

  test("excessive permissions are refused", async () => {
    await expectRefusedWith(scenario(root, {}, { evidence: { permissions: { pull_requests: "write", administration: "write" } } }), "scope_unverified");
  });

  test("scope is verified BEFORE any request leaves (control)", async () => {
    const { deps, github } = makeDeps(scenario(root));
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok).toBe(true);
    expect(github.fetchPullCalls.length).toBe(1);
  });

  test("the token is read once: deleting the file after load does not break a post", async () => {
    const s = scenario(root);
    const credentialFile = s.config.credentialFile!;
    expect(existsSync(credentialFile)).toBe(true);
    rmSync(credentialFile);
    const { deps, github } = makeDeps(s);
    const o = await runGithubReview(validInput(), HOST, deps);
    expect(o.ok).toBe(true);
    expect(github.reviewCalls.length).toBe(1);
  });

  test("no result, log line or outcome discloses the token or its location", async () => {
    const s = scenario(root);
    const { deps, github } = makeDeps(s);
    const o = await runGithubReview(validInput(), HOST, deps);
    const combined = [JSON.stringify(o), github.reviewCalls.map((c) => JSON.stringify(c)).join("\n")].join("\n");
    expect(combined.includes(TOKEN)).toBe(false);
    expect(combined.includes(s.config.credentialFile!)).toBe(false);
    expect(readFileSync(s.config.credentialFile!, "utf8").trim()).toBe(TOKEN);
  });
});
