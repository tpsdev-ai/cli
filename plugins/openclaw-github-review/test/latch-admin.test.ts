/**
 * latch-admin.test.ts — the HOST's commands for the dispatch latch store.
 * `clear` never changes the store. `reconcile` refuses while the gateway's
 * claim is held (and `--stale-claim` while its process is alive here), refuses
 * a recent attempt, requires the credential and login that made the attempt,
 * and NEVER RELEASES: it latches `posted` only when the attempt's RECORDED
 * receipt id is listed, and otherwise leaves the entry latched and prints the
 * fresh-dispatch remedy. It RECORDS the decision (a signed Flair OrgEvent, or
 * a durable local audit line when Flair does not acknowledge) before changing
 * anything, and applies it only if the entry is unchanged.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileReconcileStore } from "../src/audit.js";
import { decideReconciliation, RECONCILE_MIN_AGE_MS, runLatchAdmin } from "../src/latch-admin.js";
import type { ExistingReview, LatchRecord } from "../src/types.js";
import { COMMIT, fakeCredentialFiles, FakeReviewLister, fakeFlairFetch, PR, pluginConfigOf, REPO, scenario, TOKEN } from "./helpers.js";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOGIN = "anvil-reviewer";
const OTHER = "b".repeat(40);
// The attempt was reserved an hour ago; commands run on the real clock (the
// credential's provisioning evidence is checked against it too).
const LATER = new Date();
const RESERVED_AT = new Date(LATER.getTime() - RECONCILE_MIN_AGE_MS - 50 * 60_000).toISOString();

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

/** A host with a latch store holding `latch` for d-1 (the attempt made with
 *  this scenario's credential), and its plugin config file. */
function host(latch: "reserved" | "reconcile_required" | "posted", extra: Partial<LatchRecord> = {}) {
  const s = scenario(root);
  const store = new FileReconcileStore(s.config.reconcileFile!);
  store.put({
    dispatchId: "d-1",
    latch,
    repo: REPO,
    pr: PR,
    commit: COMMIT,
    login: LOGIN,
    credentialSha256: s.custody.bindingSha256()!,
    reservedAt: RESERVED_AT,
    ...extra,
  });
  const configFile = join(root, "plugin-config.json");
  writeFileSync(configFile, JSON.stringify(pluginConfigOf(s)), { mode: 0o600 });
  return { s, store, configFile, before: () => readFileSync(s.config.reconcileFile!, "utf8") };
}

const review = (over: Partial<ExistingReview> = {}): ExistingReview => ({
  id: 77,
  login: LOGIN,
  commitId: COMMIT,
  state: "APPROVED",
  url: "https://example.test/r/77",
  submittedAt: new Date(Date.parse(RESERVED_AT) + 1000).toISOString(),
  ...over,
});

async function reconcile(h: ReturnType<typeof host>, reviews: ExistingReview[], extraArgs: string[] = [], deps: Parameters<typeof runLatchAdmin>[3] = {}) {
  const flair = fakeFlairFetch(200);
  const lister = new FakeReviewLister({ ok: true, reviews });
  const r = await run(["reconcile", h.configFile, "d-1", ...extraArgs], { lister, fetchImpl: flair.fetchImpl, newId: () => "evt-r", ...deps });
  return { ...r, flair, lister };
}

describe("latch-admin list / clear", () => {
  test("list shows every latch with its attempt and claim", async () => {
    const h = host("reserved", { claim: { token: "t", pid: 4242, host: "gw", at: RESERVED_AT } });
    h.store.put({ dispatchId: "d-2", latch: "posted", repo: REPO, pr: PR, commit: COMMIT });
    expect((await run(["list", h.s.config.reconcileFile!])).out).toEqual([
      `d-1\treserved\t${REPO}#${PR}\t${COMMIT}\tclaim held by pid 4242 on gw since ${RESERVED_AT}`,
      `d-2\tposted\t${REPO}#${PR}\t${COMMIT}\t-`,
    ]);
  });

  for (const latch of ["posted", "reserved", "reconcile_required"] as const) {
    test(`clear REFUSES a ${latch} latch and changes nothing`, async () => {
      const h = host(latch);
      const before = h.before();
      const r = await run(["clear", h.s.config.reconcileFile!, "d-1"]);
      expect(r.code).toBe(1);
      expect(r.err[0]).toContain(latch === "posted" ? "final" : "latch-admin reconcile");
      expect(h.before()).toBe(before);
    });
  }

  test("bad usage exits 2 and changes nothing", async () => {
    const file = join(root, "reconcile.json");
    for (const argv of [[], ["clear", file], ["list"], ["drop", file, "d-1"], ["reconcile", file], ["reconcile", file, "d-1", "--nope"], ["reconcile", file, "d-1", "--audit-log"]]) {
      expect((await run(argv)).code).toBe(2);
    }
    expect(existsSync(file)).toBe(false);
  });
});

describe("decideReconciliation — `posted` ONLY on the recorded receipt id; NEVER a release", () => {
  const attempt = {
    dispatchId: "d-1",
    latch: "reserved" as const,
    repo: REPO,
    pr: PR,
    commit: COMMIT,
    login: LOGIN,
    credentialSha256: "f",
    reservedAt: RESERVED_AT,
  };
  const decide = (reviews: ExistingReview[], extra: Partial<typeof attempt & { reviewId: number }> = {}, now = LATER) =>
    decideReconciliation({ ...attempt, ...extra }, reviews, now);

  test("an EMPTY listing keeps the latch — with or without a recorded receipt id", () => {
    expect(decide([]).decision).toBe("retain");
    expect(decide([], { reviewId: 91 }).decision).toBe("retain");
  });
  test("reviews that cannot be the attempt's still keep the latch: an absent review proves nothing", () => {
    const old = new Date(Date.parse(RESERVED_AT) - 3_600_000).toISOString();
    expect(decide([review({ id: 1, login: "someone", commitId: OTHER }), review({ id: 2, commitId: OTHER, submittedAt: old })]).decision).toBe("retain");
  });
  test("a same-login, same-commit review WITHOUT the recorded receipt id is uncertain: the latch stays", () => {
    const d = decide([review()]);
    expect(d.decision).toBe("retain");
    expect(d.reasons.join()).toContain("77");
    // Even with a receipt id recorded, a different id on the commit proves nothing.
    expect(decide([review()], { reviewId: 91 }).decision).toBe("retain");
  });
  test("the RECORDED receipt id in the listing — whatever its login or commit — is the one proof: latch_posted", () => {
    expect(decide([review({ id: 91, login: "someone", commitId: OTHER })], { reviewId: 91 })).toMatchObject({
      decision: "latch_posted",
      matching: [{ id: 91 }],
    });
  });
  test("a recorded receipt id MISSING from the listing keeps the latch, naming the id", () => {
    const d = decide([], { reviewId: 91 });
    expect(d.reasons.join()).toContain("91");
  });
  test("no decision is ever a release", () => {
    const cases: Array<[ExistingReview[], Partial<typeof attempt & { reviewId: number }>]> = [
      [[], {}],
      [[review({ login: "someone-else" })], {}],
      [[review({ state: "PENDING", submittedAt: null })], {}],
      [[review({ commitId: OTHER })], { reviewId: 5 }],
    ];
    for (const [reviews, extra] of cases) expect(decide(reviews, extra).decision).not.toBe("release");
  });
});

describe("latch-admin reconcile — refusals before anything is requested", () => {
  test("a posted latch: final, unchanged, nothing requested", async () => {
    const h = host("posted");
    const before = h.before();
    const r = await reconcile(h, []);
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("final");
    expect(r.lister.calls.length + r.flair.requests.length).toBe(0);
    expect(h.before()).toBe(before);
  });

  test("a HELD claim: refused, naming its pid, host and time; nothing requested", async () => {
    const h = host("reserved", { claim: { token: "t", pid: 4242, host: "gw-other", at: RESERVED_AT } });
    const r = await reconcile(h, []);
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("claim held by pid 4242 on gw-other");
    expect(r.err[0]).toContain("--stale-claim");
    expect(r.lister.calls.length).toBe(0);
  });

  test("--stale-claim with the claiming process ALIVE on this host: refused", async () => {
    const h = host("reserved", { claim: { token: "t", pid: process.pid, host: (await import("node:os")).hostname(), at: RESERVED_AT } });
    const r = await reconcile(h, [], ["--stale-claim"]);
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain(`pid ${process.pid} is still running`);
    expect(r.lister.calls.length).toBe(0);
  });

  test("--stale-claim with the claiming pid alive but not ours to signal (EPERM, pid 1): still refused", async () => {
    const h = host("reserved", { claim: { token: "t", pid: 1, host: (await import("node:os")).hostname(), at: RESERVED_AT } });
    const r = await reconcile(h, [], ["--stale-claim"]);
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("pid 1 is still running");
  });

  test("--stale-claim with the claiming process gone: proceeds, records the override — and the entry STAYS latched", async () => {
    const h = host("reserved", { claim: { token: "t", pid: 4242, host: "gw-other", at: RESERVED_AT } });
    const before = h.before();
    const r = await reconcile(h, [], ["--stale-claim"]);
    expect(r.code).toBe(1);
    const detail = JSON.parse((JSON.parse(String(r.flair.requests[0]!.init.body)) as { detail: string }).detail) as Record<string, unknown>;
    expect(detail.stale_claim_overridden).toMatchObject({ pid: 4242, host: "gw-other" });
    expect(h.before()).toBe(before);
  });

  test("an attempt too recent to reconcile: refused with the time to retry after", async () => {
    const h = host("reserved");
    const r = await reconcile(h, [], [], { clock: () => new Date(Date.parse(RESERVED_AT) + 60_000) });
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("too recent");
    expect(r.lister.calls.length).toBe(0);
  });

  test("a ROTATED credential (different fingerprint): refused as credential_mismatch; nothing requested or changed", async () => {
    const h = host("reserved");
    const before = h.before();
    // Rotate: a new token with matching evidence, at the same paths.
    fakeCredentialFiles(root, { token: `github_pat_11ROTATED${"1".repeat(70)}` });
    const r = await reconcile(h, []);
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("credential_mismatch");
    expect(r.err[0]).toContain("fresh dispatch");
    expect(r.lister.calls.length + r.flair.requests.length).toBe(0);
    expect(h.before()).toBe(before);
  });

  test("the credential's login differs from the attempt's: refused as login_mismatch", async () => {
    const h = host("reserved", { login: "someone-else" });
    const r = await reconcile(h, []);
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("login_mismatch");
    expect(r.lister.calls.length).toBe(0);
  });

  test("a latch without the attempt's details (no credential fingerprint): refused, stays latched", async () => {
    const h = host("reconcile_required", { credentialSha256: undefined });
    const r = await reconcile(h, []);
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("does not record the attempt's details");
  });

  test("an unusable credential or one that does not cover the repository: nothing requested, nothing changed", async () => {
    const h = host("reserved");
    rmSync(h.s.config.credentialFile!);
    expect((await reconcile(h, [])).err[0]).toContain("not usable");
    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "gr-latch-"));
    const h2 = host("reserved");
    const evidence = JSON.parse(readFileSync(h2.s.config.provisioningFile!, "utf8")) as Record<string, unknown>;
    writeFileSync(h2.s.config.provisioningFile!, JSON.stringify({ ...evidence, repositories: ["someone/else"] }));
    const r = await reconcile(h2, []);
    expect(r.err[0]).toContain("does not cover");
    expect(r.lister.calls.length).toBe(0);
  });

  test("an incomplete listing: nothing recorded, nothing changed", async () => {
    const h = host("reserved");
    const before = h.before();
    const flair = fakeFlairFetch(200);
    const r = await run(["reconcile", h.configFile, "d-1"], {
      lister: new FakeReviewLister({ ok: false, detail: "review listing returned status 502" }),
      fetchImpl: flair.fetchImpl,
    });
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("could not determine");
    expect(flair.requests.length).toBe(0);
    expect(h.before()).toBe(before);
  });
});

describe("latch-admin reconcile — decisions, records, application", () => {
  test("an EMPTY listing: the decision is recorded (signed pr_review_reconciled), the entry STAYS latched, and the fresh-dispatch remedy is printed", async () => {
    const h = host("reserved");
    const before = h.before();
    const r = await reconcile(h, []);
    expect(r.code).toBe(1);
    expect(r.lister.calls).toEqual([{ repo: REPO, pr: PR }]);
    expect(r.out[0]).toContain("signed with the reviewer's key");
    expect(r.err[0]).toContain("stays reserved");
    expect(r.err[0]).toContain("FRESH dispatch");
    expect(h.before()).toBe(before);
    const event = JSON.parse(String(r.flair.requests[0]!.init.body)) as { id: string; kind: string; authorId: string; detail: string };
    expect(event).toMatchObject({ id: "evt-r", kind: "pr_review_reconciled", authorId: "anvil" });
    const detail = JSON.parse(event.detail) as Record<string, unknown>;
    expect(detail).toMatchObject({
      dispatch_id: "d-1",
      latch_before: "reserved",
      decision: "retain",
      reviews_listed: 0,
      credential_matches_attempt: true,
      command: "latch-admin reconcile",
    });
    expect(String(detail.signed_with)).toContain("reviewer's Flair signing key");
    expect(detail.invoked_by).toMatchObject({ os_user: expect.any(String), pid: process.pid });
    expect(JSON.stringify(r.flair.requests)).not.toContain(TOKEN);
    expect(JSON.stringify(detail)).not.toContain(h.s.custody.bindingSha256()!);
  });

  test("a same-login, same-commit review WITHOUT the recorded receipt id: the entry STAYS latched, fresh-dispatch remedy printed", async () => {
    for (const latch of ["reserved", "reconcile_required"] as const) {
      rmSync(root, { recursive: true, force: true });
      root = mkdtempSync(join(tmpdir(), "gr-latch-"));
      const h = host(latch);
      const before = h.before();
      const r = await reconcile(h, [review()]);
      expect(r.code).toBe(1);
      expect(r.err[0]).toContain("FRESH dispatch");
      expect(h.before()).toBe(before);
    }
  });

  test("a review by ANOTHER login on the attempt's commit: the entry STAYS latched", async () => {
    const h = host("reserved");
    const before = h.before();
    const r = await reconcile(h, [review({ login: "someone-else" })]);
    expect(r.code).toBe(1);
    expect(h.before()).toBe(before);
    expect(JSON.parse((JSON.parse(String(r.flair.requests[0]!.init.body)) as { detail: string }).detail)).toMatchObject({ decision: "retain" });
  });

  test("the RECORDED receipt id is listed: recorded, then latched POSTED", async () => {
    const h = host("reconcile_required", { reviewId: 77 });
    const r = await reconcile(h, [review()]);
    expect(r.code).toBe(0);
    expect(r.out[1]).toContain("latched posted");
    expect(h.store.entry("d-1")).toMatchObject({ latch: "posted", reviewId: 77 });
  });

  test("Flair does not acknowledge: the decision goes to the LOCAL audit log (file AND directory fsync'ed) BEFORE the latch changes", async () => {
    const h = host("reconcile_required", { reviewId: 77 });
    const auditLog = join(root, "latch-audit.jsonl");
    const steps: string[] = [];
    const realOpen = fs.openSync.bind(fs);
    const realFsync = fs.fsyncSync.bind(fs);
    const realRename = fs.renameSync.bind(fs);
    const paths = new Map<number, string>();
    const open = spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, f?: fs.OpenMode, m?: fs.Mode) => {
      const fd = realOpen(p, f ?? "r", m);
      paths.set(fd, String(p));
      return fd;
    }) as typeof fs.openSync);
    const fsync = spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
      const p = paths.get(fd);
      if (p === auditLog) steps.push("fsync audit log");
      else if (p === root) steps.push("fsync audit dir");
      realFsync(fd);
    }) as typeof fs.fsyncSync);
    const rename = spyOn(fs, "renameSync").mockImplementation(((a: fs.PathLike, b: fs.PathLike) => {
      if (String(b) === h.s.config.reconcileFile) steps.push("replace latch store");
      realRename(a, b);
    }) as typeof fs.renameSync);
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run(["reconcile", h.configFile, "d-1", "--audit-log", auditLog], {
        lister: new FakeReviewLister({ ok: true, reviews: [review()] }),
        fetchImpl: fakeFlairFetch(503).fetchImpl,
        newId: () => "evt-local",
      });
    } finally {
      open.mockRestore();
      fsync.mockRestore();
      rename.mockRestore();
    }
    expect(r.code).toBe(0);
    expect(steps.slice(0, 3)).toEqual(["fsync audit log", "fsync audit dir", "replace latch store"]);
    expect(r.out[0]).toContain("Flair did not acknowledge");
    expect(r.out[0]).toContain(`local audit log ${auditLog}`);
    const line = JSON.parse(readFileSync(auditLog, "utf8").trim()) as { flair_failure: string; event: { id: string; kind: string; detail: string } };
    expect(line.flair_failure).toContain("503");
    expect(line.event).toMatchObject({ id: "evt-local", kind: "pr_review_reconciled" });
    expect(h.store.get("d-1")).toBe("posted");
  });

  test("neither Flair nor the local audit log can record it: NOTHING changes — even when the recorded receipt id is listed", async () => {
    const h = host("reconcile_required", { reviewId: 77 });
    const before = h.before();
    const r = await run(["reconcile", h.configFile, "d-1", "--audit-log", join(root, "no-such-dir", "audit.jsonl")], {
      lister: new FakeReviewLister({ ok: true, reviews: [review()] }),
      fetchImpl: fakeFlairFetch(503).fetchImpl,
    });
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("nothing changed");
    expect(h.before()).toBe(before);
  });

  test("the entry CHANGED between the check and the apply: recorded, NOT applied", async () => {
    const h = host("reconcile_required", { reviewId: 77 });
    class ChangingLister extends FakeReviewLister {
      override async listReviews(repo: string, pr: number) {
        h.store.put({ ...h.store.entry("d-1")!, login: "changed" });
        return super.listReviews(repo, pr);
      }
    }
    const r = await run(["reconcile", h.configFile, "d-1"], {
      lister: new ChangingLister({ ok: true, reviews: [review()] }),
      fetchImpl: fakeFlairFetch(200).fetchImpl,
    });
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("NOT applied");
    expect(h.store.get("d-1")).toBe("reconcile_required");
  });

  test("a stale store lock at apply time: recorded, nothing changed, the lock path and remedy printed", async () => {
    const h = host("reconcile_required", { reviewId: 77 });
    const lock = `${h.s.config.reconcileFile!}.lock`;
    class LockingLister extends FakeReviewLister {
      override async listReviews(repo: string, pr: number) {
        writeFileSync(lock, JSON.stringify({ pid: 1, host: "x", since: "t", op: "reserve", token: "z" }));
        return super.listReviews(repo, pr);
      }
    }
    const r = await run(["reconcile", h.configFile, "d-1"], {
      lister: new LockingLister({ ok: true, reviews: [review()] }),
      fetchImpl: fakeFlairFetch(200).fetchImpl,
    });
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain(lock);
    expect(r.err[0]).toContain("remove");
    expect(h.store.get("d-1")).toBe("reconcile_required");
  });

  test("the reconciliation event's Ed25519 signature verifies with the REVIEWER's key", async () => {
    const h = host("reserved");
    const r = await reconcile(h, []);
    const der = Buffer.from(readFileSync(h.s.config.signingKeyFile!, "utf8").trim(), "base64");
    const publicKey = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
    const m = /^TPS-Ed25519 (\S+):(\d+):([^:]+):(.+)$/.exec((r.flair.requests[0]!.init.headers as Record<string, string>).Authorization!);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("anvil");
    expect(verify(null, Buffer.from(`${m![1]}:${m![2]}:${m![3]}:POST:/OrgEvent/`), publicKey, Buffer.from(m![4]!, "base64"))).toBe(true);
  });

  test("the BUILT command runs under node: list, and clear refusing a posted latch", () => {
    const entry = join(pluginRoot, "dist", "src", "latch-admin.js");
    expect(existsSync(entry)).toBe(true);
    const file = join(root, "reconcile.json");
    new FileReconcileStore(file).put({ dispatchId: "d-9", latch: "posted", repo: REPO, pr: PR, commit: COMMIT });
    const listed = spawnSync("node", [entry, "list", file], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    expect(listed.status).toBe(0);
    expect(listed.stdout.trim()).toBe(`d-9\tposted\t${REPO}#${PR}\t${COMMIT}\t-`);
    const cleared = spawnSync("node", [entry, "clear", file, "d-9"], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    expect(cleared.status).toBe(1);
    expect(new FileReconcileStore(file).get("d-9")).toBe("posted");
  });
});
