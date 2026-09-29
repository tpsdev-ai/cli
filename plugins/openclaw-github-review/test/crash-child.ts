/**
 * crash-child.ts (test fixture) — runs ONE github_review call in its own
 * process against the real file stores, and kills that process with SIGKILL
 * at the injected point, so the parent test (audit-outcomes.test.ts) can check
 * what a real crash leaves behind:
 *
 *   before-post — after the durable reservation, before the review request
 *                 leaves (nothing is recorded in the POST log);
 *   after-post  — after the review request left (recorded in the POST log),
 *                 while the `posted` latch is being written.
 *
 * usage: bun test/crash-child.ts <spec.json>   (prints the outcome only if it did NOT crash)
 */
import { appendFileSync, readFileSync } from "node:fs";
import { FileReconcileStore } from "../src/audit.js";
import { resolveConfig } from "../src/config.js";
import { CredentialCustody } from "../src/credential.js";
import { runGithubReview } from "../src/handler.js";
import { buildDeps } from "../src/index.js";
import type { DispatchLatch, LatchDetails } from "../src/types.js";
import { FakeAudit, FakeGitHub, resolver, session, validAssignment, validInput } from "./helpers.js";

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  pluginConfig: Record<string, unknown>;
  crashAt: "before-post" | "after-post";
  postLog: string;
};

function crash(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
}

class CrashingGitHub extends FakeGitHub {
  override async createReview(input: Parameters<FakeGitHub["createReview"]>[0]) {
    if (spec.crashAt === "before-post") crash();
    appendFileSync(spec.postLog, `${JSON.stringify(input)}\n`);
    return super.createReview(input);
  }
}

class CrashOnPostedStore extends FileReconcileStore {
  override add(dispatchId: string, latch: DispatchLatch, details?: Partial<LatchDetails>): void {
    if (latch === "posted" && spec.crashAt === "after-post") crash();
    super.add(dispatchId, latch, details);
  }
}

const config = resolveConfig(spec.pluginConfig, "0.1.0-test");
const { custody } = CredentialCustody.load({
  credentialFile: config.credentialFile,
  provisioningFile: config.provisioningFile,
  maxAgeDays: config.provisioningMaxAgeDays,
  clock: () => new Date(),
});
const deps = buildDeps(config, custody, {
  assignments: resolver([validAssignment()]),
  github: new CrashingGitHub(),
  audit: new FakeAudit(),
  reconcile: new CrashOnPostedStore(config.reconcileFile!),
});
const outcome = await runGithubReview(validInput(), session(), deps);
console.log(JSON.stringify(outcome));
