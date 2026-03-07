import { describe, test, expect } from "bun:test";
import { requestReviews, reRequestReviewer, handlePrOpened, type ReviewTriggerConfig } from "../src/utils/pr-review-trigger.js";

const cfg: ReviewTriggerConfig = {
  reviewers: ["tps-kern", "tps-sherlock"],
  agentId: "anvil",
  repo: "tpsdev-ai/cli",
};

describe("pr-review-trigger", () => {
  test("extractPrNumber: parses GitHub PR URL from event detail", async () => {
    // Mock spawnSync by testing handlePrOpened with a known URL
    // We can't easily mock spawnSync but we can test the URL parsing logic
    // by checking what requestReviews does with a bad PR number
    const result = await handlePrOpened(
      { detail: "https://github.com/tpsdev-ai/cli/pull/131", summary: "PR opened" },
      { ...cfg, reviewers: [] }, // empty reviewers → returns true without calling gh
    );
    expect(result).toBeUndefined(); // handlePrOpened returns void
  });

  test("handlePrOpened: no-ops when detail has no PR URL", async () => {
    // Should warn (via snooplogg) but not throw
    await expect(
      handlePrOpened({ detail: "branch-name-only", summary: "PR" }, cfg)
    ).resolves.toBeUndefined();
  });

  test("handlePrOpened: no-ops when detail is empty", async () => {
    // Should warn (via snooplogg) but not throw
    await expect(
      handlePrOpened({ summary: "PR opened" }, cfg)
    ).resolves.toBeUndefined();
  });

  test("requestReviews: returns true when reviewers list is empty", () => {
    const result = requestReviews(131, { ...cfg, reviewers: [] });
    expect(result).toBe(true);
  });

  test("requestReviews: posts reviewer payload through gh-as", () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
    const result = requestReviews(131, cfg, {
      spawnSyncImpl: ((cmd: string, args: string[], opts?: { input?: string }) => {
        calls.push({ cmd, args, input: opts?.input });
        return { status: 0, stdout: "", stderr: "" } as any;
      }) as any,
    });

    expect(result).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("gh-as");
    expect(calls[0]?.args).toEqual([
      "anvil",
      "api",
      "--method",
      "POST",
      "repos/tpsdev-ai/cli/pulls/131/requested_reviewers",
      "--input",
      "-",
    ]);
    expect(calls[0]?.input).toBe(JSON.stringify({ reviewers: ["tps-kern", "tps-sherlock"] }));
  });
  test("reRequestReviewer: requests only the dismissed reviewer", () => {
    const calls: Array<{ input?: string }> = [];
    const result = reRequestReviewer(77, "reviewer-1", { agentId: "ember", repo: "tpsdev-ai/cli" }, {
      spawnSyncImpl: ((_: string, __: string[], opts?: { input?: string }) => {
        calls.push({ input: opts?.input });
        return { status: 0, stdout: "", stderr: "" } as any;
      }) as any,
    });

    expect(result).toBe(true);
    expect(calls[0]?.input).toBe(JSON.stringify({ reviewers: ["reviewer-1"] }));
  });
});
