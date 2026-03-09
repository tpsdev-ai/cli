import { describe, expect, test } from "bun:test";
import { approvePr, getMergeWarnings, loadPrDiff, mergePr, sendTuiMail } from "../src/commands/tui.js";

describe("tui helpers", () => {
  test("sendTuiMail shells through tps mail send", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const result = sendTuiMail("kern", "hello world", ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: "sent", stderr: "" } as any;
    }) as any);

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ cmd: "tps", args: ["mail", "send", "kern", "hello world"] }]);
  });

  test("approvePr shells through gh-as review approve", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    approvePr("tpsdev-ai/cli", 42, ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: "", stderr: "" } as any;
    }) as any);

    expect(calls).toEqual([{
      cmd: "gh-as",
      args: ["flint", "pr", "review", "42", "--repo", "tpsdev-ai/cli", "--approve"],
    }]);
  });

  test("mergePr shells through gh-as merge squash", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    mergePr("tpsdev-ai/cli", 77, ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: "", stderr: "" } as any;
    }) as any);

    expect(calls).toEqual([{
      cmd: "gh-as",
      args: ["flint", "pr", "merge", "77", "--repo", "tpsdev-ai/cli", "--squash"],
    }]);
  });

  test("loadPrDiff shells through gh-as pr diff", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    loadPrDiff("tpsdev-ai/cli", 99, ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: "diff --git", stderr: "" } as any;
    }) as any);

    expect(calls).toEqual([{
      cmd: "gh-as",
      args: ["flint", "pr", "diff", "99", "--repo", "tpsdev-ai/cli"],
    }]);
  });

  test("getMergeWarnings surfaces merge blockers and warnings", () => {
    expect(getMergeWarnings({
      number: 10,
      title: "Improve TUI",
      author: { login: "ember" },
      isDraft: true,
      mergeable: "CONFLICTING",
      reviewDecision: "REVIEW_REQUIRED",
      statusCheckRollup: [{ state: "FAILURE" }],
    })).toEqual([
      "draft PR",
      "not mergeable (conflicting)",
      "checks failure",
      "no approvals",
    ]);
  });

  test("getMergeWarnings stays empty for a healthy PR", () => {
    expect(getMergeWarnings({
      number: 11,
      title: "Healthy PR",
      author: { login: "flint" },
      mergeable: "MERGEABLE",
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ state: "SUCCESS" }],
    })).toEqual([]);
  });
});
