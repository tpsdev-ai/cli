/**
 * git-head.ts — classify a repository's HEAD.
 *
 * The auto-commit gate and workspace provider share HEAD classification and
 * apply their own policies.
 */

import { spawnSync } from "node:child_process";

/** Git binary for the probes: `/usr/bin/git` by default; `TPS_GIT_BIN` overrides it. */
export const GIT_BIN = process.env.TPS_GIT_BIN ?? "/usr/bin/git";

export type HeadProbe =
  | { state: "commit"; head: string }
  | { state: "unborn" }
  | {
      state: "indeterminate";
      detail: "failed" | "returned no output" | "returned a ref outside refs/heads/" | "found no commit on detached HEAD" | "found a ref without a commit" | "found a ref after HEAD did not resolve";
      probe: string;
    };

/** Classify HEAD as a commit, an unborn branch, or an indeterminate result. */
export function probeHead(repo: string, runSync: typeof spawnSync = spawnSync): HeadProbe {
  const symbolicProbe = "git symbolic-ref -q HEAD";
  const symbolic = runSync(GIT_BIN, ["symbolic-ref", "-q", "HEAD"], { cwd: repo, encoding: "utf-8" });
  const quietExitOne = (result: typeof symbolic): boolean =>
    result.status === 1 &&
    String(result.stdout ?? "") === "" &&
    String(result.stderr ?? "") === "" &&
    !result.error &&
    !result.signal;
  const symbolicOutput = String(symbolic.stdout ?? "").trim();
  if (symbolic.status === 0 && !symbolicOutput.startsWith("refs/heads/")) {
    return { state: "indeterminate", detail: symbolicOutput ? "returned a ref outside refs/heads/" : "returned no output", probe: symbolicProbe };
  }
  if (symbolic.status !== 0 && !quietExitOne(symbolic)) {
    return { state: "indeterminate", detail: "failed", probe: symbolicProbe };
  }
  const branch = symbolic.status === 0 ? symbolicOutput : undefined;

  const head = runSync(GIT_BIN, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: repo, encoding: "utf-8" });
  if (head.status === 0) {
    const headText = String(head.stdout ?? "").trim();
    return headText ? { state: "commit", head: headText } : { state: "indeterminate", detail: "returned no output", probe: "git rev-parse --verify -q HEAD^{commit}" };
  }
  if (!quietExitOne(head)) {
    return { state: "indeterminate", detail: "failed", probe: "git rev-parse --verify -q HEAD^{commit}" };
  }
  if (branch === undefined) return { state: "indeterminate", detail: "found no commit on detached HEAD", probe: "git rev-parse --verify -q HEAD^{commit}" };

  const verify = runSync(GIT_BIN, ["rev-parse", "--verify", "-q", "HEAD"], { cwd: repo, encoding: "utf-8" });
  if (verify.status === 0) {
    return { state: "indeterminate", detail: "found a ref without a commit", probe: "git rev-parse --verify -q HEAD^{commit}" };
  }
  if (!quietExitOne(verify)) {
    return { state: "indeterminate", detail: "failed", probe: "git rev-parse --verify -q HEAD" };
  }

  const branchRef = runSync(GIT_BIN, ["show-ref", "--verify", "-q", branch], { cwd: repo, encoding: "utf-8" });
  if (quietExitOne(branchRef)) return { state: "unborn" };
  if (branchRef.status === 0) {
    return { state: "indeterminate", detail: "found a ref after HEAD did not resolve", probe: `git show-ref --verify -q ${branch}` };
  }

  return { state: "indeterminate", detail: "failed", probe: `git show-ref --verify -q ${branch}` };
}
