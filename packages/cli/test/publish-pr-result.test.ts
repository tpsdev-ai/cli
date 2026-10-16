/**
 * The runtime publishes a `pr.opened` OrgEvent when a task opens a PR, so the
 * agent's own review-trigger loop sees it (cli#644). The POST is idempotent; a
 * failure is retried a bounded number of times and the last failure is logged
 * with the PR URL, so a lost event is at least visible to an operator.
 */
import { describe, expect, test } from "bun:test";
import { PR_RESULT_PUBLISH_ATTEMPTS, publishPrResult } from "../src/utils/codex-runtime.js";
import { patchShared } from "./helpers/patch-shared.js";

const PR_URL = "https://github.com/example/repo/pull/5";

/** Run `fn` with console.warn captured; return the captured lines. */
async function captureWarn(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const restore = patchShared(console, "warn", ((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }) as typeof console.warn);
  try {
    await fn();
  } finally {
    restore();
  }
  return lines;
}

describe("publishPrResult", () => {
  test("publishes one pr.opened event, targeted at the agent, with the PR URL as detail", async () => {
    const posts: Array<{ method: string; path: string; body: unknown }> = [];
    const flair = {
      request: async (method: string, path: string, body?: unknown) => {
        posts.push({ method, path, body });
        return {};
      },
    };
    await publishPrResult(flair as never, "agent-a", "task-1", PR_URL);
    expect(posts).toEqual([{
      method: "POST",
      path: "/OrgEvent",
      body: {
        kind: "pr.opened", authorId: "agent-a", targetIds: ["agent-a"],
        summary: "PR opened for task-1", refId: "task-1", detail: PR_URL,
      },
    }]);
  });

  test("does nothing when the task opened no PR", async () => {
    let calls = 0;
    const flair = { request: async () => { calls++; return {}; } };
    await publishPrResult(flair as never, "agent-a", "task-1", null);
    expect(calls).toBe(0);
  });

  test("retries the idempotent POST a bounded number of times and logs the PR URL with the last error", async () => {
    let calls = 0;
    const flair = { request: async () => { calls++; throw new Error("flair 503"); } };
    const lines = await captureWarn(async () => {
      await publishPrResult(flair as never, "agent-a", "task-1", PR_URL, { sleep: async () => {} });
    });
    expect(calls).toBe(PR_RESULT_PUBLISH_ATTEMPTS);
    const text = lines.join("\n");
    expect(text).toContain(PR_URL);
    expect(text).toContain("flair 503");
  });

  test("stops retrying once the POST succeeds", async () => {
    let calls = 0;
    const flair = {
      request: async () => {
        calls++;
        if (calls < 2) throw new Error("flair 503");
        return {};
      },
    };
    await publishPrResult(flair as never, "agent-a", "task-1", PR_URL, { sleep: async () => {} });
    expect(calls).toBe(2);
  });
});
