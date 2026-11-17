/**
 * Teardown for a fixture that launched a real-nono session (cli#1037).
 *
 * Tracked targets receive SIGTERM; if any remains alive after the wait, all tracked targets receive SIGKILL.
 * Positive-pid liveness uses the CLI's `pidState`: a Linux process in
 * state Z has exited even when `kill(pid, 0)` still succeeds for it.
 * An orphaned child can remain unreaped as a zombie in the Docker lane, so a bare `kill(pid, 0)` probe can count it as a survivor and exhaust both waits.
 */
import { type ChildProcess, execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { pidState } from "@tpsdev-ai/agent";

export type StopRole = "released child" | "launcher" | "launcher process group";

export interface StopSurvivor {
  role: StopRole;
  pid: number;
  /** "alive" for a surviving group; otherwise pidState's classification. */
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

/** Null keeps the kill probe when membership cannot be read. */
export function listGroupMembers(pgid: number): number[] | null {
  try {
    if (process.platform === "linux") {
      const members: number[] = [];
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        let stat: string;
        try {
          stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        } catch (error) {
          // A process can disappear during the scan; other errors leave membership unknown.
          if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
          return null;
        }
        const end = stat.lastIndexOf(")");
        if (end < 0) return null;
        const fields = stat.slice(end + 2).trim().split(/\s+/);
        const group = Number(fields[2]);
        if (!Number.isSafeInteger(group) || group < 0) return null;
        if (group === pgid) members.push(Number(entry));
      }
      return members;
    }
    if (process.platform === "darwin") {
      // Explicit PGID matching avoids ps selection flags' session/terminal semantics.
      const output = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], {
        encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
      });
      const members: number[] = [];
      for (const line of output.trim().split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
        if (!match) return null;
        // macOS pidState lacks /proc, so exclude ps's exited state before probing.
        if (Number(match[2]) === pgid && !match[3].startsWith("Z")) members.push(Number(match[1]));
      }
      return members;
    }
  } catch {
    /* fall back to the group probe */
  }
  return null;
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signal(pid: number, signalName: NodeJS.Signals): void {
  try {
    process.kill(pid, signalName);
  } catch {
    /* checked below */
  }
}

interface StopOptions {
  signalBudgetMs?: number;
  pollMs?: number;
  sendSignal?: (pid: number, signalName: NodeJS.Signals) => void;
  readState?: typeof pidState;
  listGroupMembers?: typeof listGroupMembers;
}

export async function stopRealLaunch(
  child: Pick<ChildProcess, "pid">,
  output: string,
  options: StopOptions = {}
): Promise<StopReport> {
  const signalBudgetMs = options.signalBudgetMs ?? SIGNAL_BUDGET_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const sendSignal = options.sendSignal ?? signal;
  const readState = options.readState ?? pidState;
  const membersOf = options.listGroupMembers ?? listGroupMembers;
  const state = (pid: number): ReturnType<typeof pidState> => {
    if (pid >= 0) return readState(pid);
    const members = membersOf(-pid);
    const alive = members === null ? groupAlive(pid) : members.some((member) => readState(member) === "alive");
    return alive ? "alive" : "gone";
  };
  const releasedPid = parseReleasedPid(output);
  const targets: { role: StopRole; pid: number }[] = [];
  if (releasedPid !== null) targets.push({ role: "released child", pid: releasedPid });
  else if (child.pid !== undefined) targets.push({ role: "launcher process group", pid: -child.pid });
  if (child.pid !== undefined) targets.push({ role: "launcher", pid: child.pid });

  const started = Date.now();
  for (const signalName of ["SIGTERM", "SIGKILL"] as const) {
    for (const target of targets) sendSignal(target.pid, signalName);
    const deadline = Date.now() + signalBudgetMs;
    do {
      if (targets.every((target) => state(target.pid) !== "alive")) {
        return { stopped: true, survivors: [], waitedMs: Date.now() - started };
      }
      await new Promise((resolvePoll) => setTimeout(resolvePoll, pollMs));
    } while (Date.now() < deadline);
  }

  const survivors = targets
    .map((target) => ({
      role: target.role,
      pid: target.pid < 0 ? -target.pid : target.pid,
      state: state(target.pid),
    }))
    .filter((target) => target.state === "alive");
  return { stopped: survivors.length === 0, survivors, waitedMs: Date.now() - started };
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
