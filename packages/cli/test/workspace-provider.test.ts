import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTaskFailure } from "../src/utils/agent-lifecycle.js";
import type { FlairClient, WorkspaceStateRecord } from "../src/utils/flair-client.js";
import { GitWorkspaceProvider } from "../src/utils/workspace-provider.js";

function unbornRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "workspace-unborn-"));
  const init = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, encoding: "utf-8" });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  return repo;
}

test("snapshot returns an unborn state on a clean unborn branch", async () => {
  const repo = unbornRepo();
  try {
    const state = await new GitWorkspaceProvider(repo).snapshot("pre-task-first");
    expect(state).toMatchObject({ ref: "HEAD", label: "pre-task-first", provider: "git", metadata: { branch: null, dirty: false, unborn: true } });
    expect(spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: repo }).status).toBe(1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("checkpoint returns an unborn state on a clean unborn branch", async () => {
  const repo = unbornRepo();
  try {
    const state = await new GitWorkspaceProvider(repo).checkpoint("boot");
    expect(state).toMatchObject({ ref: "HEAD", label: "boot", provider: "git", metadata: { branch: null, noop: true, unborn: true } });
    expect(spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: repo }).status).toBe(1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("snapshot and clean checkpoint reject an indeterminate HEAD naming its probe", async () => {
  const repo = unbornRepo();
  try {
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/bad..name\n");
    const provider = new GitWorkspaceProvider(repo);
    await expect(provider.snapshot()).rejects.toThrow(/git symbolic-ref -q HEAD.*failed/);
    await expect(provider.checkpoint("boot")).rejects.toThrow(/git symbolic-ref -q HEAD.*failed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("failure lifecycle on a clean unborn branch writes the unborn ref without creating a commit", async () => {
  const repo = unbornRepo();
  try {
    const provider = new GitWorkspaceProvider(repo);
    const preTaskState = await provider.snapshot("pre-task-first");
    const writes: WorkspaceStateRecord[] = [];
    const flair = {
      agentId: "fixture",
      writeWorkspaceState: async (record: WorkspaceStateRecord) => { writes.push(record); },
      publishEvent: async () => {},
    } as unknown as FlairClient;
    await onTaskFailure(provider, flair, "first", preTaskState, "fixture failure");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ phase: "failure", ref: "HEAD", provider: "git" });
    expect(spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: repo }).status).toBe(1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
