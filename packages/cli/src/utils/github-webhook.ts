import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { queueOutboxMessage } from "./outbox.js";

function webhookSecret(): string {
  return process.env.GITHUB_WEBHOOK_SECRET ?? "";
}

function webhookTarget(): string {
  const target = process.env.GITHUB_WEBHOOK_TARGET;
  if (!target) throw new Error("GITHUB_WEBHOOK_TARGET env var required");
  return target;
}

function validateSignature(body: Buffer, sigHeader: string | undefined): boolean {
  const secret = webhookSecret();
  if (!secret) return false;
  if (!sigHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const expectedBuf = Buffer.from(`sha256=${expected}`, "utf-8");
  const actualBuf = Buffer.from(sigHeader, "utf-8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function formatEvent(event: string, payload: Record<string, unknown>): string {
  const repo = (payload.repository as Record<string, unknown> | undefined)?.full_name ?? "unknown/repo";

  switch (event) {
    case "push": {
      const ref = (payload.ref as string | undefined) ?? "unknown";
      const branch = ref.replace("refs/heads/", "");
      const commits = (payload.commits as unknown[] | undefined)?.length ?? 0;
      const pusher = (payload.pusher as Record<string, unknown> | undefined)?.name ?? "unknown";
      const after = (payload.after as string | undefined)?.slice(0, 7) ?? "unknown";
      return `📦 push to ${repo}/${branch} by ${pusher} — ${commits} commit(s), HEAD ${after}`;
    }
    case "pull_request": {
      const action = payload.action as string | undefined;
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      const num = pr?.number ?? "?";
      const title = pr?.title ?? "(no title)";
      const user = (pr?.user as Record<string, unknown> | undefined)?.login ?? "unknown";
      const url = pr?.html_url ?? "";
      return `🔀 PR #${num} ${action} by ${user} — ${title}\n${url}`;
    }
    case "workflow_run": {
      const wf = payload.workflow_run as Record<string, unknown> | undefined;
      const name = wf?.name ?? "workflow";
      const conclusion = wf?.conclusion ?? "in_progress";
      const branch = wf?.head_branch ?? "?";
      const sha = (wf?.head_sha as string | undefined)?.slice(0, 7) ?? "?";
      const icon = conclusion === "success" ? "✅" : conclusion === "failure" ? "❌" : "⏳";
      return `${icon} ${repo} — ${name} ${conclusion} on ${branch} @ ${sha}`;
    }
    case "issues": {
      const action = payload.action as string | undefined;
      const issue = payload.issue as Record<string, unknown> | undefined;
      const num = issue?.number ?? "?";
      const title = issue?.title ?? "(no title)";
      const user = (issue?.user as Record<string, unknown> | undefined)?.login ?? "unknown";
      const url = issue?.html_url ?? "";
      return `🐛 Issue #${num} ${action} by ${user} — ${title}\n${url}`;
    }
    default:
      return `📬 GitHub ${event} on ${repo}`;
  }
}

export async function handleGithubWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!webhookSecret()) {
    console.warn("[webhook] GITHUB_WEBHOOK_SECRET not set — all webhook requests will be rejected");
    res.statusCode = 503;
    res.end("Webhook not configured");
    return;
  }

  const event = req.headers["x-github-event"] as string | undefined;
  const sig = req.headers["x-hub-signature-256"] as string | undefined;
  if (!event) {
    res.statusCode = 400;
    res.end("Missing X-GitHub-Event header");
    return;
  }

  const body = await readBody(req);
  if (!validateSignature(body, sig)) {
    res.statusCode = 401;
    res.end("Invalid signature");
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString("utf-8"));
  } catch {
    res.statusCode = 400;
    res.end("Invalid JSON");
    return;
  }

  queueOutboxMessage(webhookTarget(), formatEvent(event, payload), "github-webhook");
  res.statusCode = 200;
  res.end("ok");
}
