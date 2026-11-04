/**
 * cli#719 — `office kill` classifies each host state record and the branch pid
 * file through the shared pid-file identity check immediately before signalling.
 * A live pid whose recorded start token does not match is neither signalled nor
 * removed; the command exits non-zero naming every record it kept. These tests
 * use real child processes and real state files under a temp HOME.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { runOffice, setOfficeKillSignal } from "../src/commands/office.js";
import { hostStatePath, writeHostState, type HostConnectionState } from "../src/utils/connection-state.js";
import { serializePidRecord } from "../src/utils/pid-file.js";

const TIMEOUT = 20_000;
const children: Bun.Subprocess[] = [];

function spawnChild(): Bun.Subprocess {
  const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  return child;
}

/** A pid that was live and is now reaped, or null when the spawn failed or
 *  pidState(child.pid) is not "gone" at registration. */
function reapedPid(): number | null {
  const child = spawnSync("true", []);
  if (child.pid === undefined) return null;
  return pidState(child.pid) === "gone" ? child.pid : null;
}

const gonePid = reapedPid();

/** Re-probe a registration-time gone pid. A pid reused after registration makes
 *  a stale-record test prove nothing, so fail and ask for a rerun; never signal
 *  that pid. */
function requireGonePid(pid: number | null): number {
  if (pid === null) throw new Error("no reaped pid was registered; rerun the test");
  if (pidState(pid) !== "gone") {
    throw new Error(`pid ${pid} was reused after registration; rerun the test`);
  }
  return pid;
}

function childToken(pid: number): string {
  const token = processStartToken(pid);
  if (token === null) throw new Error(`no start token for pid ${pid}`);
  return token;
}

/**
 * A token from the same source as `real` whose value the child cannot carry,
 * so the record is a mismatch by construction on Linux and macOS. Keeping the
 * source prefix makes the classifier call the record stale rather than
 * unverified.
 */
function foreignStartToken(real: string): string {
  if (real.startsWith("ps:")) return "ps:Thu Jan 1 00:00:00 1970";
  if (real.startsWith("proc:")) return "proc:1";
  throw new Error(`unexpected start token source: ${real}`);
}

function hostState(branch: string, pid: number, startToken: string | null): HostConnectionState {
  return {
    branch,
    connectedAt: "",
    lastHeartbeatSent: "",
    lastHeartbeatAck: null,
    reconnectCount: 0,
    bytesSent: 0,
    bytesReceived: 0,
    messagesSent: 0,
    messagesReceived: 0,
    pid,
    startToken,
  };
}

function captureLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  return {
    logs,
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

afterEach(() => {
  mock.restore();
});

let home: string;
let branchPid: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "tps-office-kill-719-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".tps", "connections"), { recursive: true });
  mkdirSync(join(home, ".tps", "branch"), { recursive: true });
  branchPid = join(home, ".tps", "branch", "branch.pid");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(home, { recursive: true, force: true });
});

describe("office kill identity", () => {
  test(
    "live mismatched records get no signal, are kept, and fail naming both files",
    async () => {
      const host = spawnChild();
      const branch = spawnChild();
      const hostPath = hostStatePath("host-a");
      writeHostState(hostState("host-a", host.pid, foreignStartToken(childToken(host.pid))));
      writeFileSync(branchPid, serializePidRecord(branch.pid, foreignStartToken(childToken(branch.pid))));

      const signals: number[] = [];
      const previous = setOfficeKillSignal((pid) => signals.push(pid));
      const { logs, restore } = captureLogs();
      let message = "";
      try {
        await runOffice({ action: "kill" }).catch((error) => {
          message = (error as Error).message;
        });
      } finally {
        restore();
        setOfficeKillSignal(previous);
      }

      expect(signals).toEqual([]);
      expect(message).toContain(hostPath);
      expect(message).toContain(branchPid);
      expect(message).toMatch(/start token does not match/);
      expect(message).toContain(`remove ${hostPath}`);
      expect(message).toContain(`remove ${branchPid}`);
      expect(logs.join("\n")).not.toMatch(/Terminated/);
      expect(existsSync(hostPath)).toBe(true);
      expect(existsSync(branchPid)).toBe(true);
      expect(pidState(host.pid)).toBe("alive");
      expect(pidState(branch.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test.skipIf(gonePid === null)(
    "a matching host and branch record are signalled and cleared, and a dead pid's record is cleared",
    async () => {
      const dead = requireGonePid(gonePid);
      const host = spawnChild();
      const branch = spawnChild();
      const hostPath = hostStatePath("host-a");
      const deadPath = hostStatePath("host-b");
      writeHostState(hostState("host-a", host.pid, childToken(host.pid)));
      // A legacy record without a token whose pid is gone is removed as stale.
      writeHostState(hostState("host-b", dead, null));
      writeFileSync(branchPid, serializePidRecord(branch.pid, childToken(branch.pid)));
      expect(existsSync(deadPath)).toBe(true);

      const signals: number[] = [];
      const previous = setOfficeKillSignal((pid) => {
        signals.push(pid);
        process.kill(pid, "SIGTERM");
      });
      const { logs, restore } = captureLogs();
      try {
        await runOffice({ action: "kill" });
      } finally {
        restore();
        setOfficeKillSignal(previous);
      }

      expect(signals).toEqual([host.pid, branch.pid]);
      expect(logs.join("\n")).toMatch(/Terminated 2 TPS process/);
      expect(existsSync(hostPath)).toBe(false);
      expect(existsSync(deadPath)).toBe(false);
      expect(existsSync(branchPid)).toBe(false);
      expect(pidState(host.pid)).toBe("gone");
      expect(pidState(branch.pid)).toBe("gone");
    },
    TIMEOUT,
  );
});
