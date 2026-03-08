import { describe, expect, mock, test } from "bun:test";
import {
  runAutoCommit,
  syncWorkspaceBeforeTask,
  type CodexRuntimeConfig,
} from "../src/utils/codex-runtime.ts";

const config: CodexRuntimeConfig = {
  agentId: "ember",
  workspace: "/tmp/repo",
  mailDir: "/tmp/mail",
};

describe("runAutoCommit", () => {
  test("creates the branch before invoking tps agent commit when HEAD is detached", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "git" && args.join(" ") === "symbolic-ref --quiet HEAD") {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (cmd === "git" && args.join(" ") === "checkout -b feat/task-123") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "tps") {
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    await runAutoCommit(
      config,
      { publishEvent: mock(async () => {}) },
      {
        taskId: "task-123",
        branchName: "feat/task-123",
        commitMessage: "feat: ship task 123",
        authorName: "ember",
        authorEmail: "ember@tps.dev",
        push: true,
        prTitle: "feat: ship task 123",
      },
      { spawnSyncImpl },
    );

    expect(calls).toEqual([
      { cmd: "git", args: ["symbolic-ref", "--quiet", "HEAD"] },
      { cmd: "git", args: ["checkout", "-b", "feat/task-123"] },
      {
        cmd: "tps",
        args: [
          "agent",
          "commit",
          "--repo",
          "/tmp/repo",
          "--branch",
          "feat/task-123",
          "--message",
          "feat: ship task 123",
          "--author",
          "ember",
          "ember@tps.dev",
          "--push",
          "--pr-title",
          "feat: ship task 123",
        ],
      },
    ]);
  });

  test("opens a PR via gh-as when push, openPr, and prRepo are configured", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "git" && args.join(" ") === "symbolic-ref --quiet HEAD") {
        return { status: 0, stdout: "refs/heads/feat/task-456\n", stderr: "" };
      }
      if (cmd === "tps") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "gh-as") {
        return { status: 0, stdout: "https://github.com/tpsdev-ai/cli/pull/123\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    await runAutoCommit(
      config,
      { publishEvent: mock(async () => {}) },
      {
        taskId: "task-456",
        branchName: "feat/task-456",
        commitMessage: "feat: ship task 456",
        authorName: "Ember",
        authorEmail: "ember@tps.dev",
        push: true,
        openPr: true,
        prRepo: "tpsdev-ai/cli",
        ghAgent: "ember",
        prTitle: "feat: ship task 456",
      },
      { spawnSyncImpl },
    );

    expect(calls).toEqual([
      { cmd: "git", args: ["symbolic-ref", "--quiet", "HEAD"] },
      {
        cmd: "tps",
        args: [
          "agent",
          "commit",
          "--repo",
          "/tmp/repo",
          "--branch",
          "feat/task-456",
          "--message",
          "feat: ship task 456",
          "--author",
          "Ember",
          "ember@tps.dev",
          "--push",
        ],
      },
      {
        cmd: "gh-as",
        args: [
          "ember",
          "pr",
          "create",
          "--repo",
          "tpsdev-ai/cli",
          "--head",
          "feat/task-456",
          "--title",
          "feat: ship task 456",
          "--body",
          "feat: ship task 456",
        ],
      },
    ]);
  });

  test("publishes a blocker OrgEvent when runtime PR creation fails", async () => {
    const publishEvent = mock(async () => {});
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      if (cmd === "git" && args.join(" ") === "symbolic-ref --quiet HEAD") {
        return { status: 0, stdout: "refs/heads/feat/task-456\n", stderr: "" };
      }
      if (cmd === "tps") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (cmd === "gh-as") {
        expect(args).toEqual([
          "ember",
          "pr",
          "create",
          "--repo",
          "tpsdev-ai/cli",
          "--head",
          "feat/task-456",
          "--body",
          "feat: ship task 456",
        ]);
        return { status: 1, stdout: "", stderr: "gh-as pr create failed" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    await expect(runAutoCommit(
      config,
      { publishEvent },
      {
        taskId: "task-456",
        branchName: "feat/task-456",
        commitMessage: "feat: ship task 456",
        authorName: "ember",
        authorEmail: "ember@tps.dev",
        push: true,
        openPr: true,
        prRepo: "tpsdev-ai/cli",
        ghAgent: "ember",
      },
      { spawnSyncImpl },
    )).rejects.toThrow("gh-as pr create failed: gh-as pr create failed");

    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent).toHaveBeenCalledWith({
      kind: "blocker",
      summary: "PR creation failed for task-456",
      detail: "gh-as pr create failed",
      refId: "task-456",
    });
  });
});

describe("syncWorkspaceBeforeTask", () => {
  test("pulls with the configured remote default branch when origin HEAD is available", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "git" && args.join(" ") === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
        return { status: 0, stdout: "origin/trunk\n", stderr: "" };
      }
      if (cmd === "git" && args.join(" ") === "symbolic-ref --quiet HEAD") {
        return { status: 0, stdout: "refs/heads/trunk\n", stderr: "" };
      }
      if (cmd === "git" && args.join(" ") === "pull --rebase origin trunk") {
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    await syncWorkspaceBeforeTask(config, { spawnSyncImpl });

    expect(calls).toEqual([
      { cmd: "git", args: ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"] },
      { cmd: "git", args: ["symbolic-ref", "--quiet", "HEAD"] },
      { cmd: "git", args: ["pull", "--rebase", "origin", "trunk"] },
    ]);
  });

  test("falls back to main when origin HEAD is not configured", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "git" && args.join(" ") === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (cmd === "git" && args.join(" ") === "symbolic-ref --quiet HEAD") {
        return { status: 0, stdout: "refs/heads/main\n", stderr: "" };
      }
      if (cmd === "git" && args.join(" ") === "pull --rebase origin main") {
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    await syncWorkspaceBeforeTask(config, { spawnSyncImpl });

    expect(calls).toEqual([
      { cmd: "git", args: ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"] },
      { cmd: "git", args: ["symbolic-ref", "--quiet", "HEAD"] },
      { cmd: "git", args: ["pull", "--rebase", "origin", "main"] },
    ]);
  });

  test("warns and continues when rebase fails", async () => {
    const warn = mock(() => {});
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      if (cmd === "git" && args.join(" ") === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
        return { status: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (cmd === "git" && args.join(" ") === "symbolic-ref --quiet HEAD") {
        return { status: 0, stdout: "refs/heads/main\n", stderr: "" };
      }
      if (cmd === "git" && args.join(" ") === "pull --rebase origin main") {
        return { status: 1, stdout: "", stderr: "cannot rebase: unstaged changes" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    await syncWorkspaceBeforeTask(config, { spawnSyncImpl, warn });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[ember] Workspace sync failed before task (non-fatal): git pull --rebase origin main: cannot rebase: unstaged changes",
    );
  });
});
