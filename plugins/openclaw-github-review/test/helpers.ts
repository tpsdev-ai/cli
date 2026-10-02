/**
 * helpers.ts — shared fakes and fixtures for the github_review suite.
 *
 * Everything here is hermetic: no network, no real credential, no host path
 * outside the test's own temp root.
 */

import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StaticAssignmentResolver } from "../src/assignment.js";
import { buildApprovalEvidence, writeApprovalEvidence } from "../src/approval-evidence.js";
import { MemoryReconcileStore } from "../src/audit.js";
import { CredentialCustody } from "../src/credential.js";
import { resolveConfig, type GithubReviewConfig } from "../src/config.js";
import { buildDeps, type HandlerServices } from "../src/index.js";
import type { HandlerDeps } from "../src/handler.js";
import type {
  AssignmentResolver,
  AuditSink,
  DispatchAssignment,
  DispatchLatch,
  ExistingReview,
  LatchClaim,
  LatchRecord,
  GitHubApi,
  GitHubReviewLister,
  LatchDetails,
  OrgEventDraft,
  PendingAuditStore,
  ReconcileStore,
  ReviewEvent,
  ReviewReceipt,
  SessionContext,
} from "../src/types.js";

export const REPO = "tpsdev-ai/cli";
export const PR = 425;
export const COMMIT = "a".repeat(40);
export const REVIEWER = "anvil";
export const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
export const PAST = new Date(Date.now() - 3_600_000).toISOString();

/** The trusted session context the gateway supplies: the reviewer's agent id and
 *  the session key the dispatch assignment is bound to. */
export function session(overrides: Partial<SessionContext> = {}): SessionContext {
  return { sessionKey: "sess-1", agentId: REVIEWER, ...overrides };
}

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

/** A pending-audit store whose save() throws AFTER its probe passed — for the
 *  "audit retention fails after a post" case (the handler must not throw). */
export class FailingSavePendingStore implements PendingAuditStore {
  list(): OrgEventDraft[] {
    return [];
  }
  save(): void {
    throw new Error("pending store path /host/secret/pending.json is unwritable");
  }
  remove(): void {
    /* noop */
  }
  probe(): void {
    /* the store looked usable before the request */
  }
}

/** A latch store (in memory, same claim semantics) that reads and probes fine
 *  but whose chosen operations throw — a durable latch write failing mid-flow. */
export class FlakyReconcileStore implements ReconcileStore {
  readonly inner = new MemoryReconcileStore();
  writes: Array<{ dispatchId: string; op: FlakyOp }> = [];
  constructor(private readonly failOn: ReadonlyArray<FlakyOp>) {}
  get(dispatchId: string): DispatchLatch | null {
    return this.inner.entry(dispatchId)?.latch ?? null;
  }
  entry(dispatchId: string): LatchRecord | null {
    return this.inner.entry(dispatchId);
  }
  private attempt(dispatchId: string, op: FlakyOp): void {
    this.writes.push({ dispatchId, op });
    if (this.failOn.includes(op)) throw new Error("latch store path /host/secret/reconcile.json is unwritable");
  }
  reserve(dispatchId: string, details: LatchDetails, claim: LatchClaim): LatchRecord | null {
    this.attempt(dispatchId, "reserve");
    return this.inner.reserve(dispatchId, details, claim);
  }
  settle(dispatchId: string, claimToken: string, latch: "posted" | "reconcile_required", details?: Partial<LatchDetails>): void {
    this.attempt(dispatchId, latch);
    this.inner.settle(dispatchId, claimToken, latch, details);
  }
  release(dispatchId: string, claimToken: string): void {
    this.attempt(dispatchId, "release");
    this.inner.release(dispatchId, claimToken);
  }
  probe(): void {
    /* the store looked usable before the request */
  }
}
export type FlakyOp = "reserve" | "posted" | "reconcile_required" | "release";

/** The plugin configuration object (as the gateway would pass it) for a
 *  scenario's host files. */
export function pluginConfigOf(s: Scenario, flairUrl = "http://flair.test.invalid"): Record<string, unknown> {
  return {
    allowedRepositories: s.config.allowedRepositories,
    maxBodyBytes: s.config.maxBodyBytes,
    credentialFile: s.config.credentialFile,
    provisioningFile: s.config.provisioningFile,
    signingKeyFile: s.config.signingKeyFile,
    reviewerIdentity: s.config.reviewerIdentity,
    pendingAuditFile: s.config.pendingAuditFile,
    approvalEvidenceFile: s.config.approvalEvidenceFile,
    approvalEvidenceKeyFile: s.config.approvalEvidenceKeyFile,
    reconcileFile: s.config.reconcileFile,
    flairUrl,
  };
}

/** A review lister returning a fixed listing (or failure), counting calls. */
export class FakeReviewLister implements GitHubReviewLister {
  calls: Array<{ repo: string; pr: number }> = [];
  constructor(public result: { ok: true; reviews: ExistingReview[] } | { ok: false; detail: string } = { ok: true, reviews: [] }) {}
  async listReviews(repo: string, pr: number) {
    this.calls.push({ repo, pr });
    return this.result;
  }
}

/** A fetch standing in for Flair: answers `status`, records every request. */
export function fakeFlairFetch(status = 200): { fetchImpl: typeof fetch; requests: Array<{ url: string; init: RequestInit }> } {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response("", { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

/** A FakeGitHub whose PR lookup waits until `open()` is called, so a test can
 *  hold one call in flight while a second call for the same dispatch arrives. */
export class GatedGitHub extends FakeGitHub {
  private release: () => void = () => {};
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  open(): void {
    this.release();
  }
  override async fetchPull(repo: string, pr: number) {
    this.fetchPullCalls.push({ repo, pr });
    await this.gate;
    return this.pull;
  }
}

export function validAssignment(overrides: Partial<DispatchAssignment> = {}): DispatchAssignment {
  return {
    sessionKey: "sess-1",
    reviewer: REVIEWER,
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

/** A real Ed25519 key written as base64 PKCS8 DER, returning the public key so a
 *  test can verify a signature the sink produced. */
export function writeEd25519Key(path: string): KeyObject {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  writeFileSync(path, der, { mode: 0o600 });
  return publicKey;
}

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
    permissions: { pull_requests: "write", contents: "none", metadata: "read" },
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
  /** The host key that authenticates the approval-evidence records. */
  approvalKey: Buffer;
}

/** Write a fresh 32-byte host key as base64, returning its bytes. */
export function writeHostKey(path: string): Buffer {
  const key = randomBytes(32);
  writeFileSync(path, key.toString("base64"), { mode: 0o600 });
  return key;
}

/** The standard, fully-valid host configuration for a test. */
export function scenario(
  root: string,
  configOverrides: Record<string, unknown> = {},
  credOpts: Parameters<typeof fakeCredentialFiles>[1] = {},
): Scenario {
  ensureDir(root);
  const files = fakeCredentialFiles(root, credOpts);
  const signingKeyFile = join(root, "anvil.key");
  writeEd25519Key(signingKeyFile);
  const approvalEvidenceKeyFile = join(root, "approval-evidence.key");
  const approvalKey = writeHostKey(approvalEvidenceKeyFile);
  const config = resolveConfig(
    {
      allowedRepositories: [REPO],
      maxBodyBytes: 65_536,
      credentialFile: files.credentialFile,
      provisioningFile: files.provisioningFile,
      signingKeyFile,
      reviewerIdentity: REVIEWER,
      pendingAuditFile: join(root, "pending.json"),
      reconcileFile: join(root, "reconcile.json"),
      approvalEvidenceFile: join(root, "approval-evidence.json"),
      approvalEvidenceKeyFile,
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
  // The host has recorded a passing review build for the standard dispatch,
  // session and commit. A test overrides this file (or removes the config keys)
  // to exercise the APPROVE evidence gate.
  recordEvidence({ config, approvalKey });
  return { config, custody, approvalKey };
}

/** Write a passing, host-signed evidence record for one dispatch (the standard
 *  dispatch by default). */
export function recordEvidence({
  config,
  approvalKey,
  dispatchId = "dispatch-1",
}: {
  config: GithubReviewConfig;
  approvalKey: Buffer;
  dispatchId?: string;
}): void {
  if (!config.approvalEvidenceFile || !config.approvalEvidenceKeyFile) return;
  writeApprovalEvidence(
    config.approvalEvidenceFile,
    buildApprovalEvidence(
      {
        repo: REPO,
        pr: PR,
        dispatchId,
        reviewer: REVIEWER,
        sessionKey: "sess-1",
        commit: COMMIT,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        finishedAt: new Date().toISOString(),
        commands: [
          { command: "bun run build", role: "build", exitCode: 0 },
          { command: "bun run test", role: "test", exitCode: 0 },
        ],
      },
      approvalKey,
    ),
  );
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

/** Build handler deps wired to the standard fakes. Host log lines the handler
 *  writes are collected in `logs`. */
export function makeDeps(
  s: Scenario,
  services: HandlerServices = {},
): { deps: HandlerDeps; github: FakeGitHub; audit: FakeAudit; logs: string[] } {
  const github = (services.github as FakeGitHub | undefined) ?? new FakeGitHub();
  const audit = (services.audit as FakeAudit | undefined) ?? new FakeAudit();
  const logs: string[] = [];
  const deps = buildDeps(s.config, s.custody, {
    assignments: resolver([validAssignment()]),
    log: (line) => logs.push(line),
    ...services,
    github,
    audit,
  });
  return { deps, github, audit, logs };
}
