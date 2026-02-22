import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { handleGithubWebhook } from "../src/utils/github-webhook.js";

async function post(port: number, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/github/webhook`, {
    method: "POST",
    headers,
    body,
  });
  return { status: res.status, text: await res.text() };
}

describe("handleGithubWebhook", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tps-gh-webhook-"));
    process.env.HOME = root;
    process.env.GITHUB_WEBHOOK_TARGET = "rockit";
    process.env.GITHUB_WEBHOOK_SECRET = "testsecret";
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.HOME;
    delete process.env.GITHUB_WEBHOOK_TARGET;
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

  test("returns 503 when secret is not set", async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const server = createServer((req, res) => {
      handleGithubWebhook(req, res).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port as number;

    const r = await post(port, {
      "content-type": "application/json",
      "x-github-event": "push",
    }, JSON.stringify({ repository: { full_name: "a/b" } }));

    expect(r.status).toBe(503);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.GITHUB_WEBHOOK_SECRET = "testsecret";
  });

  test("returns 401 on invalid signature", async () => {
    const server = createServer((req, res) => {
      handleGithubWebhook(req, res).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port as number;

    const r = await post(port, {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-hub-signature-256": "sha256=bad",
    }, JSON.stringify({ repository: { full_name: "a/b" } }));

    expect(r.status).toBe(401);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("returns 200 and queues push event", async () => {
    const server = createServer((req, res) => {
      handleGithubWebhook(req, res).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port as number;

    const payload = JSON.stringify({
      ref: "refs/heads/main",
      after: "abc12345def",
      commits: [{}, {}],
      pusher: { name: "nathan" },
      repository: { full_name: "tpsdev-ai/tps" },
    });
    const sig = `sha256=${createHmac("sha256", "testsecret").update(payload).digest("hex")}`;

    const r = await post(port, {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-hub-signature-256": sig,
    }, payload);

    expect(r.status).toBe(200);

    const outDir = join(root, ".tps", "outbox", "new");
    const files = readdirSync(outDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const row = JSON.parse(readFileSync(join(outDir, files[0]!), "utf-8"));
    expect(row.to).toBe("rockit");
    expect(String(row.body)).toContain("push");

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
