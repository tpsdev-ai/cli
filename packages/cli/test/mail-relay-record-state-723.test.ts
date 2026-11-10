/**
 * cli#723 — an invalid or stale relay pid file says nothing about whether a
 * relay process is running. `mail relay status` and `mail relay stop` describe
 * the record and report the relay's state as unknown.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { runMail, setRelayPidRemoval, setRelayStopSignal } from "../src/commands/mail.js";
import { readPidFile } from "../src/utils/pid-file.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const TIMEOUT = 20_000;

let home: string;
let relayPid: string;
let savedHome: string | undefined;
const children: Bun.Subprocess[] = [];

function spawnChild(): Bun.Subprocess {
  const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  return child;
}

function childToken(pid: number): string {
  const token = processStartToken(pid);
  if (token === null) throw new Error(`no start token for pid ${pid}`);
  return token;
}

/**
 * A token from the same source as `real` whose value the child cannot carry,
 * so the record is a mismatch by construction on Linux and macOS. A token
 * from a different source is "unverified", not "stale", so the prefix is kept.
 */
function foreignStartToken(real: string): string {
  if (real.startsWith("ps:")) return "ps:Thu Jan 1 00:00:00 1970";
  if (real.startsWith("proc:")) return "proc:1";
  throw new Error(`unexpected start token source: ${real}`);
}

function record(pid: number, token: string | null): string {
  return `${JSON.stringify({ pid, startToken: token })}\n`;
}

function staleRecord(child: Bun.Subprocess): string {
  return record(child.pid, foreignStartToken(childToken(child.pid)));
}

/** Drive the shipped CLI the way a user does, with HOME pointing at this test. */
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [TPS_BIN, ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    timeout: TIMEOUT,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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

/** Run stop in-process with a recorded signal sender; returns the sent pids and output. */
async function stopInProcess(): Promise<{ signals: number[]; out: string }> {
  const signals: number[] = [];
  const previousSignal = setRelayStopSignal((pid) => signals.push(pid));
  const { logs, restore } = captureLogs();
  try {
    await runMail({ action: "relay", agent: "stop" });
  } finally {
    restore();
    setRelayStopSignal(previousSignal);
  }
  return { signals, out: logs.join("\n") };
}

beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "tps-relay-record-723-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".tps"), { recursive: true });
  relayPid = join(home, ".tps", "relay.pid");
});

afterEach(() => {
  mock.restore();
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

describe("mail relay status with a bad record", () => {
  test(
    "an invalid pid file with a live relay-shaped process is reported as unknown",
    () => {
      const child = spawnChild();
      writeFileSync(relayPid, "not-a-pid\n");

      const result = runCli(["mail", "relay", "status"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(relayPid);
      expect(result.stdout).toMatch(/unknown/i);
      expect(result.stdout).not.toMatch(/not running/i);
      expect(existsSync(relayPid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "a stale record with a live relay-shaped process is reported as unknown",
    () => {
      const child = spawnChild();
      const contents = staleRecord(child);
      writeFileSync(relayPid, contents);
      expect(readPidFile(relayPid).kind).toBe("stale");

      const result = runCli(["mail", "relay", "status"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(relayPid);
      expect(result.stdout).toMatch(/stale/i);
      expect(result.stdout).toMatch(/unknown/i);
      expect(result.stdout).not.toMatch(/not running/i);
      expect(existsSync(relayPid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );
});

describe("mail relay stop with a bad record", () => {
  test(
    "an invalid pid file is removed and reported, and no process is signalled",
    () => {
      const child = spawnChild();
      writeFileSync(relayPid, "not-a-pid\n");

      const result = runCli(["mail", "relay", "stop"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(relayPid);
      expect(result.stdout).toMatch(/was invalid and was removed/);
      expect(result.stdout).toMatch(/signalled no process/i);
      expect(result.stdout).toMatch(/state is unknown/i);
      expect(result.stdout).not.toMatch(/not running/i);
      expect(existsSync(relayPid)).toBe(false);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "an invalid pid file sends no signal when stop runs in this process",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, "not-a-pid\n");

      const { signals, out } = await stopInProcess();

      expect(signals).toEqual([]);
      expect(out).toMatch(/was invalid and was removed/);
      expect(out).not.toMatch(/not running/i);
      expect(existsSync(relayPid)).toBe(false);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "a stale record is removed and reported, and the live process is not signalled",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, staleRecord(child));
      expect(readPidFile(relayPid).kind).toBe("stale");

      const { signals, out } = await stopInProcess();

      expect(signals).toEqual([]);
      expect(out).toContain(relayPid);
      expect(out).toMatch(/was stale and was removed/);
      expect(out).toMatch(/signalled no process/i);
      expect(out).toMatch(/state is unknown/i);
      expect(out).not.toMatch(/not running/i);
      expect(existsSync(relayPid)).toBe(false);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "a record whose removal fails says so and leaves the relay state unknown",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, "not-a-pid\n");
      const previousRemoval = setRelayPidRemoval(() => {
        throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
      });
      let message = "";
      const { restore } = captureLogs();
      try {
        await runMail({ action: "relay", agent: "stop" }).catch((error) => {
          message = (error as Error).message;
        });
      } finally {
        restore();
        setRelayPidRemoval(previousRemoval);
      }

      expect(message).toContain(relayPid);
      expect(message).toMatch(/was invalid/);
      expect(message).toMatch(/could not be removed/);
      expect(message).toContain("EISDIR");
      expect(message).toMatch(/signalled no process/i);
      expect(message).toMatch(/state is unknown/i);
      expect(message).not.toMatch(/not running/i);
      expect(existsSync(relayPid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );
});
