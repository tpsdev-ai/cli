import { describe, expect, mock, test } from "bun:test";
import {
  composeSystemPrompt,
  publishTaskOutcomeEvent,
  runAutoCommit,
  syncWorkspaceBeforeTask,
  type CodexRuntimeConfig,
} from "../src/utils/codex-runtime.ts";

const config: CodexRuntimeConfig = {
  agentId: "ember",
  workspace: "/tmp/repo",
  mailDir: "/tmp/mail",
};

describe("composeSystemPrompt", () => {
  test("appends config systemPrompt before past experience", () => {
    const result = composeSystemPrompt(
      "Flair soul",
      "Agent YAML instructions",
      "Past experience",
    );

    expect(result).toBe("Flair soul\n\nAgent YAML instructions\n\nPast experience");
  });
});

describe("runAutoCommit", () => {
  test("creates the branch before invoking tps agent commit when HEAD is detached", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "/usr/bin/git" && args.join(" ") === "symbolic-ref --quiet HEAD") {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "checkout -b feat/task-123") {
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
      { cmd: "/usr/bin/git", args: ["symbolic-ref", "--quiet", "HEAD"] },
      { cmd: "/usr/bin/git", args: ["checkout", "-b", "feat/task-123"] },
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
      if (cmd === "/usr/bin/git" && args.join(" ") === "symbolic-ref --quiet HEAD") {
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
      { cmd: "/usr/bin/git", args: ["symbolic-ref", "--quiet", "HEAD"] },
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
      if (cmd === "/usr/bin/git" && args.join(" ") === "symbolic-ref --quiet HEAD") {
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
          "--title",
          "feat: ship task 456",
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
        prTitle: "feat: ship task 456",
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

describe("publishTaskOutcomeEvent", () => {
  test("publishes task.completed OrgEvents with the runtime payload", async () => {
    const request = mock(async () => ({}));

    await publishTaskOutcomeEvent(
      { request },
      "ember",
      {
        kind: "task.completed",
        summary: "Task task-123 completed by ember",
        refId: "task-123",
      },
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("POST", "/OrgEvent", {
      kind: "task.completed",
      summary: "Task task-123 completed by ember",
      refId: "task-123",
      authorId: "ember",
    });
  });

  test("publishes task.failed OrgEvents with the runtime payload", async () => {
    const request = mock(async () => ({}));

    await publishTaskOutcomeEvent(
      { request },
      "ember",
      {
        kind: "task.failed",
        summary: "Task task-123 failed: boom",
        refId: "task-123",
      },
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("POST", "/OrgEvent", {
      kind: "task.failed",
      summary: "Task task-123 failed: boom",
      refId: "task-123",
      authorId: "ember",
    });
  });
});

describe("syncWorkspaceBeforeTask", () => {
  test("hard-resets to origin/branch when origin HEAD is available", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      // All git commands succeed by default
      return { status: 0, stdout: "", stderr: "" };
    });

    // Override symbolic-ref to return trunk
    const origImpl = spawnSyncImpl.mock.calls;
    const impl = mock((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "/usr/bin/git" && args.join(" ") === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
        return { status: 0, stdout: "origin/trunk\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    await syncWorkspaceBeforeTask(config, { spawnSyncImpl: impl });

    // Must include: rebase --abort, checkout, fetch, reset --hard, clean -fd
    expect(calls.some(c => c.args.join(" ") === "rebase --abort")).toBe(true);
    expect(calls.some(c => c.args.join(" ") === "checkout trunk")).toBe(true);
    expect(calls.some(c => c.args.join(" ") === "fetch origin trunk")).toBe(true);
    expect(calls.some(c => c.args.join(" ") === "reset --hard origin/trunk")).toBe(true);
    expect(calls.some(c => c.args.join(" ") === "clean -fd")).toBe(true);
  });

  test("falls back to main when origin HEAD is not configured", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "/usr/bin/git" && args.join(" ") === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
        return { status: 1, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    await syncWorkspaceBeforeTask(config, { spawnSyncImpl });

    expect(calls.some(c => c.args.join(" ") === "checkout main")).toBe(true);
    expect(calls.some(c => c.args.join(" ") === "reset --hard origin/main")).toBe(true);
  });

  test("warns and continues when reset fails", async () => {
    const warn = mock(() => {});
    const spawnSyncImpl = mock((cmd: string, args: string[]) => {
      if (cmd === "/usr/bin/git" && args.join(" ") === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
        return { status: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (cmd === "/usr/bin/git" && args.join(" ") === "reset --hard origin/main") {
        return { status: 1, stdout: "", stderr: "fatal: cannot reset" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    await syncWorkspaceBeforeTask(config, { spawnSyncImpl, warn });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("git reset --hard failed"),
    );
  });
});
