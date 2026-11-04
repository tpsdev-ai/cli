/**
 * cli#719 — `office kill` enumerates the host state record files and the
 * branch pid file and classifies each at its actual path with the shared
 * pid-file check immediately before signalling. A record classified as unverified
 * is not signalled, is kept and named, and the command exits non-zero. Stale-record
 * removal is attempted without signalling; a removal failure keeps the record and
 * is reported. These tests use real child processes and real files under a temp HOME.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { pidPath as branchPidPath } from "../src/commands/branch.js";
import { runOffice, setOfficeKillSignal } from "../src/commands/office.js";
import { hostStatePath, writeBranchState, writeHostState, type HostConnectionState } from "../src/utils/connection-state.js";
import { serializePidRecord } from "../src/utils/pid-file.js";

const TIMEOUT = 30_000;
const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
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
 * so the record names another process by construction on Linux and macOS.
 * Keeping the source prefix makes the classifier call the record stale.
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
let savedHome: string | undefined;
let savedRoot: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedRoot = process.env.TPS_ROOT;
  home = mkdtempSync(join(tmpdir(), "tps-office-kill-719-"));
  process.env.HOME = home;
  delete process.env.TPS_ROOT;
  mkdirSync(join(home, ".tps", "connections"), { recursive: true });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedRoot === undefined) delete process.env.TPS_ROOT;
  else process.env.TPS_ROOT = savedRoot;
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
    "host.json with a matching live host record is signalled and reported",
    async () => {
      const host = spawnChild();
      const hostPath = hostStatePath("host");
      writeHostState(hostState("host", host.pid, childToken(host.pid)));

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

      expect(signals).toEqual([host.pid]);
      expect(logs.join("\n")).toContain(`Host state record (pid ${host.pid}) stopped; record removed: ${hostPath}`);
      expect(existsSync(hostPath)).toBe(false);
      expect(pidState(host.pid)).toBe("gone");
    },
    TIMEOUT,
  );

  test(
    "host.json with branch connection state is kept and office kill exits zero",
    () => {
      const branchState = { connectedAt: "", lastSeen: "", messagesReceived: 0, messagesPushed: 0 };
      writeBranchState(branchState);
      const branchPath = hostStatePath("host");

      const result = spawnSync(process.execPath, [TPS_BIN, "office", "kill"], {
        encoding: "utf8",
        timeout: TIMEOUT - 5_000,
        env: { ...process.env, HOME: home, TPS_ROOT: join(home, "tps-root") },
      });

      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("Terminated 0 TPS process(es)");
      expect(JSON.parse(readFileSync(branchPath, "utf8"))).toEqual(branchState);
    },
    TIMEOUT,
  );

  test(
    "unparseable host.json is kept and office kill exits non-zero naming its path",
    () => {
      const hostPath = hostStatePath("host");
      const content = "{ this is not json";
      writeFileSync(hostPath, content);

      const result = spawnSync(process.execPath, [TPS_BIN, "office", "kill"], {
        encoding: "utf8",
        timeout: TIMEOUT - 5_000,
        env: { ...process.env, HOME: home, TPS_ROOT: join(home, "tps-root") },
      });

      expect(result.status).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(hostPath);
      expect(output).toContain("could not be parsed");
      expect(readFileSync(hostPath, "utf8")).toBe(content);
    },
    TIMEOUT,
  );

  test(
    "office kill attempts stale-record removal without signalling the live pids",
    async () => {
      const host = spawnChild();
      const branch = spawnChild();
      const hostPath = hostStatePath("host-a");
      const branchPath = branchPidPath();
      writeHostState(hostState("host-a", host.pid, foreignStartToken(childToken(host.pid))));
      writeFileSync(branchPath, serializePidRecord(branch.pid, foreignStartToken(childToken(branch.pid))));

      const signals: number[] = [];
      const previous = setOfficeKillSignal((pid) => signals.push(pid));
      const { logs, restore } = captureLogs();
      try {
        await runOffice({ action: "kill" });
      } finally {
        restore();
        setOfficeKillSignal(previous);
      }

      expect(signals).toEqual([]);
      const output = logs.join("\n");
      expect(output).toContain(`${hostPath}; pid ${host.pid} was not signalled`);
      expect(output).toContain(`${branchPath}; pid ${branch.pid} was not signalled`);
      expect(output).not.toContain("Check that pid and stop it yourself");
      expect(existsSync(hostPath)).toBe(false);
      expect(existsSync(branchPath)).toBe(false);
      expect(pidState(host.pid)).toBe("alive");
      expect(pidState(branch.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "a record is classified at the path it was found at, not the branch field in it",
    async () => {
      const host = spawnChild();
      const hostPath = hostStatePath("host-a");
      // The branch field names host-b; nothing is written at host-b.json.
      writeFileSync(hostPath, JSON.stringify(hostState("host-b", host.pid, childToken(host.pid))));

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

      expect(signals).toEqual([host.pid]);
      expect(logs.join("\n")).toContain(`Host state record (pid ${host.pid}) stopped; record removed: ${hostPath}`);
      expect(existsSync(hostPath)).toBe(false);
      expect(pidState(host.pid)).toBe("gone");
    },
    TIMEOUT,
  );

  test.each(["host-a", "host"])(
    "an unreadable %s record is named and kept",
    async (branch) => {
      const hostPath = hostStatePath(branch);
      // A directory in the record's place makes readFileSync fail for every
      // uid, including root in the container jobs.
      mkdirSync(hostPath);

      const { logs, restore } = captureLogs();
      let message = "";
      try {
        await runOffice({ action: "kill" }).catch((error) => {
          message = (error as Error).message;
        });
      } finally {
        restore();
      }

      expect(message).toContain(hostPath);
      expect(message).toContain("could not be read");
      expect(logs.join("\n")).toContain(hostPath);
      expect(existsSync(hostPath)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "a record file that cannot be parsed is named and kept",
    async () => {
      const hostPath = hostStatePath("host-a");
      writeFileSync(hostPath, "{ this is not json");

      const { logs, restore } = captureLogs();
      let message = "";
      try {
        await runOffice({ action: "kill" }).catch((error) => {
          message = (error as Error).message;
        });
      } finally {
        restore();
      }

      expect(message).toContain(hostPath);
      expect(message).toContain("could not be parsed");
      expect(logs.join("\n")).toContain(hostPath);
      expect(existsSync(hostPath)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "a live bare-pid branch record at the writer's path is classified as unverified",
    async () => {
      const root = join(home, "tps-root");
      mkdirSync(root, { recursive: true });
      process.env.TPS_ROOT = root;
      const branch = spawnChild();
      const branchPath = branchPidPath();
      expect(branchPath).toBe(join(root, "branch.pid"));
      // The current branch launcher writes a bare decimal pid.
      writeFileSync(branchPath, `${branch.pid}\n`);

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
      expect(message).toContain(branchPath);
      expect(message).toContain("identity cannot be verified");
      expect(message).toContain(`remove ${branchPath}`);
      expect(logs.join("\n")).toContain(branchPath);
      expect(existsSync(branchPath)).toBe(true);
      expect(pidState(branch.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "the tps office kill process exits non-zero, naming the path and the remedy",
    async () => {
      const host = spawnChild();
      const hostPath = hostStatePath("host-a");
      // A live pid with no token cannot be verified; the record is a refusal.
      writeHostState(hostState("host-a", host.pid, null));

      const result = spawnSync(process.execPath, [TPS_BIN, "office", "kill"], {
        encoding: "utf8",
        timeout: TIMEOUT - 5_000,
        env: { ...process.env, HOME: home, TPS_ROOT: join(home, "tps-root") },
      });

      expect(result.status).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(hostPath);
      expect(output).toContain(`remove ${hostPath} if that process is not running`);
      expect(existsSync(hostPath)).toBe(true);
      expect(pidState(host.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "a matching host and branch record are signalled and cleared",
    async () => {
      const dead = requireGonePid(gonePid);
      const host = spawnChild();
      const branch = spawnChild();
      const hostPath = hostStatePath("host-a");
      const deadPath = hostStatePath("host-b");
      const branchPath = branchPidPath();
      writeHostState(hostState("host-a", host.pid, childToken(host.pid)));
      writeHostState(hostState("host-b", dead, null));
      writeFileSync(branchPath, serializePidRecord(branch.pid, childToken(branch.pid)));
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
      expect(existsSync(branchPath)).toBe(false);
      expect(pidState(host.pid)).toBe("gone");
      expect(pidState(branch.pid)).toBe("gone");
    },
    TIMEOUT,
  );
});
