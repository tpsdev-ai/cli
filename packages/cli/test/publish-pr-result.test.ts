/**
 * The runtime attempts bounded `pr.opened` publication when a task opens a PR.
 * Only an accepted POST can reach the review loop; exhausted retries call
 * `console.warn` with the PR URL and return without an event if no POST was accepted.
 * Flair assigns a fresh id per POST, so a retry after an uncertain response can
 * publish the event twice.
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

  test("retries the POST a bounded number of times and logs the PR URL with the last error", async () => {
    let calls = 0;
    const flair = { request: async () => { calls++; throw new Error("flair 503"); } };
    const lines = await captureWarn(async () => {
      await publishPrResult(flair as never, "agent-a", "task-1", PR_URL, { sleep: async () => {} });
    });
    expect(calls).toBe(PR_RESULT_PUBLISH_ATTEMPTS);
    const text = lines.join("\n");
    expect(text).toContain(PR_URL);
    expect(text).toContain("flair 503");
    expect(text).toContain(`after ${PR_RESULT_PUBLISH_ATTEMPTS} attempts`);
  });

  test("a lost response after an accepted write posts the event a second time, so a duplicate is possible", async () => {
    const posts: Array<Record<string, unknown>> = [];
    let calls = 0;
    const flair = {
      request: async (_method: string, _path: string, body?: unknown) => {
        calls++;
        posts.push(body as Record<string, unknown>);
        // The write was accepted but its response was lost: the client cannot
        // tell, so it retries and Flair stores a second event.
        if (calls === 1) throw new Error("socket hang up");
        return {};
      },
    };
    await publishPrResult(flair as never, "agent-a", "task-1", PR_URL, { sleep: async () => {} });
    expect(calls).toBe(2);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
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
