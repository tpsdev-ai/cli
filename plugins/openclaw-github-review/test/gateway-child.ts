/**
 * gateway-child.ts (test fixture) — runs ONE github_review call in its OWN
 * process against the real file stores (the real FileReconcileStore and its
 * lock), so the parent test can check what real processes do:
 *
 *   crash-before-post — SIGKILL after the durable claim, before the review
 *                       request leaves (nothing is recorded in the POST log);
 *   crash-after-post  — SIGKILL after the review request left (recorded in
 *                       the POST log), while the `posted` write starts;
 *   race              — wait for the go-file, then run the call; with
 *                       `widenMs`, sleep that long inside the store's
 *                       read-modify-write (before its temp file is created),
 *                       so two processes that were NOT serialized by the store
 *                       lock would both read "no entry" and both post;
 *   hold              — create the in-post file when the POST starts, then wait
 *                       for the release file before answering 200.
 *
 * Every POST is appended to the shared POST log. The outcome is printed as
 * JSON unless the process was killed.
 *
 * usage: bun test/gateway-child.ts <spec.json>
 */
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { FileReconcileStore } from "../src/audit.js";
import { resolveConfig } from "../src/config.js";
import { CredentialCustody } from "../src/credential.js";
import { runGithubReview } from "../src/handler.js";
import { buildDeps } from "../src/index.js";
import { FakeAudit, FakeGitHub, resolver, session, validAssignment, validInput } from "./helpers.js";

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  pluginConfig: Record<string, unknown>;
  mode: "crash-before-post" | "crash-after-post" | "race" | "hold";
  postLog: string;
  goFile?: string;
  widenMs?: number;
  inPostFile?: string;
  releaseFile?: string;
};

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function crash(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
}

const config = resolveConfig(spec.pluginConfig, "0.1.0-test");

if (spec.widenMs) {
  // Widen every latch-store read-modify-write: sleep just before its temp file
  // is created, i.e. between the store's read and its write.
  const realOpen = fs.openSync.bind(fs);
  const storeTmp = `${config.reconcileFile}.`;
  spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
    const path = String(p);
    if (path.startsWith(storeTmp) && path.endsWith(".tmp")) sleep(spec.widenMs!);
    return realOpen(p, flags ?? "r", mode);
  }) as typeof fs.openSync);
}

class ChildGitHub extends FakeGitHub {
  override async createReview(input: Parameters<FakeGitHub["createReview"]>[0]) {
    if (spec.mode === "crash-before-post") crash();
    appendFileSync(spec.postLog, `${JSON.stringify({ pid: process.pid, ...input })}\n`);
    if (spec.mode === "hold") {
      writeFileSync(spec.inPostFile!, String(process.pid));
      while (!existsSync(spec.releaseFile!)) sleep(20);
    }
    return super.createReview(input);
  }
}

class CrashOnPostedStore extends FileReconcileStore {
  override settle(...args: Parameters<FileReconcileStore["settle"]>): void {
    if (args[2] === "posted" && spec.mode === "crash-after-post") crash();
    super.settle(...args);
  }
}

if (spec.mode === "race") {
  while (!existsSync(spec.goFile!)) sleep(5);
}

const { custody } = CredentialCustody.load({
  credentialFile: config.credentialFile,
  provisioningFile: config.provisioningFile,
  maxAgeDays: config.provisioningMaxAgeDays,
  clock: () => new Date(),
});
const deps = buildDeps(config, custody, {
  assignments: resolver([validAssignment()]),
  github: new ChildGitHub(),
  audit: new FakeAudit(),
  reconcile: new CrashOnPostedStore(config.reconcileFile!),
});
const outcome = await runGithubReview(validInput(), session(), deps);
console.log(JSON.stringify(outcome));
