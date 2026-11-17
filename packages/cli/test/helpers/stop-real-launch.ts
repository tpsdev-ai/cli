/**
 * Teardown for a fixture that launched a real-nono session (cli#1037).
 *
 * Tracked targets receive SIGTERM; if any remains alive after the wait, all tracked targets receive SIGKILL.
 * Liveness is the CLI's own classifier, `pidState`: a Linux process in
 * state Z has exited even when `kill(pid, 0)` still succeeds for it.
 * An orphaned child can remain unreaped as a zombie in the Docker lane, so a bare `kill(pid, 0)` probe can count it as a survivor and exhaust both waits.
 */
import type { ChildProcess } from "node:child_process";
import { pidState } from "@tpsdev-ai/agent";

export type StopRole = "released child" | "launcher" | "launcher process group";

export interface StopSurvivor {
  role: StopRole;
  pid: number;
  /** `pidState`'s classification for a positive pid; "alive" for a group probe. */
  state: string;
}

export interface StopReport {
  stopped: boolean;
  survivors: StopSurvivor[];
  waitedMs: number;
}

const SIGNAL_BUDGET_MS = 3_000;
const POLL_MS = 25;

function parseReleasedPid(output: string): number | null {
  const match = /released under nono session \S+ \(child pid (\d+)\)/.exec(output);
  return match ? Number(match[1]) : null;
}

/** A process group is probed with `kill(-pgid, 0)`: it reports the group, not
 * one pid, so `pidState`'s single-pid classification does not apply. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function alive(pid: number): boolean {
  return pid < 0 ? groupAlive(pid) : pidState(pid) === "alive";
}

function signal(pid: number, signalName: NodeJS.Signals): void {
  try {
    process.kill(pid, signalName);
  } catch {
    /* checked below */
  }
}

export async function stopRealLaunch(
  child: Pick<ChildProcess, "pid">,
  output: string
): Promise<StopReport> {
  const releasedPid = parseReleasedPid(output);
  const targets: { role: StopRole; pid: number }[] = [];
  if (releasedPid !== null) targets.push({ role: "released child", pid: releasedPid });
  else if (child.pid !== undefined) targets.push({ role: "launcher process group", pid: -child.pid });
  if (child.pid !== undefined) targets.push({ role: "launcher", pid: child.pid });

  const started = Date.now();
  for (const signalName of ["SIGTERM", "SIGKILL"] as const) {
    for (const target of targets) signal(target.pid, signalName);
    const deadline = Date.now() + SIGNAL_BUDGET_MS;
    do {
      if (targets.every((target) => !alive(target.pid))) {
        return { stopped: true, survivors: [], waitedMs: Date.now() - started };
      }
      await new Promise((resolvePoll) => setTimeout(resolvePoll, POLL_MS));
    } while (Date.now() < deadline);
  }

  const survivors = targets
    .filter((target) => alive(target.pid))
    .map((target) => ({
      role: target.role,
      pid: target.pid < 0 ? -target.pid : target.pid,
      state: target.pid < 0 ? "alive" : pidState(target.pid),
    }));
  return { stopped: false, survivors, waitedMs: Date.now() - started };
}

/** The teardown assertion's message: every survivor by role, pid and state, and how
 * long the stop waited before giving up. */
export function formatStopFailure(report: StopReport): string {
  if (report.stopped) return "teardown confirmed the released child and launcher are gone";
  const named = report.survivors.length
    ? report.survivors.map((survivor) => `${survivor.role} pid ${survivor.pid} (${survivor.state})`).join(", ")
    : "no probed process reported alive";
  return `teardown could not confirm the released child and launcher are gone after ${report.waitedMs}ms: ${named}`;
}
