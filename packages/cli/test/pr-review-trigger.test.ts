import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { PermanentEventError } from "../src/utils/flair-task-loop.js";
import {
  InvalidReviewTriggerConfigError,
  handlePrOpened,
  isPermanentGhFailure,
  parsePrUrl,
  parseReviewTriggerConfig,
  reRequestReviewer,
  requestReviews,
  type ReviewTriggerConfig,
} from "../src/utils/pr-review-trigger.js";

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

  test("handlePrOpened: fails the handler when detail has no PR URL", async () => {
    // A missing PR URL is classified terminal: the handler throws
    // PermanentEventError, so the loop records and skips the event.
    await expect(
      handlePrOpened({ detail: "branch-name-only", summary: "PR" }, cfg)
    ).rejects.toThrow(PermanentEventError);
  });

  test("handlePrOpened: fails the handler when detail is empty", async () => {
    await expect(
      handlePrOpened({ summary: "PR opened" }, cfg)
    ).rejects.toThrow("No PR number in event detail: (empty)");
  });

  test("handlePrOpened: fails the handler when the review request exits non-zero", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const deps = {
      spawnSyncImpl: ((cmd: string, args: string[], opts?: { input?: string }) => {
        calls.push({ args, input: opts?.input });
        return { status: 1, stdout: "", stderr: "gh-as: not found" } as any;
      }) as any,
    };

    await expect(
      handlePrOpened({ detail: "https://github.com/tpsdev-ai/cli/pull/131", summary: "PR opened" }, cfg, deps)
    ).rejects.toThrow("Review request failed for PR #131");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "anvil",
      "api",
      "--method",
      "POST",
      "repos/tpsdev-ai/cli/pulls/131/requested_reviewers",
      "--input",
      "-",
    ]);
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

  test("handlePrOpened: targets the repository named by the event's own PR URL", async () => {
    const calls: Array<{ args: string[] }> = [];
    const deps = {
      spawnSyncImpl: ((_cmd: string, args: string[]) => {
        calls.push({ args });
        return { status: 0, stdout: "", stderr: "" } as any;
      }) as any,
    };
    await handlePrOpened(
      { detail: "https://github.com/tpsdev-ai/cli/pull/131", summary: "PR" },
      { reviewers: ["reviewer-1"], agentId: "anvil", repo: "tpsdev-ai/cli" },
      deps,
    );
    expect(calls[0]?.args[4]).toBe("repos/tpsdev-ai/cli/pulls/131/requested_reviewers");
  });

  test("handlePrOpened: refuses a PR URL naming a repository other than the configured one, without calling gh", async () => {
    let calls = 0;
    const deps = {
      spawnSyncImpl: (() => { calls++; return { status: 0, stdout: "", stderr: "" } as any; }) as any,
    };
    await expect(
      handlePrOpened({ detail: "https://github.com/other/repo/pull/5", summary: "PR" }, cfg, deps),
    ).rejects.toThrow(PermanentEventError);
    expect(calls).toBe(0);
  });

  test.each([["(HTTP 404)", true], ["Not Found (HTTP 404)", true], ["Unprocessable Entity (HTTP 422)", true], ["Server Error (HTTP 500)", false], ["gh-as: connection refused", false], ["rate limit exceeded", false]])(
    "isPermanentGhFailure(%j)",
    (stderr, permanent) => {
      expect(isPermanentGhFailure(stderr)).toBe(permanent);
    },
  );

  test.each(["404", "422"])("handlePrOpened: a gh %s failure is classified terminal, so the loop skips the event", async (code) => {
    const deps = {
      spawnSyncImpl: (() => ({ status: 1, stdout: "", stderr: `gh: error (HTTP ${code})` }) as any) as any,
    };
    await expect(
      handlePrOpened({ detail: "https://github.com/tpsdev-ai/cli/pull/9", summary: "PR" }, cfg, deps),
    ).rejects.toThrow(PermanentEventError);
  });

  test("handlePrOpened: a gh 502 failure is given bounded attempts by the loop", async () => {
    const deps = {
      spawnSyncImpl: (() => ({ status: 1, stdout: "", stderr: "gh: Server Error (HTTP 502)" }) as any) as any,
    };
    const error = await handlePrOpened({ detail: "https://github.com/tpsdev-ai/cli/pull/9", summary: "PR" }, cfg, deps)
      .then(() => null, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentEventError);
  });
});

describe("parsePrUrl", () => {
  test.each([
    ["https://github.com/tpsdev-ai/cli/pull/131", { repo: "tpsdev-ai/cli", number: 131 }],
    ["https://github.com/owner.name/repo_name/pull/7", { repo: "owner.name/repo_name", number: 7 }],
    ["https://github.com/a/b/pull/1/files", { repo: "a/b", number: 1 }],
    ["https://github.com/tpsdev-ai/cli/pull/131\n", { repo: "tpsdev-ai/cli", number: 131 }],
  ])("parses %j", (detail, expected) => {
    expect(parsePrUrl(detail)).toEqual(expected);
  });

  test.each([
    "branch-name-only",
    "",
    "https://github.com/tpsdev-ai/cli/pull/not-a-number",
    "https://evil.example.com/tpsdev-ai/cli/pull/1",
    "https://github.com/tpsdev-ai/cli/issues/1",
  ])("returns null for %j", (detail) => {
    expect(parsePrUrl(detail)).toBeNull();
  });
});

describe("parseReviewTriggerConfig", () => {
  test("validates the reviewTrigger read from a real agent config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-review-trigger-config-"));
    try {
      const cfgPath = join(dir, "agent.yaml");
      writeFileSync(cfgPath, [
        "agentId: agent-a",
        "reviewTrigger:",
        "  reviewers: [reviewer-1, reviewer-2]",
        "  repo: example/repo",
        "",
      ].join("\n"));
      const agentCfg = parseYaml(readFileSync(cfgPath, "utf-8")) as { reviewTrigger?: unknown };

      expect(parseReviewTriggerConfig(agentCfg)).toEqual({
        reviewers: ["reviewer-1", "reviewer-2"],
        repo: "example/repo",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each(["bad user", "-reviewer", "reviewer-", "bad--user", "reviewer\n", "a".repeat(40)])("refuses reviewer %j and names the bad value", (reviewer) => {
    const config = { reviewTrigger: { reviewers: [reviewer], repo: "example/repo" } };
    expect(() => parseReviewTriggerConfig(config)).toThrow(InvalidReviewTriggerConfigError);
    expect(() => parseReviewTriggerConfig(config)).toThrow(`Invalid reviewer ${JSON.stringify(reviewer)}: GitHub logins must be 1-39 alphanumeric characters or single hyphens, with no leading or trailing hyphen`);
  });

  test.each(["a", "Reviewer-1", "a".repeat(39)])("accepts GitHub login %j", (reviewer) => {
    const reviewTrigger = { reviewers: [reviewer], repo: "example/repo" };
    expect(parseReviewTriggerConfig({ reviewTrigger })).toEqual(reviewTrigger);
  });

  test("returns undefined when the config has no reviewTrigger", () => {
    expect(parseReviewTriggerConfig({})).toBeUndefined();
  });

  test.each([
    undefined,
    null,
    { reviewers: [null], repo: "example/repo" },
    { reviewers: [""], repo: "example/repo" },
    { reviewers: ["   "], repo: "example/repo" },
    ...["owner/repo?x", "owner/repo#x", "https://owner/repo", "owner/repo/extra", "owner:port/repo", "owner/repo@x", "owner/repo x"].map((repo) => ({ reviewers: ["reviewer-1"], repo })),
  ])("refuses invalid value %j with the named error", (raw) => {
    expect(() => parseReviewTriggerConfig({ reviewTrigger: raw })).toThrow(InvalidReviewTriggerConfigError);
  });

  test("refuses a malformed reviewTrigger", () => {
    expect(() => parseReviewTriggerConfig({ reviewTrigger: "reviewer-1" })).toThrow(InvalidReviewTriggerConfigError);
    expect(() => parseReviewTriggerConfig({ reviewTrigger: { reviewers: [], repo: "example/repo" } })).toThrow(/non-empty list/);
    expect(() => parseReviewTriggerConfig({ reviewTrigger: { reviewers: ["reviewer-1"], repo: "not-a-repo" } })).toThrow(/owner\/name/);
  });
});
