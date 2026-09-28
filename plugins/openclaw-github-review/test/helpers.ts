/**
 * helpers.ts — shared fakes and fixtures for the github_review suite.
 *
 * Everything here is hermetic: no network, no real credential, no host path
 * outside the test's own temp root.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StaticAssignmentResolver } from "../src/assignment.js";
import { CredentialCustody } from "../src/credential.js";
import { resolveConfig, type GithubReviewConfig } from "../src/config.js";
import { buildDeps, type HandlerServices } from "../src/index.js";
import type { HandlerDeps } from "../src/handler.js";
import type {
  AssignmentResolver,
  AuditSink,
  DispatchAssignment,
  GitHubApi,
  OrgEventDraft,
  ReviewEvent,
  ReviewReceipt,
} from "../src/types.js";

export const REPO = "tpsdev-ai/cli";
export const PR = 425;
export const COMMIT = "a".repeat(40);
export const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
export const PAST = new Date(Date.now() - 3_600_000).toISOString();

export class FakeGitHub implements GitHubApi {
  fetchPullCalls: Array<{ repo: string; pr: number }> = [];
  reviewCalls: Array<{ repo: string; pr: number; commitId: string; event: ReviewEvent; body: string }> = [];
  pull: { ok: true; pull: { state: "open" | "closed"; head: string } } | { ok: false; detail: string } = {
    ok: true,
    pull: { state: "open", head: COMMIT },
  };
  reviewResult:
    | { ok: true; receipt: ReviewReceipt }
    | { ok: false; kind: "rejected" | "ambiguous"; detail: string } = {
    ok: true,
    receipt: { id: 1, url: `https://example.test/${REPO}/pull/${PR}#r1`, commitId: COMMIT, state: "APPROVED" },
  };

  async fetchPull(repo: string, pr: number) {
    this.fetchPullCalls.push({ repo, pr });
    return this.pull;
  }

  async createReview(input: { repo: string; pr: number; commitId: string; event: ReviewEvent; body: string }) {
    this.reviewCalls.push(input);
    return this.reviewResult;
  }
}

export class FakeAudit implements AuditSink {
  events: OrgEventDraft[] = [];
  fail = false;
  async record(event: OrgEventDraft) {
    if (this.fail) throw new Error("audit write failed");
    this.events.push(event);
  }
}

export function validAssignment(overrides: Partial<DispatchAssignment> = {}): DispatchAssignment {
  return {
    sessionKey: "sess-1",
    reviewer: "anvil",
    repo: REPO,
    pr: PR,
    reviewedCommit: COMMIT,
    dispatchId: "dispatch-1",
    expiresAt: FUTURE,
    active: true,
    ...overrides,
  };
}

export const TOKEN = "github_pat_11TESTONLY0000000000000000000000000000000000000000000000000000000";

/** Write a credential file and (by default) matching provisioning evidence. */
export function fakeCredentialFiles(
  root: string,
  opts: {
    token?: string;
    mode?: number;
    evidence?: Record<string, unknown> | null;
    recordedAt?: string;
  } = {},
): { credentialFile: string; provisioningFile: string | null } {
  const token = opts.token ?? TOKEN;
  const credentialFile = join(root, "gh.token");
  writeFileSync(credentialFile, token, { mode: opts.mode ?? 0o600 });
  if (opts.mode !== undefined) chmodSync(credentialFile, opts.mode);
  const provisioningFile = join(root, "provisioning.json");
  if (opts.evidence === null) {
    return { credentialFile, provisioningFile: null };
  }
  const sha = createHash("sha256").update(Buffer.from(token, "utf8")).digest("hex");
  const evidence = {
    login: "anvil-reviewer",
    repositories: [REPO],
    permissions: { pull_requests: "write", contents: "read", metadata: "read" },
    boundCredentialSha256: sha,
    recordedAt: opts.recordedAt ?? new Date().toISOString(),
    credentialType: "fine-grained",
    ...(opts.evidence ?? {}),
  };
  writeFileSync(provisioningFile, JSON.stringify(evidence), { mode: 0o600 });
  return { credentialFile, provisioningFile };
}

export interface Scenario {
  config: GithubReviewConfig;
  custody: CredentialCustody;
}

/** The standard, fully-valid host configuration for a test. */
export function scenario(root: string, configOverrides: Record<string, unknown> = {}, credOpts: Parameters<typeof fakeCredentialFiles>[1] = {}): Scenario {
  const files = fakeCredentialFiles(root, credOpts);
  const config = resolveConfig(
    {
      allowedRepositories: [REPO],
      maxBodyBytes: 65_536,
      credentialFile: files.credentialFile,
      provisioningFile: files.provisioningFile,
      signingKeyFile: join(root, "anvil.key"),
      reviewerIdentity: "anvil",
      sandboxImageDigest: "sha256:deadbeef",
      ...configOverrides,
    },
    "0.1.0-test",
  );
  const { custody } = CredentialCustody.load({
    credentialFile: config.credentialFile,
    provisioningFile: config.provisioningFile,
    maxAgeDays: config.provisioningMaxAgeDays,
    clock: () => new Date(),
  });
  return { config, custody };
}

export function resolver(assignments: DispatchAssignment[]): AssignmentResolver {
  return new StaticAssignmentResolver(assignments);
}

export function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { repo: REPO, pr: PR, commit_id: COMMIT, event: "APPROVE", body: "looks good", ...overrides };
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

/** Build handler deps wired to the standard fakes. */
export function makeDeps(
  s: Scenario,
  services: HandlerServices = {},
): { deps: HandlerDeps; github: FakeGitHub; audit: FakeAudit } {
  const github = (services.github as FakeGitHub | undefined) ?? new FakeGitHub();
  const audit = (services.audit as FakeAudit | undefined) ?? new FakeAudit();
  const deps = buildDeps(s.config, s.custody, {
    assignments: resolver([validAssignment()]),
    ...services,
    github,
    audit,
  });
  return { deps, github, audit };
}
