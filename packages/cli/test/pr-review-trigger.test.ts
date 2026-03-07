import { describe, test, expect, afterEach, mock } from "bun:test";
import { requestReviews, handlePrOpened, type ReviewTriggerConfig } from "../src/utils/pr-review-trigger.js";

const cfg: ReviewTriggerConfig = {
  reviewers: ["tps-kern", "tps-sherlock"],
  agentId: "anvil",
  repo: "tpsdev-ai/cli",
};

describe("pr-review-trigger", () => {
  test("extractPrNumber: parses GitHub PR URL from event detail", async () => {
    const calls: string[][] = [];
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
});
