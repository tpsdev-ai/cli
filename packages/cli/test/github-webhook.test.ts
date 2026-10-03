import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { drainOutbox } from "../src/utils/outbox.js";
import { handleGithubWebhook, processGithubWebhookEvent } from "../src/utils/github-webhook.js";

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
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-gh-webhook-"));
    process.env.HOME = root;
    process.env.GITHUB_WEBHOOK_TARGET = "host";
    process.env.GITHUB_WEBHOOK_AGENT_ID = "webhook-agent";
    process.env.GITHUB_WEBHOOK_SECRET = "testsecret";
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.HOME;
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
  test("redelivery enqueues once, including after outbox drain", async () => {
    const payload = JSON.stringify({ action: "dismissed", repository: { full_name: "example/repo" },
      pull_request: { number: 42 }, review: { user: { login: "reviewer" } } });
    const headers = { "x-github-event": "pull_request_review", "x-github-delivery": "delivery-success",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}` };
    const agents: string[] = [];
    const deps = { reviewRequestDeps: { spawnSyncImpl: ((_: string, args: string[]) => {
      agents.push(args[0]!); return { status: 0, stdout: "", stderr: "" };
    }) as any }, publishReviewRerequestedEvent: async () => {} };
    const results = await Promise.all([post(headers, payload, deps), post(headers, payload, deps)]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    expect(readdirSync(join(root, ".tps", "outbox", "new"))).toHaveLength(1);
    expect(drainOutbox()).toHaveLength(1);
    expect((await post(headers, payload, deps)).status).toBe(200);
    expect(drainOutbox()).toEqual([]);
    expect(agents).toEqual(["webhook-agent", "webhook-agent", "webhook-agent"]);
    expect((await post({ ...headers, "x-github-delivery": "another-delivery" }, payload, deps)).status).toBe(200);
    expect(drainOutbox()).toHaveLength(1);
  });
  test("invalid dismissed review does not require an agent id", async () => {
    delete process.env.GITHUB_WEBHOOK_AGENT_ID;
    const payload = JSON.stringify({ action: "dismissed", repository: { full_name: "example/repo" } });
    const headers = { "x-github-event": "pull_request_review",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}` };
    expect((await post(headers, payload)).status).toBe(200);
    expect(drainOutbox()).toHaveLength(1);
  });

});
