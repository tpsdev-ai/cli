import { createPatchShared } from "./helpers/patch-shared.js";
const patchShared = createPatchShared();
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import * as fs from "node:fs";
import { createHmac, createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { drainOutbox } from "../src/utils/outbox.js";
import * as mailLock from "../src/utils/mail-lock.js";
import { handleGithubWebhook, processGithubWebhookEvent } from "../src/utils/github-webhook.js";

afterEach(() => {
  mock.restore();
});

async function post(
  headers: Record<string, string>,
  body: string,
  deps?: Parameters<typeof handleGithubWebhook>[2],
): Promise<{ status: number; text: string }> {
  const req = new PassThrough() as PassThrough & { headers: Record<string, string> };
  req.headers = headers;
  let text = "";
  const res = {
    statusCode: 200,
    end(chunk?: string) {
      text = chunk ?? "";
    },
  } as { statusCode: number; end: (chunk?: string) => void };

  const pending = handleGithubWebhook(req as any, res as any, deps);
  req.end(body);
  await pending;
  return { status: res.statusCode, text };
}

describe("handleGithubWebhook", () => {
  let root: string;
  const originalHome = process.env.HOME;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-gh-webhook-"));
    process.env.HOME = root;
    process.env.GITHUB_WEBHOOK_TARGET = "host";
    process.env.GITHUB_WEBHOOK_AGENT_ID = "webhook-agent";
    process.env.GITHUB_WEBHOOK_SECRET = "testsecret";
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    delete process.env.GITHUB_WEBHOOK_AGENT_ID;
    delete process.env.GITHUB_WEBHOOK_TARGET;
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

  test("returns 503 when secret is not set", async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const r = await post({
      "content-type": "application/json",
      "x-github-event": "push",
    }, JSON.stringify({ repository: { full_name: "a/b" } }));

    expect(r.status).toBe(503);
    process.env.GITHUB_WEBHOOK_SECRET = "testsecret";
  });

  test("returns 401 on invalid signature", async () => {
    const r = await post({
      "content-type": "application/json",
      "x-github-event": "push",
      "x-hub-signature-256": "sha256=bad",
    }, JSON.stringify({ repository: { full_name: "a/b" } }));

    expect(r.status).toBe(401);
  });

  test("returns 200 and queues push event", async () => {
    const payload = JSON.stringify({
      ref: "refs/heads/main",
      after: "abc12345def",
      commits: [{}, {}],
      pusher: { name: "nathan" },
      repository: { full_name: "tpsdev-ai/tps" },
    });
    const sig = `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}`;

    const r = await post({
      "content-type": "application/json",
      "x-github-event": "push",
      "x-hub-signature-256": sig,
    }, payload);

    expect(r.status).toBe(200);

    const outDir = join(root, ".tps", "outbox", "new");
    const files = readdirSync(outDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const row = JSON.parse(readFileSync(join(outDir, files[0]!), "utf-8"));
    expect(row.to).toBe("host");
    expect(String(row.body)).toContain("push");
  });

  test("processGithubWebhookEvent: re-requests dismissed reviewer and publishes OrgEvent", async () => {
    const ghCalls: Array<{ cmd: string; args: string[]; input?: string }> = [];
    const published: Array<{ summary: string; detail: string; refId: string; targetIds: string[] }> = [];
    process.env.GITHUB_WEBHOOK_AGENT_ID = "ember";

    await processGithubWebhookEvent("pull_request_review", {
      action: "dismissed",
      repository: { full_name: "tpsdev-ai/cli" },
      pull_request: { number: 144, html_url: "https://github.com/tpsdev-ai/cli/pull/144" },
      review: { user: { login: "tps-kern" } },
    }, {
      reviewRequestDeps: {
        spawnSyncImpl: ((cmd: string, args: string[], opts?: { input?: string }) => {
          ghCalls.push({ cmd, args, input: opts?.input });
          return { status: 0, stdout: "", stderr: "" } as any;
        }) as any,
      },
      publishReviewRerequestedEvent: async (event) => {
        published.push(event);
      },
    });

    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]?.cmd).toBe("gh-as");
    expect(ghCalls[0]?.args).toEqual([
      "ember",
      "api",
      "--method",
      "POST",
      "repos/tpsdev-ai/cli/pulls/144/requested_reviewers",
      "--input",
      "-",
    ]);
    expect(ghCalls[0]?.input).toBe(JSON.stringify({ reviewers: ["tps-kern"] }));
    expect(published).toEqual([{
      summary: "Re-requested review from tps-kern on PR #144",
      detail: "https://github.com/tpsdev-ai/cli/pull/144",
      refId: "tpsdev-ai/cli#144",
      targetIds: ["tps-kern"],
    }]);

    delete process.env.GITHUB_WEBHOOK_AGENT_ID;
  });
  test("returns 200 for dismissed review webhook and keeps outbox behavior", async () => {
    const published: Array<{ summary: string; detail: string; refId: string; targetIds: string[] }> = [];
    const payload = JSON.stringify({
      action: "dismissed",
      repository: { full_name: "tpsdev-ai/cli" },
      pull_request: { number: 145, title: "Fix review rerequest flow", user: { login: "ember" }, html_url: "https://github.com/tpsdev-ai/cli/pull/145" },
      review: { user: { login: "tps-sherlock" } },
    });
    const sig = `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}`;
    const r = await post({
      "content-type": "application/json",
      "x-github-event": "pull_request_review",
      "x-hub-signature-256": sig,
    }, payload, {
      reviewRequestDeps: {
        spawnSyncImpl: ((_: string, __: string[], ___?: { input?: string }) => ({ status: 0, stdout: "", stderr: "" })) as any,
      },
      publishReviewRerequestedEvent: async (event) => {
        published.push(event);
      },
    });
    expect(r.status).toBe(200);
    const outDir = join(root, ".tps", "outbox", "new");
    const files = readdirSync(outDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const row = JSON.parse(readFileSync(join(outDir, files[0]!), "utf-8"));
    expect(String(row.body)).toContain("pull_request_review");
    expect(published).toHaveLength(1);
  });
  for (const id of [undefined, "   "]) {
    test(`missing webhook agent ${JSON.stringify(id)} refuses without enqueue on redelivery`, async () => {
      if (id === undefined) delete process.env.GITHUB_WEBHOOK_AGENT_ID; else process.env.GITHUB_WEBHOOK_AGENT_ID = id;
      const payload = JSON.stringify({ action: "dismissed", repository: { full_name: "example/repo" },
        pull_request: { number: 42 }, review: { user: { login: "reviewer" } } });
      const headers = { "x-github-event": "pull_request_review", "x-github-delivery": "delivery-refused",
        "x-hub-signature-256": `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}` };
      let calls = 0;
      const deps = { reviewRequestDeps: { spawnSyncImpl: (() => { calls++; }) as any },
        publishReviewRerequestedEvent: async () => { calls++; } };
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await post(headers, payload, deps)).toEqual({ status: 503, text: "GITHUB_WEBHOOK_AGENT_ID env var required" });
      }
      expect(calls).toBe(0);
      expect(existsSync(join(root, ".tps", "outbox"))).toBe(false);
    });
  }
  test("redelivery enqueues once and re-requests once, including after outbox drain", async () => {
    const payload = JSON.stringify({ action: "dismissed", repository: { full_name: "example/repo" },
      pull_request: { number: 42 }, review: { user: { login: "reviewer" } } });
    const headers = { "x-github-event": "pull_request_review", "x-github-delivery": "delivery-success",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}` };
    const agents: string[] = [];
    const deps = { reviewRequestDeps: { spawnSyncImpl: ((_: string, args: string[]) => {
      agents.push(args[0]!); return { status: 0, stdout: "", stderr: "" };
    }) as any }, publishReviewRerequestedEvent: async () => {} };
    const results = await Promise.all([post(headers, payload, deps), post(headers, payload, deps)]);
    expect(results.map(r => r.status)).toEqual([200, 503]);
    expect(readdirSync(join(root, ".tps", "outbox", "new"))).toHaveLength(1);
    expect(drainOutbox()).toHaveLength(1);
    // The racing pair performed the GitHub re-request exactly once.
    expect(agents).toEqual(["webhook-agent"]);
    // A redelivery after the record moved to sent/ makes no second GitHub call.
    expect((await post(headers, payload, deps)).status).toBe(200);
    expect(drainOutbox()).toEqual([]);
    expect(agents).toEqual(["webhook-agent"]);
    // A different delivery id is a new delivery: one call, one outbox entry.
    expect((await post({ ...headers, "x-github-delivery": "another-delivery" }, payload, deps)).status).toBe(200);
    expect(drainOutbox()).toHaveLength(1);
    expect(agents).toEqual(["webhook-agent", "webhook-agent"]);
  });
  describe("completion records", () => {
    const release = mock(() => {});
    const acquireState = { value: undefined as { mockRestore(): void } };
    beforeEach(() => {
      release.mockClear();
      patchShared(acquireState, "value", spyOn(mailLock, "tryAcquireMailLock").mockReturnValue({ release }));
    });
    afterEach(() => acquireState.value.mockRestore());

    for (const kind of ["new", "sent"] as const) {
      test(`a main-format record in ${kind}/ does not prove completion after upgrade`, async () => {
        const payload = JSON.stringify({ action: "dismissed", repository: { full_name: "example/repo" },
          pull_request: { number: 42 }, review: { user: { login: "reviewer" } } });
        const headers = { "x-github-event": "pull_request_review", "x-github-delivery": "legacy-record",
          "x-hub-signature-256": `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}` };
        const id = createHash("sha256").update(headers["x-github-delivery"]).digest("hex");
        const dir = join(root, ".tps", "outbox", kind);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `github-${id}.json`), JSON.stringify({
          id, to: "host", from: "github-webhook", body: "old pre-call record", timestamp: new Date().toISOString(),
        }));
        expect(existsSync(join(root, ".tps", "outbox", kind, `github-${id}.json`))).toBe(true);
        let calls = 0;
        const deps = { reviewRequestDeps: { spawnSyncImpl: (() => {
          calls++; return { status: 0, stdout: "", stderr: "" };
        }) as any }, publishReviewRerequestedEvent: async () => {} };
        expect(await post(headers, payload, deps)).toEqual({ status: 200, text: "ok" });
        expect(calls).toBe(1);
        expect(existsSync(join(root, ".tps", "outbox", "new", `github-completed-${id}.json`))).toBe(true);
        expect(await post(headers, payload, deps)).toEqual({ status: 200, text: "duplicate" });
        expect(calls).toBe(1);
      });

      for (const operation of ["statSync", "readFileSync"] as const) {
        test(`an unreadable completed ${kind}/ record (${operation}) returns 503 without another GitHub call`, async () => {
          const payload = JSON.stringify({ action: "dismissed", repository: { full_name: "example/repo" },
            pull_request: { number: 42 }, review: { user: { login: "reviewer" } } });
          const headers = { "x-github-event": "pull_request_review", "x-github-delivery": "unreadable-record",
            "x-hub-signature-256": `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}` };
          const id = createHash("sha256").update(headers["x-github-delivery"]).digest("hex");
          const record = join(root, ".tps", "outbox", kind, `github-completed-${id}.json`);
          let calls = 0;
          const deps = { reviewRequestDeps: { spawnSyncImpl: (() => {
            calls++; return { status: 0, stdout: "", stderr: "" };
          }) as any }, publishReviewRerequestedEvent: async () => {} };
          expect(await post(headers, payload, deps)).toEqual({ status: 200, text: "ok" });
          if (kind === "sent") drainOutbox();
          const original = fs[operation];
          const lookup = spyOn(fs, operation).mockImplementation(((...args: any[]) => {
            if (String(args[0]) === record) throw Object.assign(new Error("completion record unreadable"), { code: "EACCES" });
            return (original as any)(...args);
          }) as any);
          try {
            expect(await post(headers, payload, deps)).toEqual({ status: 503, text: "completion record unreadable" });
            expect(calls).toBe(1);
            expect(release).toHaveBeenCalledTimes(2);
          } finally {
            lookup.mockRestore();
          }
          expect(await post(headers, payload, deps)).toEqual({ status: 200, text: "duplicate" });
          expect(calls).toBe(1);
        });
      }
    }
  });

  test("a first delivery re-requests the dismissed reviewer exactly once", async () => {
    const payload = JSON.stringify({ action: "dismissed", repository: { full_name: "tpsdev-ai/cli" },
      pull_request: { number: 146, html_url: "https://github.com/tpsdev-ai/cli/pull/146" }, review: { user: { login: "tps-kern" } } });
    const headers = { "x-github-event": "pull_request_review", "x-github-delivery": "delivery-first",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}` };
    let ghCalls = 0;
    let published = 0;
    const deps = { reviewRequestDeps: { spawnSyncImpl: ((_: string, __: string[]) => {
      ghCalls++; return { status: 0, stdout: "", stderr: "" };
    }) as any }, publishReviewRerequestedEvent: async () => { published++; } };
    expect((await post(headers, payload, deps)).status).toBe(200);
    expect(ghCalls).toBe(1);
    expect(published).toBe(1);
  });
  test("a redelivered dismissed-review event makes no second GitHub call", async () => {
    const payload = JSON.stringify({ action: "dismissed", repository: { full_name: "tpsdev-ai/cli" },
      pull_request: { number: 147, html_url: "https://github.com/tpsdev-ai/cli/pull/147" }, review: { user: { login: "tps-kern" } } });
    const headers = { "x-github-event": "pull_request_review", "x-github-delivery": "delivery-redelivered",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}` };
    let ghCalls = 0;
    let published = 0;
    const deps = { reviewRequestDeps: { spawnSyncImpl: ((_: string, __: string[]) => {
      ghCalls++; return { status: 0, stdout: "", stderr: "" };
    }) as any }, publishReviewRerequestedEvent: async () => { published++; } };
    expect((await post(headers, payload, deps)).status).toBe(200);
    expect(ghCalls).toBe(1);
    expect((await post(headers, payload, deps)).status).toBe(200);
    expect(ghCalls).toBe(1);
    expect(published).toBe(1);
    expect(readdirSync(join(root, ".tps", "outbox", "new"))).toHaveLength(1);
  });
  test("a redelivery after the record moved to sent/ makes no second GitHub call", async () => {
    const payload = JSON.stringify({ action: "dismissed", repository: { full_name: "tpsdev-ai/cli" },
      pull_request: { number: 148, html_url: "https://github.com/tpsdev-ai/cli/pull/148" }, review: { user: { login: "tps-kern" } } });
    const headers = { "x-github-event": "pull_request_review", "x-github-delivery": "delivery-drained",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}` };
    let ghCalls = 0;
    const deps = { reviewRequestDeps: { spawnSyncImpl: ((_: string, __: string[]) => {
      ghCalls++; return { status: 0, stdout: "", stderr: "" };
    }) as any }, publishReviewRerequestedEvent: async () => {} };
    expect((await post(headers, payload, deps)).status).toBe(200);
    expect(ghCalls).toBe(1);
    expect(drainOutbox()).toHaveLength(1);
    expect((await post(headers, payload, deps)).status).toBe(200);
    expect(ghCalls).toBe(1);
  });
  test("a failed delivery claim makes no GitHub call (fails closed)", async () => {
    const payload = JSON.stringify({ action: "dismissed", repository: { full_name: "tpsdev-ai/cli" },
      pull_request: { number: 149, html_url: "https://github.com/tpsdev-ai/cli/pull/149" }, review: { user: { login: "tps-kern" } } });
    const headers = { "x-github-event": "pull_request_review", "x-github-delivery": "delivery-record-fails",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}` };
    let ghCalls = 0;
    const deps = { claimOutboxDeliveryImpl: (() => { throw new Error("claim refused"); }) as any,
      reviewRequestDeps: { spawnSyncImpl: ((_: string, __: string[]) => {
        ghCalls++; return { status: 0, stdout: "", stderr: "" };
      }) as any }, publishReviewRerequestedEvent: async () => {} };
    expect(await post(headers, payload, deps)).toEqual({ status: 503, text: "claim refused" });
    expect(ghCalls).toBe(0);
  });
  test("a failed re-request leaves no completed record, so a redelivery retries it once", async () => {
    const payload = JSON.stringify({ action: "dismissed", repository: { full_name: "tpsdev-ai/cli" },
      pull_request: { number: 150, html_url: "https://github.com/tpsdev-ai/cli/pull/150" }, review: { user: { login: "tps-kern" } } });
    const headers = { "x-github-event": "pull_request_review", "x-github-delivery": "delivery-rerequest-fails",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}` };
    const id = createHash("sha256").update("delivery-rerequest-fails").digest("hex");
    const record = join(root, ".tps", "outbox", "new", `github-completed-${id}.json`);
    const lock = join(root, ".tps", "outbox", "new", `.github-${id}.lock`);
    let status = 1;
    let ghCalls = 0;
    const lockHeld: boolean[] = [];
    const deps = { reviewRequestDeps: { spawnSyncImpl: ((_: string, __: string[]) => {
      ghCalls++; lockHeld.push(existsSync(lock)); return { status, stdout: "", stderr: "gh failed" };
    }) as any }, publishReviewRerequestedEvent: async () => { lockHeld.push(existsSync(lock)); } };
    expect(await post(headers, payload, deps)).toEqual({ status: 503, text: "GitHub re-request failed" });
    expect(ghCalls).toBe(1);
    expect(existsSync(record)).toBe(false);
    status = 0;
    expect(await post(headers, payload, deps)).toEqual({ status: 200, text: "ok" });
    expect(ghCalls).toBe(2);
    expect(existsSync(record)).toBe(true);
    expect(await post(headers, payload, deps)).toEqual({ status: 200, text: "duplicate" });
    expect(ghCalls).toBe(2);
    expect(lockHeld).toEqual([true, true, true]);
    expect(existsSync(lock)).toBe(false);
  });
  test("a simulated crash after GitHub success before the record write permits one more re-request", async () => {
    const payload = JSON.stringify({ action: "dismissed", repository: { full_name: "example/repo" },
      pull_request: { number: 42 }, review: { user: { login: "reviewer" } } });
    const headers = { "x-github-event": "pull_request_review", "x-github-delivery": "crash-after-success",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}` };
    const called = join(root, "github-succeeded");
    const modulePath = new URL("../src/utils/github-webhook.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, "-e", `
      import { spyOn } from "bun:test";
      import * as fs from "node:fs";
      import { handleGithubWebhook } from ${JSON.stringify(modulePath)};
      import { PassThrough } from "node:stream";
      const write = fs.writeFileSync;
      spyOn(fs, "writeFileSync").mockImplementation((...args) => {
        if (String(args[0]).endsWith(".tmp")) process.exit(86);
        return write(...args);
      });
      const req = new PassThrough(); req.headers = ${JSON.stringify(headers)};
      const res = { statusCode: 200, end() {} };
      const pending = handleGithubWebhook(req, res, {
        reviewRequestDeps: { spawnSyncImpl() {
          write(${JSON.stringify(called)}, "success");
          return { status: 0, stdout: "", stderr: "" };
        } }, publishReviewRerequestedEvent: async () => {}
      });
      req.end(${JSON.stringify(payload)}); await pending;
    `], { env: process.env, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited, await new Response(child.stderr).text()).toBe(86);
    expect(existsSync(called)).toBe(true);
    expect(drainOutbox()).toEqual([]);
    const id = createHash("sha256").update(headers["x-github-delivery"]).digest("hex");
    const lock = join(root, ".tps", "outbox", "new", `.github-${id}.lock`);
    expect(existsSync(lock)).toBe(true);
    let ghCalls = 0;
    const deps = { reviewRequestDeps: { spawnSyncImpl: (() => {
      ghCalls++; return { status: 0, stdout: "", stderr: "" };
    }) as any }, publishReviewRerequestedEvent: async () => {} };
    expect(await post(headers, payload, deps)).toEqual({ status: 200, text: "ok" });
    expect(ghCalls).toBe(1);
    expect(existsSync(lock)).toBe(false);
    expect(drainOutbox()).toHaveLength(1);
    expect(await post(headers, payload, deps)).toEqual({ status: 200, text: "duplicate" });
    expect(ghCalls).toBe(1);
  });

  test("a thrown GitHub call returns 503 and a redelivery retries successfully", async () => {
    const payload = JSON.stringify({ action: "dismissed", repository: { full_name: "example/repo" },
      pull_request: { number: 42 }, review: { user: { login: "reviewer" } } });
    const headers = { "x-github-event": "pull_request_review", "x-github-delivery": "thrown-call",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}` };
    let ghCalls = 0;
    const deps = { reviewRequestDeps: { spawnSyncImpl: (() => {
      if (++ghCalls === 1) throw new Error("GitHub call threw");
      return { status: 0, stdout: "", stderr: "" };
    }) as any }, publishReviewRerequestedEvent: async () => {} };
    expect(await post(headers, payload, deps)).toEqual({ status: 503, text: "GitHub call threw" });
    expect(drainOutbox()).toEqual([]);
    expect(await post(headers, payload, deps)).toEqual({ status: 200, text: "ok" });
    expect(await post(headers, payload, deps)).toEqual({ status: 200, text: "duplicate" });
    expect(ghCalls).toBe(2);
  });

  test("holds the lock until the in-flight GitHub call returns; redelivery gets 503 then retries", async () => {
    const request = deliveryRequest("in-flight-call");
    request.body = JSON.stringify({ action: "dismissed", repository: { full_name: "example/repo" },
      pull_request: { number: 42 }, review: { user: { login: "reviewer" } } });
    request.headers["x-github-event"] = "pull_request_review";
    request.headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", "testsecret").update(request.body).digest("hex")}`;
    const release = join(root, "return-from-github");
    const modulePath = new URL("../src/utils/github-webhook.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, "-e", `
      import { existsSync } from "node:fs";
      import { handleGithubWebhook } from ${JSON.stringify(modulePath)};
      import { PassThrough } from "node:stream";
      const req = new PassThrough(); req.headers = ${JSON.stringify(request.headers)};
      const res = { statusCode: 200, end(text) { console.log(JSON.stringify({status: this.statusCode, text})); } };
      const pending = handleGithubWebhook(req, res, {
        reviewRequestDeps: { spawnSyncImpl() {
          console.log("inside-github-call");
          while (!existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          if (!existsSync(${JSON.stringify(request.lock)})) throw new Error("lock released before GitHub returned");
          return { status: 1, stdout: "", stderr: "first attempt failed" };
        } }, publishReviewRerequestedEvent: async () => {}
      });
      req.end(${JSON.stringify(request.body)}); await pending;
    `], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    let ghCalls = 0;
    const deps = { reviewRequestDeps: { spawnSyncImpl: (() => {
      ghCalls++; return { status: 0, stdout: "", stderr: "" };
    }) as any }, publishReviewRerequestedEvent: async () => {} };
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("inside-github-call");
      expect(existsSync(request.lock)).toBe(true);
      expect(await post(request.headers, request.body, deps)).toEqual({ status: 503, text: "duplicate in progress" });
      expect(ghCalls).toBe(0);
      expect(drainOutbox()).toEqual([]);
      writeFileSync(release, "");
      let output = "";
      for (;;) { const part = await reader.read(); if (part.done) break; output += new TextDecoder().decode(part.value); }
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
      expect(JSON.parse(output)).toEqual({ status: 503, text: "GitHub re-request failed" });
      expect(existsSync(request.lock)).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
    expect(await post(request.headers, request.body, deps)).toEqual({ status: 200, text: "ok" });
    expect(await post(request.headers, request.body, deps)).toEqual({ status: 200, text: "duplicate" });
    expect(ghCalls).toBe(1);
  });

  test("invalid dismissed review does not require an agent id", async () => {
    delete process.env.GITHUB_WEBHOOK_AGENT_ID;
    const payload = JSON.stringify({ action: "dismissed", repository: { full_name: "example/repo" } });
    const headers = { "x-github-event": "pull_request_review",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}` };
    expect((await post(headers, payload)).status).toBe(200);
    expect(drainOutbox()).toHaveLength(1);
  });

  function deliveryRequest(delivery: string) {
    const body = JSON.stringify({ repository: { full_name: "example/repo" } });
    return { body, headers: { "x-github-event": "push", "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${createHmac("sha256", "testsecret").update(body).digest("hex")}` },
      lock: join(root, ".tps", "outbox", "new", `.github-${createHash("sha256").update(delivery).digest("hex")}.lock`) };
  }

  test("write and release failures preserve the write error and refuse redelivery", async () => {
    const request = deliveryRequest("write-and-release-fail");
    const writeError = new Error("injected outbox write failure");
    const originalWrite = fs.writeFileSync;
    const originalRename = fs.renameSync;
    const write = spyOn(fs, "writeFileSync").mockImplementation((...args) => {
      if (String(args[0]).endsWith(".tmp")) throw writeError;
      return originalWrite(...args);
    });
    const release = spyOn(fs, "renameSync").mockImplementation((...args) => {
      if (String(args[0]) === request.lock) throw new Error("injected lock release failure");
      return originalRename(...args);
    });
    try {
      expect(await post(request.headers, request.body)).toEqual({ status: 503, text: writeError.message });
      expect(release).toHaveBeenCalled();
    } finally {
      write.mockRestore();
      release.mockRestore();
    }
    expect(existsSync(request.lock)).toBe(true);
    expect(drainOutbox()).toEqual([]);
    const redelivery = await post(request.headers, request.body);
    expect(redelivery.status).toBe(503);
    expect(redelivery.text).toContain("OutboxLockError");
    expect(redelivery.text).toContain(request.lock);
    expect(drainOutbox()).toEqual([]);
  });

  test("cross-process redelivery returns 503 for an old live owner's lock and enqueues once", async () => {
    const request = deliveryRequest("cross-process");
    const modulePath = new URL("../src/utils/github-webhook.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, "-e", `
      import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
      import { processStartToken } from ${JSON.stringify(new URL("../src/utils/mail-lock.ts", import.meta.url).pathname)};
      import { handleGithubWebhook } from ${JSON.stringify(modulePath)};
      import { PassThrough } from "node:stream";
      const lock = ${JSON.stringify(request.lock)};
      mkdirSync(lock, { recursive: true });
      writeFileSync(lock + "/owner.json", JSON.stringify({ pid: process.pid, startToken: processStartToken(process.pid) }));
      console.log("ready");
      while (!existsSync(lock + "/release")) await Bun.sleep(5);
      rmSync(lock, { recursive: true });
      const req = new PassThrough(); req.headers = ${JSON.stringify(request.headers)};
      const res = { statusCode: 200, end(text) { console.log(JSON.stringify({status: this.statusCode, text})); } };
      const pending = handleGithubWebhook(req, res); req.end(${JSON.stringify(request.body)}); await pending;
    `], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
      utimesSync(request.lock, new Date(0), new Date(0));
      const results = await Promise.all(Array.from({ length: 4 }, async () => {
        const contender = Bun.spawn([process.execPath, "-e", `
          import { handleGithubWebhook } from ${JSON.stringify(modulePath)};
          import { PassThrough } from "node:stream";
          const req = new PassThrough(); req.headers = ${JSON.stringify(request.headers)};
          const res = { statusCode: 200, end(text) { console.log(JSON.stringify({status: this.statusCode, text})); } };
          const pending = handleGithubWebhook(req, res); req.end(${JSON.stringify(request.body)}); await pending;
        `], { env: process.env, stdout: "pipe", stderr: "pipe" });
        const output = await new Response(contender.stdout).text();
        const error = await new Response(contender.stderr).text();
        expect(await contender.exited, error).toBe(0);
        return JSON.parse(output);
      }));
      expect(results).toEqual(Array.from({ length: 4 }, () => ({ status: 503, text: "duplicate in progress" })));
      expect(drainOutbox()).toEqual([]);
      writeFileSync(join(request.lock, "release"), "");
      let output = "";
      for (;;) { const part = await reader.read(); if (part.done) break; output += new TextDecoder().decode(part.value); }
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
      expect(JSON.parse(output)).toEqual({ status: 200, text: "ok" });
    } finally {
      child.kill();
      await child.exited;
      rmSync(join(request.lock, "release"), { force: true });
    }
    expect(drainOutbox()).toHaveLength(1);
    expect((await post(request.headers, request.body)).status).toBe(200);
    expect(drainOutbox()).toEqual([]);
  });

  for (const strandedReclaimer of [false, true]) test(`reclaims a crashed owner's lock (stranded reclaimer: ${strandedReclaimer}) and processes the delivery once`, async () => {
    const request = deliveryRequest("dead-owner");
    const child = Bun.spawn([process.execPath, "-e", `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { processStartToken } from ${JSON.stringify(new URL("../src/utils/mail-lock.ts", import.meta.url).pathname)};
      const lock = ${JSON.stringify(request.lock)};
      mkdirSync(lock, { recursive: true });
      const owner = JSON.stringify({ pid: process.pid, startToken: processStartToken(process.pid) });
      writeFileSync(lock + "/owner.json", owner);
      if (${strandedReclaimer}) {
        mkdirSync(lock + ".reclaim");
        writeFileSync(lock + ".reclaim/owner.json", owner);
      }
    `], { env: process.env, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    const ownerPath = join(request.lock, "owner.json");
    const owner = readFileSync(ownerPath, "utf-8");
    writeFileSync(ownerPath, JSON.stringify({ pid: child.pid }));
    const ambiguous = await post(request.headers, request.body);
    expect(ambiguous.status).toBe(503);
    expect(ambiguous.text).toContain("OutboxLockError");
    expect(ambiguous.text).toContain(request.lock);
    expect(drainOutbox()).toEqual([]);
    writeFileSync(ownerPath, owner);
    const modulePath = new URL("../src/utils/github-webhook.ts", import.meta.url).pathname;
    const contenders = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "-e", `
      import { handleGithubWebhook } from ${JSON.stringify(modulePath)};
      import { PassThrough } from "node:stream";
      const req = new PassThrough(); req.headers = ${JSON.stringify(request.headers)};
      const res = { statusCode: 200, end(text) { console.log(JSON.stringify({status: this.statusCode, text})); } };
      const pending = handleGithubWebhook(req, res); req.end(${JSON.stringify(request.body)}); await pending;
    `], { env: process.env, stdout: "pipe", stderr: "pipe" }));
    for (const contender of contenders) {
      const result = JSON.parse(await new Response(contender.stdout).text());
      expect(await contender.exited, await new Response(contender.stderr).text()).toBe(0);
      expect([200, 503]).toContain(result.status);
      if (result.status === 503) expect(result.text).toBe("duplicate in progress");
    }
    expect(existsSync(request.lock)).toBe(false);
    expect(drainOutbox()).toHaveLength(1);
    expect((await post(request.headers, request.body)).status).toBe(200);
    expect(drainOutbox()).toEqual([]);
  });

  for (const owner of [undefined, "directory", "{", "null", "{}", JSON.stringify({ pid: process.pid }),
    JSON.stringify({ pid: process.pid, startToken: "unknown:token" })]) {
    test(`ambiguous owner ${owner} fails closed with a named lock path`, async () => {
      const request = deliveryRequest("ambiguous-owner");
      mkdirSync(request.lock, { recursive: true });
      if (owner === "directory") mkdirSync(join(request.lock, "owner.json"));
      else if (owner !== undefined) writeFileSync(join(request.lock, "owner.json"), owner);
      const result = await post(request.headers, request.body);
      expect(result.status).toBe(503);
      expect(result.text).toContain("OutboxLockError");
      expect(result.text).toContain(request.lock);
      expect(existsSync(request.lock)).toBe(true);
      expect(drainOutbox()).toEqual([]);
    });
  }

});
