/**
 * macOS identity helpers shared by the branch daemon cleanup in
 * branch-start-agent-id-734.test.ts and branch-pid-claim-730.test.ts.
 *
 * The identity probe is bounded: a probe that does not answer in time counts
 * as "identity could not be verified", so cleanup leaves the pid alone.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { sep } from "node:path";

/** Bound for the macOS `lsof` identity probe. */
export const LSOF_TIMEOUT_MS = 5_000;

/** Run a command with a hard bound; a child still running at the deadline is
 *  killed with SIGKILL, so the call returns. */
export function runBounded(
  command: string,
  args: string[],
  timeoutMs: number = LSOF_TIMEOUT_MS,
): SpawnSyncReturns<string> {
  return spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
}

export type StdoutProbe = (pid: number) => { status: number | null; stdout: string };

/** What a probe answer says about `pid`: a verified match, a positive
 *  mismatch, or an answer that could not be read (timeout, error, non-zero
 *  exit). */
export type IdentityVerdict = "this-daemon" | "other" | "unverified";

function lsofProbe(pid: number): { status: number | null; stdout: string } {
  const result = runBounded("lsof", ["-a", "-p", String(pid), "-d", "1", "-Fn"]);
  return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : "" };
}

/** Classify the probe answer for `pid` against `root`. Only a probe that
 *  answers with fd 1 as a file under `root` is "this-daemon"; a probe that
 *  times out, exits non-zero, has no fd path, or whose paths cannot be read is
 *  "unverified"; a readable path outside `root` is "other". */
export function probeStdoutUnderRoot(
  pid: number,
  root: string,
  probe: StdoutProbe = lsofProbe,
): IdentityVerdict {
  const result = probe(pid);
  if (result.status !== 0) return "unverified";
  const name = result.stdout.split("\n").find((line) => line.startsWith("n"));
  if (name === undefined) return "unverified";
  let stdoutPath: string;
  let realRoot: string;
  try {
    stdoutPath = realpathSync(name.slice(1));
    realRoot = realpathSync(root);
  } catch {
    return "unverified";
  }
  if (!stdoutPath.startsWith(`${realRoot}${sep}`)) return "other";
  try {
    return statSync(stdoutPath).isFile() ? "this-daemon" : "other";
  } catch {
    return "unverified";
  }
}

/** True when the probe answers and the daemon's stdout (fd 1) is a file under
 *  `root`. A failed, timed-out or unparseable probe is not a verified identity. */
export function stdoutUnderRoot(pid: number, root: string, probe: StdoutProbe = lsofProbe): boolean {
  return probeStdoutUnderRoot(pid, root, probe) === "this-daemon";
}
