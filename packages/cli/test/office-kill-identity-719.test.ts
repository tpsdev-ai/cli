/**
 * cli#719 — `office kill` examines the connections directory's `*.json` entries,
 * skipping a `host.json` object with neither `pid` nor `branch` (treated as
 * branch state), and separately checks the branch pid path. A record classified as unverified
 * is not signalled, is kept and named, and the command exits non-zero. Stale-record
 * removal is attempted without signalling; a removal failure keeps the record and
 * is reported.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { pidPath as branchPidPath } from "../src/commands/branch.js";
import { linuxProcessExited, runOffice, setOfficeKillSignal, setProcStatReader } from "../src/commands/office.js";
import { hostStatePath, writeBranchState, writeHostState, type HostConnectionState } from "../src/utils/connection-state.js";
import { serializePidRecord } from "../src/utils/pid-file.js";

const TIMEOUT = 30_000;
const TPS_BIN = resolve(import.meta.dir, "../bin/tps.ts");
const children: Bun.Subprocess[] = [];
const writerChildren: number[] = [];

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

/** Assert a pid is no longer running, accepting a Linux zombie: it has exited
 *  but still answers `kill(pid, 0)` until its parent reaps it. */
function expectStopped(pid: number): void {
  if (pidState(pid) === "gone") return;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rparen = stat.lastIndexOf(")");
      if (rparen !== -1 && stat[rparen + 2] === "Z") return;
    } catch {
      /* not a zombie */
    }
  }
  throw new Error(`pid ${pid} is still running`);
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
  for (const pid of writerChildren.splice(0)) {
    if (pidState(pid) !== "alive") continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
  rmSync(home, { recursive: true, force: true });
});

/** Write a branch pid record through the real launcher (`branch start`),
 *  replacing only the daemon spawn and the join listener, as the writer test
 *  in branch-stop-identity-718 does. Returns the child it recorded. */
async function launchBranchWriter(): Promise<{ pid: number; branchPath: string }> {
  const root = join(home, "tps-root");
  mkdirSync(root, { recursive: true });
  process.env.TPS_ROOT = root;
  writeFileSync(join(root, "branch.conf.json"), JSON.stringify({
    port: 6458, transport: "ws", agentId: "writer-agent",
  }));
  const marker = join(home, "child.pid");
  const script = join(home, "writer.ts");
  const transportPath = resolve(import.meta.dir, "../src/utils/ws-noise-transport.ts");
  const branchModulePath = resolve(import.meta.dir, "../src/commands/branch.ts");
  writeFileSync(script, `
    import { mock } from "bun:test";
    import * as childProcess from "node:child_process";
    import { writeFileSync } from "node:fs";
    const realSpawn = childProcess.spawn;
    mock.module("node:child_process", () => ({ ...childProcess, spawn() {
      const child = realSpawn("sleep", ["60"], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(marker)}, String(child.pid));
      return child;
    }}));
    const transport = await import(${JSON.stringify(transportPath)});
    mock.module(${JSON.stringify(transportPath)}, () => ({ ...transport,
      listenForJoinWs: async () => ({ hostId: "host", hostPubkey: new Uint8Array(32),
        hostFingerprint: "fixture", channel: { async close() {} }, server: { async close() {} } }),
    }));
    const { runBranch } = await import(${JSON.stringify(branchModulePath)});
    await runBranch({ action: "start", agent: "writer-agent" });
  `);
  const env = { ...process.env, NODE_ENV: "production" };
  delete env.TPS_BRANCH_DAEMON;
  delete env.TPS_BRANCH_NO_DAEMON;
  const writer = Bun.spawn([process.execPath, script], { env, stdio: ["ignore", "ignore", "pipe"] });
  try {
    const exit = await writer.exited;
    if (exit !== 0) throw new Error(await new Response(writer.stderr).text());
    const pid = Number(readFileSync(marker, "utf8"));
    writerChildren.push(pid);
    return { pid, branchPath: branchPidPath() };
  } finally {
    if (writer.exitCode === null) writer.kill("SIGKILL");
  }
}

describe("office kill identity", () => {
  test.each([
    ["123 (sleep)", null],
    ["123 (sleep) ", null],
    ["123 (sleep) ?", null],
    ["123 (sleep)xZ", null],
    ...Array.from("RSDTtWXxKPI", (state) => [`123 (sleep) ${state}`, false]),
    ["123 (sleep) Z", true],
  ] as const)("Linux process state from %j is %j", (stat, expected) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const previous = setProcStatReader(() => stat);
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "linux" });
      expect(linuxProcessExited(123)).toBe(expected);
    } finally {
      Object.defineProperty(process, "platform", platform);
      setProcStatReader(previous);
    }
  });

  test.skipIf(process.platform !== "linux").each([
    ["123 (sleep)xZ", 1],
    ["123 (sleep) S", 1],
    ["123 (sleep) Z", 0],
  ] as const)("office kill with process state %j exits %i", (stat, status) => {
    const host = spawnChild();
    const hostPath = hostStatePath("host-a");
    writeHostState(hostState("host-a", host.pid, childToken(host.pid)));
    const script = join(home, "proc-state.ts");
    writeFileSync(script, `
      import { runOffice, setOfficeKillSignal, setProcStatReader } from ${JSON.stringify(resolve(import.meta.dir, "../src/commands/office.ts"))};
      setOfficeKillSignal(() => {});
      setProcStatReader(() => ${JSON.stringify(stat)});
      runOffice({ action: "kill" }).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
    `);
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      timeout: TIMEOUT - 5_000,
      env: { ...process.env, TPS_ROOT: join(home, "tps-root") },
    });
    expect(result.status).toBe(status);
    expect(existsSync(hostPath)).toBe(status !== 0);
    const output = `${result.stdout}${result.stderr}`;
    if (status !== 0) {
      expect(output).toContain(`could not be stopped (pid ${host.pid}); record kept at ${hostPath}`);
      expect(output).not.toContain("stopped; record removed");
    } else {
      expect(output).toContain(`stopped; record removed: ${hostPath}`);
    }
    expect(pidState(host.pid)).toBe("alive");
  }, TIMEOUT);

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
      await host.exited;
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
      await host.exited;
      expect(pidState(host.pid)).toBe("gone");
    },
    TIMEOUT,
  );

  test.each(["host-a", "host"])(
    "a directory at the %s record path is named and kept",
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
    "a legacy bare-pid branch record is classified as unverified",
    async () => {
      const root = join(home, "tps-root");
      mkdirSync(root, { recursive: true });
      process.env.TPS_ROOT = root;
      const branch = spawnChild();
      const branchPath = branchPidPath();
      expect(branchPath).toBe(join(root, "branch.pid"));
      // A record written before the launcher recorded a start token.
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
    "the branch launcher records a start token office kill can verify",
    async () => {
      const { pid, branchPath } = await launchBranchWriter();
      expect(pidState(pid)).toBe("alive");
      const token = processStartToken(pid);
      expect(token).not.toBeNull();
      expect(JSON.parse(readFileSync(branchPath, "utf8"))).toEqual({ pid, startToken: token });
    },
    TIMEOUT,
  );

  test(
    "office kill verifies, signals and removes the branch launcher's record",
    async () => {
      const { pid, branchPath } = await launchBranchWriter();
      const signals: number[] = [];
      const previous = setOfficeKillSignal((signalled) => {
        signals.push(signalled);
        process.kill(signalled, "SIGTERM");
      });
      const { logs, restore } = captureLogs();
      try {
        await runOffice({ action: "kill" });
      } finally {
        restore();
        setOfficeKillSignal(previous);
      }

      expect(signals).toEqual([pid]);
      expect(logs.join("\n")).toContain(`Branch pid file (pid ${pid}) stopped; record removed: ${branchPath}`);
      expect(existsSync(branchPath)).toBe(false);
      expectStopped(pid);
    },
    TIMEOUT,
  );

  test.skipIf(process.platform !== "linux")(
    "a child left by an exited launcher is reported stopped and its record removed",
    async () => {
      const root = join(home, "tps-root");
      mkdirSync(root, { recursive: true });
      process.env.TPS_ROOT = root;
      // The shell exits without waiting for `sleep`; on Linux the signalled
      // pid can therefore be a zombie when `office kill` probes it.
      const launched = spawnSync("sh", ["-c", "sleep 60 </dev/null >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
      expect(launched.status).toBe(0);
      const pid = Number(launched.stdout.trim());
      expect(Number.isInteger(pid)).toBe(true);
      writerChildren.push(pid);
      const branchPath = branchPidPath();
      writeFileSync(branchPath, serializePidRecord(pid, childToken(pid)));

      const signals: number[] = [];
      const previous = setOfficeKillSignal((signalled) => {
        signals.push(signalled);
        process.kill(signalled, "SIGTERM");
      });
      const { logs, restore } = captureLogs();
      try {
        await runOffice({ action: "kill" });
      } finally {
        restore();
        setOfficeKillSignal(previous);
      }

      expect(signals).toEqual([pid]);
      expect(logs.join("\n")).toContain(`Branch pid file (pid ${pid}) stopped; record removed: ${branchPath}`);
      expect(existsSync(branchPath)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "an unlistable connections directory is named, the branch record is still handled and the command exits non-zero",
    async () => {
      const dir = join(home, ".tps", "connections");
      rmSync(dir, { recursive: true, force: true });
      writeFileSync(dir, "");
      const branch = spawnChild();
      const branchPath = branchPidPath();
      writeFileSync(branchPath, serializePidRecord(branch.pid, childToken(branch.pid)));

      const signals: number[] = [];
      const previous = setOfficeKillSignal((signalled) => {
        signals.push(signalled);
        process.kill(signalled, "SIGTERM");
      });
      const { restore } = captureLogs();
      let message = "";
      try {
        await runOffice({ action: "kill" }).catch((error) => {
          message = (error as Error).message;
        });
      } finally {
        restore();
        setOfficeKillSignal(previous);
      }

      expect(message).toContain(dir);
      expect(message).toContain("could not be listed");
      expect(signals).toEqual([branch.pid]);
      expect(existsSync(branchPath)).toBe(false);
      await branch.exited;
      expect(pidState(branch.pid)).toBe("gone");
    },
    TIMEOUT,
  );

  test(
    "a connections directory whose path cannot be resolved is reported and office kill exits non-zero",
    () => {
      const dir = join(home, ".tps", "connections");
      // A symlink that points to itself fails with ELOOP for every uid, root
      // included, so the listing is exercised in the container jobs too.
      rmSync(dir, { recursive: true, force: true });
      symlinkSync("connections", dir);

      const result = spawnSync(process.execPath, [TPS_BIN, "office", "kill"], {
        encoding: "utf8",
        timeout: TIMEOUT - 5_000,
        env: { ...process.env, HOME: home, TPS_ROOT: join(home, "tps-root") },
      });

      expect(result.status).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(dir);
      expect(output).toContain("could not be listed");
      expect(output).toContain("ELOOP");
    },
    TIMEOUT,
  );

  test.skipIf(process.platform !== "linux")(
    "a live pid whose process state cannot be read is kept and the command fails",
    async () => {
      const host = spawnChild();
      const hostPath = hostStatePath("host-a");
      writeHostState(hostState("host-a", host.pid, childToken(host.pid)));

      // The signal does not stop this pid, and the process-state read fails
      // with ENOENT although the pid is live (hidepid, another pid namespace).
      const previousSignal = setOfficeKillSignal(() => {});
      const previousReader = setProcStatReader(() => {
        const error = new Error("no such file or directory") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      });
      const { restore } = captureLogs();
      let message = "";
      try {
        await runOffice({ action: "kill" }).catch((error) => {
          message = (error as Error).message;
        });
      } finally {
        restore();
        setProcStatReader(previousReader);
        setOfficeKillSignal(previousSignal);
      }

      expect(message).toContain(hostPath);
      expect(message).toContain("could not be stopped");
      expect(existsSync(hostPath)).toBe(true);
      expect(pidState(host.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "host.json with a branch key and no pid is reported as invalid and kept",
    () => {
      const hostPath = hostStatePath("host");
      const content = JSON.stringify({ branch: "host" });
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
      await host.exited;
      await branch.exited;
      expect(pidState(host.pid)).toBe("gone");
      expect(pidState(branch.pid)).toBe("gone");
    },
    TIMEOUT,
  );
});
