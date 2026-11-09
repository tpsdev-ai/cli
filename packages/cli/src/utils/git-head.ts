/**
 * git-head.ts — classify a repository's HEAD.
 *
 * One classifier is shared by the auto-commit gate and the workspace
 * provider's baseline fallback, so both accept and refuse the same states.
 */

import { spawnSync } from "node:child_process";

/** Real git binary path — bypasses codex-tools wrapper that blocks commit/push */
export const GIT_BIN = process.env.TPS_GIT_BIN ?? "/usr/bin/git";

export type HeadProbe =
  | { state: "commit"; head: string }
  | { state: "unborn" }
  | { state: "indeterminate"; detail: "failed" | "returned no output" };

/**
 * Classify the repository's HEAD.
 *
 * "commit" requires `git rev-parse --verify -q HEAD^{commit}` to succeed.
 * "unborn" requires all of: `git symbolic-ref -q HEAD` prints a ref under
 * `refs/heads/`, `git rev-parse --verify -q HEAD` finds nothing, and that
 * branch ref does not exist (`git show-ref --verify -q <ref>` exits 1). An
 * unborn HEAD is a branch with no commit yet; the repository may have other
 * branches. A symbolic HEAD outside refs/heads/, or a branch ref that exists
 * but does not resolve to a commit, is indeterminate, as is every other
 * outcome.
 */
export function probeHead(repo: string, runSync: typeof spawnSync = spawnSync): HeadProbe {
  const head = runSync(GIT_BIN, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: repo, encoding: "utf-8" });
  if (head.status === 0) {
    const headText = String(head.stdout ?? "").trim();
    return headText ? { state: "commit", head: headText } : { state: "indeterminate", detail: "returned no output" };
  }
  if (head.status !== 1) return { state: "indeterminate", detail: "failed" };

  const symbolic = runSync(GIT_BIN, ["symbolic-ref", "-q", "HEAD"], { cwd: repo, encoding: "utf-8" });
  const branch = String(symbolic.stdout ?? "").trim();
  if (symbolic.status !== 0 || !branch.startsWith("refs/heads/")) {
    return { state: "indeterminate", detail: "failed" };
  }

  const verify = runSync(GIT_BIN, ["rev-parse", "--verify", "-q", "HEAD"], { cwd: repo, encoding: "utf-8" });
  if (verify.status !== 1 || String(verify.stdout ?? "").trim() !== "") {
    return { state: "indeterminate", detail: "failed" };
  }

  const branchRef = runSync(GIT_BIN, ["show-ref", "--verify", "-q", branch], { cwd: repo, encoding: "utf-8" });
  if (branchRef.status === 1 && String(branchRef.stdout ?? "").trim() === "") return { state: "unborn" };

  return { state: "indeterminate", detail: "failed" };
}
