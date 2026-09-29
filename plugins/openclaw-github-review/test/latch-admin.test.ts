/**
 * latch-admin.test.ts — the HOST's commands for the dispatch latch store.
 * `clear` never changes the store (a `posted` latch is final; the others need
 * `reconcile`). `reconcile` verifies the credential, checks GitHub for the
 * dispatch's review, RECORDS the result (a signed Flair OrgEvent, or a local
 * audit line when Flair does not acknowledge) and only then latches `posted`
 * or releases. Any failure before the record leaves the store unchanged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileReconcileStore } from "../src/audit.js";
import { runLatchAdmin } from "../src/latch-admin.js";
import type { ExistingReview } from "../src/types.js";
import { COMMIT, FakeReviewLister, fakeFlairFetch, PR, pluginConfigOf, REPO, scenario, TOKEN, type Scenario } from "./helpers.js";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOGIN = "anvil-reviewer";
const OTHER = "b".repeat(40);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gr-latch-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function run(argv: string[], deps: Parameters<typeof runLatchAdmin>[3] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runLatchAdmin(argv, (l) => out.push(l), (l) => err.push(l), deps);
  return { code, out, err };
}

const details = { repo: REPO, pr: PR, commit: COMMIT, login: LOGIN, reservedAt: "2026-09-28T00:00:00.000Z" };

/** A host with a latch store holding `latch` for d-1, and its plugin config file. */
function host(latch: "reserved" | "reconcile_required" | "posted", extra: { reviewId?: number } = {}) {
  const s = scenario(root);
  const store = new FileReconcileStore(s.config.reconcileFile!);
  store.add("d-1", latch, { ...details, ...extra });
  const configFile = join(root, "plugin-config.json");
  writeFileSync(configFile, JSON.stringify(pluginConfigOf(s)), { mode: 0o600 });
  return { s, store, configFile, before: readFileSync(s.config.reconcileFile!, "utf8") };
}

const review = (over: Partial<ExistingReview> = {}): ExistingReview => ({
  id: 77,
  login: LOGIN,
  commitId: COMMIT,
  state: "APPROVED",
  url: "https://example.test/r/77",
  ...over,
});

describe("latch-admin list / clear", () => {
  test("list shows every latch with its attempt", async () => {
    const { s } = host("reserved");
    new FileReconcileStore(s.config.reconcileFile!).add("d-2", "posted", details);
    expect((await run(["list", s.config.reconcileFile!])).out).toEqual([
      `d-1\treserved\t${REPO}#${PR}\t${COMMIT}`,
      `d-2\tposted\t${REPO}#${PR}\t${COMMIT}`,
    ]);
  });

  for (const latch of ["posted", "reserved", "reconcile_required"] as const) {
    test(`clear REFUSES a ${latch} latch and changes nothing`, async () => {
      const { s, before } = host(latch);
      const r = await run(["clear", s.config.reconcileFile!, "d-1"]);
      expect(r.code).toBe(1);
      expect(r.err[0]).toContain(latch === "posted" ? "final" : "latch-admin reconcile");
      expect(readFileSync(s.config.reconcileFile!, "utf8")).toBe(before);
    });
  }

  test("bad usage exits 2 and changes nothing", async () => {
    const file = join(root, "reconcile.json");
    for (const argv of [[], ["clear", file], ["list"], ["drop", file, "d-1"], ["reconcile", file], ["reconcile", file, "d-1", "--nope", "x"]]) {
      expect((await run(argv)).code).toBe(2);
    }
    expect(existsSync(file)).toBe(false);
  });
});

describe("latch-admin reconcile — audited, and releases only when no review exists", () => {
  test("a posted latch is REFUSED: final, unchanged, nothing requested", async () => {
    const { s, configFile, before } = host("posted");
    const lister = new FakeReviewLister();
    const flair = fakeFlairFetch(200);
    const r = await run(["reconcile", configFile, "d-1"], { lister, fetchImpl: flair.fetchImpl });
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("final");
    expect(lister.calls.length + flair.requests.length).toBe(0);
    expect(readFileSync(s.config.reconcileFile!, "utf8")).toBe(before);
  });

  test("no review for the dispatch: a signed pr_review_reconciled OrgEvent is acknowledged, THEN the dispatch is released", async () => {
    const { s, configFile } = host("reserved");
    const lister = new FakeReviewLister({ ok: true, reviews: [review({ login: "someone-else" }), review({ id: 78, commitId: OTHER })] });
    const flair = fakeFlairFetch(200);
    const r = await run(["reconcile", configFile, "d-1"], { lister, fetchImpl: flair.fetchImpl, newId: () => "evt-r1" });
    expect(r.code).toBe(0);
    expect(lister.calls).toEqual([{ repo: REPO, pr: PR }]);
    expect(r.out[0]).toContain("released");
    expect(r.out[1]).toContain("signed Flair OrgEvent evt-r1");
    expect(new FileReconcileStore(s.config.reconcileFile!).get("d-1")).toBeNull();

    expect(flair.requests.length).toBe(1);
    const event = JSON.parse(String(flair.requests[0]!.init.body)) as { id: string; kind: string; authorId: string; detail: string };
    expect(event).toMatchObject({ id: "evt-r1", kind: "pr_review_reconciled", authorId: "anvil" });
    expect(JSON.parse(event.detail)).toMatchObject({
      dispatch_id: "d-1",
      latch_before: "reserved",
      review_exists: false,
      action: "released",
      reviews_listed: 2,
      actor: "host:latch-admin",
    });
    const auth = (flair.requests[0]!.init.headers as Record<string, string>).Authorization!;
    expect(auth.startsWith("TPS-Ed25519 anvil:")).toBe(true);
    expect(JSON.stringify(flair.requests)).not.toContain(TOKEN);
  });

  test("the dispatch's review exists (its login, its commit): recorded, then latched POSTED — never released", async () => {
    const { s, configFile } = host("reserved");
    const flair = fakeFlairFetch(200);
    const r = await run(["reconcile", configFile, "d-1"], { lister: new FakeReviewLister({ ok: true, reviews: [review()] }), fetchImpl: flair.fetchImpl });
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("latched posted");
    expect(new FileReconcileStore(s.config.reconcileFile!).entry("d-1")).toMatchObject({ latch: "posted", reviewId: 77 });
    expect(JSON.parse((JSON.parse(String(flair.requests[0]!.init.body)) as { detail: string }).detail)).toMatchObject({
      review_exists: true,
      action: "latched_posted",
      matching_reviews: [{ id: 77, state: "APPROVED", url: "https://example.test/r/77" }],
    });
  });

  test("a reconcile_required latch whose receipt id matches a review on ANOTHER commit is latched posted", async () => {
    const { s, configFile } = host("reconcile_required", { reviewId: 91 });
    const r = await run(["reconcile", configFile, "d-1"], {
      lister: new FakeReviewLister({ ok: true, reviews: [review({ id: 91, commitId: OTHER })] }),
      fetchImpl: fakeFlairFetch(200).fetchImpl,
    });
    expect(r.code).toBe(0);
    expect(new FileReconcileStore(s.config.reconcileFile!).get("d-1")).toBe("posted");
  });

  test("Flair does not acknowledge: the result goes to the LOCAL audit log, the output says so, then the dispatch is released", async () => {
    const { s, configFile } = host("reserved");
    const auditLog = join(root, "latch-audit.jsonl");
    const r = await run(["reconcile", configFile, "d-1", "--audit-log", auditLog], {
      lister: new FakeReviewLister(),
      fetchImpl: fakeFlairFetch(503).fetchImpl,
      newId: () => "evt-local",
    });
    expect(r.code).toBe(0);
    expect(r.out[1]).toContain("Flair did not acknowledge");
    expect(r.out[1]).toContain(`local audit log ${auditLog}`);
    const lines = readFileSync(auditLog, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const line = JSON.parse(lines[0]!) as { flair_failure: string; event: { id: string; kind: string; detail: string } };
    expect(line.flair_failure).toContain("503");
    expect(line.event).toMatchObject({ id: "evt-local", kind: "pr_review_reconciled" });
    expect(JSON.parse(line.event.detail)).toMatchObject({ review_exists: false, action: "released" });
    expect(new FileReconcileStore(s.config.reconcileFile!).get("d-1")).toBeNull();
  });

  test("neither Flair nor the local audit log can record it: NOTHING changes", async () => {
    const { s, configFile, before } = host("reserved");
    const r = await run(["reconcile", configFile, "d-1", "--audit-log", join(root, "no-such-dir", "audit.jsonl")], {
      lister: new FakeReviewLister(),
      fetchImpl: fakeFlairFetch(503).fetchImpl,
    });
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("nothing changed");
    expect(readFileSync(s.config.reconcileFile!, "utf8")).toBe(before);
  });

  test("an incomplete review listing: NOTHING changes and nothing is recorded", async () => {
    const { s, configFile, before } = host("reserved");
    const flair = fakeFlairFetch(200);
    const r = await run(["reconcile", configFile, "d-1"], {
      lister: new FakeReviewLister({ ok: false, detail: "review listing returned status 502" }),
      fetchImpl: flair.fetchImpl,
    });
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("could not determine");
    expect(flair.requests.length).toBe(0);
    expect(readFileSync(s.config.reconcileFile!, "utf8")).toBe(before);
  });

  test("an unusable credential or one that does not cover the repository: nothing requested, nothing changed", async () => {
    const check = async (mutate: (s: Scenario) => void, expected: string) => {
      const { s, configFile, before } = host("reserved");
      mutate(s);
      const lister = new FakeReviewLister();
      const r = await run(["reconcile", configFile, "d-1"], { lister, fetchImpl: fakeFlairFetch(200).fetchImpl });
      expect(r.code).toBe(1);
      expect(r.err[0]).toContain(expected);
      expect(lister.calls.length).toBe(0);
      expect(readFileSync(s.config.reconcileFile!, "utf8")).toBe(before);
      rmSync(root, { recursive: true, force: true });
      root = mkdtempSync(join(tmpdir(), "gr-latch-"));
    };
    await check((s) => rmSync(s.config.credentialFile!), "not usable");
    await check((s) => {
      const evidence = JSON.parse(readFileSync(s.config.provisioningFile!, "utf8")) as Record<string, unknown>;
      writeFileSync(s.config.provisioningFile!, JSON.stringify({ ...evidence, repositories: ["someone/else"] }));
    }, "does not cover");
  });

  test("the BUILT command runs under node: list, and clear refusing a posted latch", () => {
    const entry = join(pluginRoot, "dist", "src", "latch-admin.js");
    expect(existsSync(entry)).toBe(true);
    const file = join(root, "reconcile.json");
    new FileReconcileStore(file).add("d-9", "posted", details);
    const listed = spawnSync("node", [entry, "list", file], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    expect(listed.status).toBe(0);
    expect(listed.stdout.trim()).toBe(`d-9\tposted\t${REPO}#${PR}\t${COMMIT}`);
    const cleared = spawnSync("node", [entry, "clear", file, "d-9"], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    expect(cleared.status).toBe(1);
    expect(new FileReconcileStore(file).get("d-9")).toBe("posted");
  });
});

describe("the reconciliation event is signed by the reviewer key", () => {
  test("its Ed25519 signature verifies over the sink's payload", async () => {
    const { s, configFile } = host("reserved");
    const flair = fakeFlairFetch(200);
    await run(["reconcile", configFile, "d-1"], { lister: new FakeReviewLister(), fetchImpl: flair.fetchImpl });
    const { createPublicKey, createPrivateKey } = await import("node:crypto");
    const der = Buffer.from(readFileSync(s.config.signingKeyFile!, "utf8").trim(), "base64");
    const publicKey = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
    const m = /^TPS-Ed25519 (\S+):(\d+):([^:]+):(.+)$/.exec((flair.requests[0]!.init.headers as Record<string, string>).Authorization!);
    expect(m).not.toBeNull();
    expect(verify(null, Buffer.from(`${m![1]}:${m![2]}:${m![3]}:POST:/OrgEvent/`), publicKey, Buffer.from(m![4]!, "base64"))).toBe(true);
  });
});
