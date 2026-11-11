/**
 * cli#709 — relay and bridge pid files carry the process start token. A stop
 * checks the recorded token immediately before signalling and refuses on a
 * mismatch; `bridge stop` re-reads each record immediately before its own
 * signal. The pid can still be reused between that check and the signal, and
 * the ps fallback compares start time only to the second. These tests use real
 * child processes and real pid files under a temp HOME.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { runMail, setRelayPidRemoval, setRelayStopSignal } from "../src/commands/mail.js";
import { runBridge, setBridgeStopSignal } from "../src/commands/bridge.js";
import { readPidFile } from "../src/utils/pid-file.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const TIMEOUT = 20_000;
const PID_FILE_URL = new URL("../src/utils/pid-file.js", import.meta.url).href;
const BRIDGE_URL = new URL("../src/commands/bridge.js", import.meta.url).href;

/**
 * Runs bridge stop in a child process with readPidFile replaced, so the
 * between-reads cases can be constructed deterministically. The real
 * removePidFile and the real stop loop still run.
 */
const RECHECK_CHILD = `
const pidPath = process.env.PID_PATH;
const secondPath = process.env.SECOND_PATH || "";
const removeFailPath = process.env.REMOVE_FAIL_PATH || "";
const pid = Number(process.env.PID_VALUE);
const mode = process.env.MODE;
const { mock } = await import("bun:test");
const real = await import(${JSON.stringify(PID_FILE_URL)});
let reads = 0;
mock.module(${JSON.stringify(PID_FILE_URL)}, () => ({
  ...real,
  readPidFile(path) {
    if (mode === "token") {
      if (path !== pidPath) return { kind: "missing" };
      reads += 1;
      return { kind: "running", path, pid, startToken: reads === 1 ? "token-a" : "token-b" };
    }
    if (path !== pidPath && path !== secondPath) return { kind: "missing" };
    return { kind: "running", path, pid, startToken: "token-a" };
  },
  removePidFile(path) {
    if (removeFailPath !== "" && path === removeFailPath) {
      const error = new Error("EISDIR: illegal operation on a directory, unlink") as NodeJS.ErrnoException;
      error.code = "EISDIR";
      throw error;
    }
    return real.removePidFile(path);
  },
}));
const { runBridge, setBridgeStopSignal } = await import(${JSON.stringify(BRIDGE_URL)});
const signals = [];
const logs = [];
console.log = (...args) => logs.push(args.join(" "));
console.error = (...args) => logs.push(args.join(" "));
setBridgeStopSignal((signalled) => signals.push(signalled));
let message = null;
try {
  await runBridge({ action: "stop" });
} catch (error) {
  message = error.message;
}
process.stdout.write("RESULT:" + JSON.stringify({ message, signals, logs }) + "\\n");
process.exit(message === null ? 0 : 1);
`;

let home: string;
let relayPid: string;
let bridgePid: string;
let legacyBridgePid: string;
let savedHome: string | undefined;
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

/** Resolved once at registration: a pid that pidState does not report as gone
 *  registers a visible skip; a pid reused after registration fails the test
 *  body in requireGonePid. Reuse is detected only when it is observable at one
 *  of those two probes; a reuse that begins and ends between them is not
 *  detected. */
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

function relayRecord(pid: number, token: string | null): string {
  return `${JSON.stringify({ pid, startToken: token })}\n`;
}

/** The child's real start token, or a failure. */
function childToken(pid: number): string {
  const token = processStartToken(pid);
  if (token === null) throw new Error(`no start token for pid ${pid}`);
  return token;
}

/**
 * A token from the same source as `real` whose value the child cannot carry,
 * so the record is a mismatch by construction on Linux and macOS. A token
 * from a different source is "unverified", not "stale", so the source
 * prefix is kept.
 */
function foreignStartToken(real: string): string {
  if (real.startsWith("ps:")) return "ps:Thu Jan 1 00:00:00 1970";
  if (real.startsWith("proc:")) return "proc:1";
  throw new Error(`unexpected start token source: ${real}`);
}

/** The same `ps:` token with a different seconds value. */
function psTokenWithDifferentSeconds(token: string): string {
  const match = /^(ps:.*\d{2}:\d{2}:)(\d{2})( \d{4})$/.exec(token);
  if (match === null) throw new Error(`unexpected ps start token: ${token}`);
  const seconds = (Number(match[2]) + 1) % 60;
  return `${match[1]}${String(seconds).padStart(2, "0")}${match[3]}`;
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

function runRecheckChild(
  mode: "token" | "duplicate",
  env: Record<string, string>,
): { status: number | null; result: { message: string | null; signals: number[]; logs: string[] } } {
  const script = join(home, `recheck-${mode}.ts`);
  writeFileSync(script, RECHECK_CHILD);
  const run = spawnSync("bun", [script], {
    env: { ...process.env, HOME: home, MODE: mode, ...env },
    encoding: "utf8",
    timeout: TIMEOUT,
  });
  const line = (run.stdout ?? "").split("\n").find((entry) => entry.startsWith("RESULT:"));
  if (line === undefined) {
    throw new Error(`recheck child printed no result (exit ${run.status}): ${run.stderr}`);
  }
  return { status: run.status, result: JSON.parse(line.slice("RESULT:".length)) };
}

beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "tps-pid-identity-709-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".tps", "run"), { recursive: true });
  relayPid = join(home, ".tps", "relay.pid");
  bridgePid = join(home, ".tps", "run", "bridge-openclaw.pid");
  legacyBridgePid = join(home, ".tps", "run", "mail-bridge.pid");
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

describe("relay stop identity", () => {
  test(
    "a mismatched token gets no signal, the stale file is removed, and the stop succeeds",
    async () => {
      const child = spawnChild();
      // A token from the child's own source whose value cannot be current
      // stands for a pid that has since been reused: the recorded identity is
      // not the process now holding the pid.
      const token = foreignStartToken(childToken(child.pid));
      writeFileSync(relayPid, relayRecord(child.pid, token));
      // Classified directly, so a same-second ps token (macOS) cannot turn the
      // fixture into a match.
      expect(readPidFile(relayPid).kind).toBe("stale");
      const signals: number[] = [];
      const previous = setRelayStopSignal((pid) => signals.push(pid));
      const { logs, restore } = captureLogs();
      try {
        await runMail({ action: "relay", agent: "stop" });
      } finally {
        restore();
        setRelayStopSignal(previous);
      }

      expect(signals).toEqual([]);
      expect(existsSync(relayPid)).toBe(false);
      expect(logs.join("\n")).toMatch(/was stale and was removed/i);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "a record whose token matches is signalled and its file removed",
    async () => {
      const child = spawnChild();
      const token = processStartToken(child.pid);
      expect(token).not.toBeNull();
      writeFileSync(relayPid, relayRecord(child.pid, token));
      const signals: number[] = [];
      const previous = setRelayStopSignal((pid) => {
        signals.push(pid);
        process.kill(pid, "SIGTERM");
      });
      try {
        await runMail({ action: "relay", agent: "stop" });
      } finally {
        setRelayStopSignal(previous);
      }

      expect(signals).toEqual([child.pid]);
      expect(existsSync(relayPid)).toBe(false);
      await child.exited;
    },
    TIMEOUT,
  );

  test(
    "a legacy file with a live pid sends nothing, fails, and keeps the file",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, `${child.pid}\n`);
      const signals: number[] = [];
      const previous = setRelayStopSignal((pid) => signals.push(pid));
      try {
        await expect(runMail({ action: "relay", agent: "stop" })).rejects.toThrow(
          /identity cannot be verified/,
        );
      } finally {
        setRelayStopSignal(previous);
      }

      expect(signals).toEqual([]);
      expect(existsSync(relayPid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test.skipIf(gonePid === null)(
    "a legacy file whose pid is gone is removed as stale",
    async () => {
      const pid = requireGonePid(gonePid);
      writeFileSync(relayPid, `${pid}\n`);
      const signals: number[] = [];
      const previous = setRelayStopSignal((pid) => signals.push(pid));
      const { logs, restore } = captureLogs();
      try {
        await runMail({ action: "relay", agent: "stop" });
      } finally {
        restore();
        setRelayStopSignal(previous);
      }

      expect(signals).toEqual([]);
      expect(existsSync(relayPid)).toBe(false);
      expect(logs.join("\n")).toMatch(/was stale and was removed/i);
    },
    TIMEOUT,
  );

  test(
    "malformed pid files are invalid and are never signalled",
    async () => {
      const child = spawnChild();
      const variants = [
        `${child.pid}abc`,
        `${child.pid} junk`,
        "1e3",
        `${child.pid}\n${child.pid + 1}\n`,
        "",
      ];
      for (const content of variants) {
        writeFileSync(relayPid, content);
        const signals: number[] = [];
        const previous = setRelayStopSignal((pid) => signals.push(pid));
        const { logs, restore } = captureLogs();
        try {
          await runMail({ action: "relay", agent: "stop" });
        } finally {
          restore();
          setRelayStopSignal(previous);
        }
        expect(signals).toEqual([]);
        expect(existsSync(relayPid)).toBe(false);
        expect(logs.join("\n")).toMatch(/was invalid and was removed/i);
      }
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "an EPERM stop keeps the pid file and fails",
    async () => {
      const child = spawnChild();
      const token = processStartToken(child.pid);
      expect(token).not.toBeNull();
      writeFileSync(relayPid, relayRecord(child.pid, token));
      const previous = setRelayStopSignal(() => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      });
      try {
        await expect(runMail({ action: "relay", agent: "stop" })).rejects.toThrow(
          new RegExp(`could not be stopped \\(pid ${child.pid}\\)`),
        );
      } finally {
        setRelayStopSignal(previous);
      }

      expect(existsSync(relayPid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "a signal failure the probe calls invalid keeps the pid file and fails",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, relayRecord(child.pid, childToken(child.pid)));
      const previous = setRelayStopSignal(() => {
        throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
      });
      try {
        await expect(runMail({ action: "relay", agent: "stop" })).rejects.toThrow(
          new RegExp(`could not be stopped \\(pid ${child.pid}\\)`),
        );
      } finally {
        setRelayStopSignal(previous);
      }

      expect(existsSync(relayPid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  // The macOS ps token resolves to one second: a token for the same pid that
  // differs only in its seconds field is a different identity.
  test.skipIf(!(processStartToken(process.pid) ?? "").startsWith("ps:"))(
    "two ps tokens that differ only in the seconds field classify stale",
    () => {
      const child = spawnChild();
      const real = childToken(child.pid);
      const shifted = psTokenWithDifferentSeconds(real);
      expect(shifted).not.toBe(real);
      writeFileSync(relayPid, relayRecord(child.pid, shifted));
      expect(readPidFile(relayPid).kind).toBe("stale");
    },
    TIMEOUT,
  );

  test(
    "a pid file that cannot be removed is reported kept and the stop exits non-zero",
    async () => {
      const child = spawnChild();
      const token = processStartToken(child.pid);
      expect(token).not.toBeNull();
      writeFileSync(relayPid, relayRecord(child.pid, token));
      const previousRemoval = setRelayPidRemoval(() => {
        // Replace the remover with a stub that throws, so the removal-failure
        // path runs for every uid, root included, without relying on a mode
        // bit.
        throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
      });
      const previous = setRelayStopSignal((pid) => {
        process.kill(pid, "SIGTERM");
      });
      let message = "";
      const { restore } = captureLogs();
      try {
        await runMail({ action: "relay", agent: "stop" }).catch((error) => {
          message = (error as Error).message;
        });
      } finally {
        restore();
        setRelayStopSignal(previous);
        setRelayPidRemoval(previousRemoval);
      }

      expect(message).toContain(relayPid);
      expect(message).toMatch(/could not be removed/);
      expect(message).toMatch(/kept/);
      expect(message).toMatch(/EISDIR|EPERM/);
      expect(message).not.toMatch(/\n\s+at /);
      expect(pidState(child.pid)).toBe("gone");
    },
    TIMEOUT,
  );
});

describe("relay start and status classification", () => {
  test(
    "relay start refuses an unverified record, naming the pid, the file and the remedy",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, `${JSON.stringify({ pid: child.pid, startToken: null })}\n`);
      let message = "";
      try {
        await runMail({ action: "relay", agent: "start" });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain(String(child.pid));
      expect(message).toContain(relayPid);
      expect(message).toMatch(/identity cannot be verified/);
      expect(message).toContain(`remove ${relayPid} if the relay is not running`);
      expect(existsSync(relayPid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "relay status reports an unverified record as unverified, never running",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, `${JSON.stringify({ pid: child.pid, startToken: null })}\n`);
      const { logs, restore } = captureLogs();
      try {
        await runMail({ action: "relay", agent: "status" });
      } finally {
        restore();
      }

      const out = logs.join("\n");
      expect(out).toMatch(/unverified/i);
      expect(out).toContain(String(child.pid));
      expect(out).toContain(relayPid);
      expect(out).not.toMatch(/running/i);
    },
    TIMEOUT,
  );

  test(
    "relay status on a stale record reports it, removes nothing and exits 0",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, relayRecord(child.pid, foreignStartToken(childToken(child.pid))));
      const { logs, restore } = captureLogs();
      try {
        await runMail({ action: "relay", agent: "status" });
      } finally {
        restore();
      }

      expect(existsSync(relayPid)).toBe(true);
      expect(logs.join("\n")).toMatch(/stale/i);
      expect(logs.join("\n")).toContain(relayPid);
    },
    TIMEOUT,
  );
});

describe("json pid interpretation", () => {
  test(
    "a nested pid is ignored and the top-level record decides",
    async () => {
      const nested = spawnChild();
      const top = spawnChild();
      const topToken = processStartToken(top.pid);
      expect(topToken).not.toBeNull();
      writeFileSync(
        relayPid,
        `${JSON.stringify({ nested: { pid: nested.pid, startToken: processStartToken(nested.pid) }, pid: top.pid, startToken: topToken })}\n`,
      );
      const signals: number[] = [];
      const previous = setRelayStopSignal((pid) => {
        signals.push(pid);
        process.kill(pid, "SIGTERM");
      });
      try {
        await runMail({ action: "relay", agent: "stop" });
      } finally {
        setRelayStopSignal(previous);
      }

      expect(signals).toEqual([top.pid]);
      expect(existsSync(relayPid)).toBe(false);
      expect(pidState(nested.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "a duplicate top-level pid key uses the last value",
    async () => {
      const first = spawnChild();
      const second = spawnChild();
      const firstToken = processStartToken(first.pid);
      const secondToken = processStartToken(second.pid);
      expect(firstToken).not.toBeNull();
      expect(secondToken).not.toBeNull();
      writeFileSync(
        relayPid,
        `{"pid":${first.pid},"startToken":${JSON.stringify(firstToken)},"pid":${second.pid},"startToken":${JSON.stringify(secondToken)}}\n`,
      );
      const signals: number[] = [];
      const previous = setRelayStopSignal((pid) => {
        signals.push(pid);
        process.kill(pid, "SIGTERM");
      });
      try {
        await runMail({ action: "relay", agent: "stop" });
      } finally {
        setRelayStopSignal(previous);
      }

      expect(signals).toEqual([second.pid]);
      expect(existsSync(relayPid)).toBe(false);
      expect(pidState(first.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "an out-of-range, fractional, string or boolean pid is invalid",
    async () => {
      const variants = [
        `{"pid":2147483648,"startToken":null}`,
        `{"pid":1.5}`,
        `{"pid":"123"}`,
        `{"pid":true}`,
      ];
      for (const content of variants) {
        writeFileSync(relayPid, content);
        const signals: number[] = [];
        const previous = setRelayStopSignal((pid) => signals.push(pid));
        const { logs, restore } = captureLogs();
        try {
          await runMail({ action: "relay", agent: "stop" });
        } finally {
          restore();
          setRelayStopSignal(previous);
        }
        expect(signals).toEqual([]);
        expect(existsSync(relayPid)).toBe(false);
        expect(logs.join("\n")).toMatch(/was invalid and was removed/i);
      }
    },
    TIMEOUT,
  );

  test(
    "an explicit null start token is unverified: no signal, file kept",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, `${JSON.stringify({ pid: child.pid, startToken: null })}\n`);
      const signals: number[] = [];
      const previous = setRelayStopSignal((pid) => signals.push(pid));
      try {
        await expect(runMail({ action: "relay", agent: "stop" })).rejects.toThrow(
          /identity cannot be verified/,
        );
      } finally {
        setRelayStopSignal(previous);
      }

      expect(signals).toEqual([]);
      expect(existsSync(relayPid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );
});

describe("bridge stop identity", () => {
  test(
    "a mismatched token gets no signal and the stale file is removed",
    async () => {
      const child = spawnChild();
      writeFileSync(bridgePid, relayRecord(child.pid, foreignStartToken(childToken(child.pid))));
      expect(readPidFile(bridgePid).kind).toBe("stale");
      const signals: number[] = [];
      const previous = setBridgeStopSignal((pid) => signals.push(pid));
      const { logs, restore } = captureLogs();
      try {
        await runBridge({ action: "stop" });
      } finally {
        restore();
        setBridgeStopSignal(previous);
      }

      expect(signals).toEqual([]);
      expect(existsSync(bridgePid)).toBe(false);
      expect(logs.join("\n")).toMatch(/stale pid file removed/i);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "a record whose token matches is signalled and its file removed",
    async () => {
      const child = spawnChild();
      const token = processStartToken(child.pid);
      expect(token).not.toBeNull();
      writeFileSync(bridgePid, relayRecord(child.pid, token));
      const signals: number[] = [];
      const previous = setBridgeStopSignal((pid) => {
        signals.push(pid);
        process.kill(pid, "SIGTERM");
      });
      try {
        await runBridge({ action: "stop" });
      } finally {
        setBridgeStopSignal(previous);
      }

      expect(signals).toEqual([child.pid]);
      expect(existsSync(bridgePid)).toBe(false);
      await child.exited;
    },
    TIMEOUT,
  );

  test(
    "a legacy file with a live pid sends nothing, fails, and keeps the file",
    async () => {
      const child = spawnChild();
      writeFileSync(bridgePid, JSON.stringify({ pid: child.pid, port: 7891 }));
      const signals: number[] = [];
      const previous = setBridgeStopSignal((pid) => signals.push(pid));
      try {
        await expect(runBridge({ action: "stop" })).rejects.toThrow(
          /identity cannot be verified/,
        );
      } finally {
        setBridgeStopSignal(previous);
      }

      expect(signals).toEqual([]);
      expect(existsSync(bridgePid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test.skipIf(gonePid === null)(
    "a legacy file whose pid is gone is removed as stale",
    async () => {
      const pid = requireGonePid(gonePid);
      writeFileSync(bridgePid, JSON.stringify({ pid, port: 7891 }));
      const signals: number[] = [];
      const previous = setBridgeStopSignal((pid) => signals.push(pid));
      const { logs, restore } = captureLogs();
      try {
        await runBridge({ action: "stop" });
      } finally {
        restore();
        setBridgeStopSignal(previous);
      }

      expect(signals).toEqual([]);
      expect(existsSync(bridgePid)).toBe(false);
      expect(logs.join("\n")).toMatch(/stale pid file removed/i);
    },
    TIMEOUT,
  );

  test(
    "malformed pid files are invalid and are never signalled",
    async () => {
      const child = spawnChild();
      const variants = [
        `${child.pid}abc`,
        `${child.pid} junk`,
        "1e3",
        `${child.pid}\n${child.pid + 1}\n`,
        "",
      ];
      for (const content of variants) {
        writeFileSync(bridgePid, content);
        const signals: number[] = [];
        const previous = setBridgeStopSignal((pid) => signals.push(pid));
        const { logs, restore } = captureLogs();
        try {
          await runBridge({ action: "stop" });
        } finally {
          restore();
          setBridgeStopSignal(previous);
        }
        expect(signals).toEqual([]);
        expect(existsSync(bridgePid)).toBe(false);
        expect(logs.join("\n")).toMatch(/invalid pid file removed/i);
      }
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "a verified stop keeps an unverifiable second record, reports it, and exits non-zero",
    async () => {
      const verified = spawnChild();
      const unverified = spawnChild();
      const token = processStartToken(verified.pid);
      expect(token).not.toBeNull();
      writeFileSync(bridgePid, relayRecord(verified.pid, token));
      writeFileSync(legacyBridgePid, `${JSON.stringify({ pid: unverified.pid, port: 7891 })}\n`);
      const signals: number[] = [];
      const previous = setBridgeStopSignal((pid) => {
        signals.push(pid);
        process.kill(pid, "SIGTERM");
      });
      const { logs, restore } = captureLogs();
      try {
        await expect(runBridge({ action: "stop" })).rejects.toThrow(
          /identity cannot be verified/,
        );
      } finally {
        restore();
        setBridgeStopSignal(previous);
      }

      expect(signals).toEqual([verified.pid]);
      expect(existsSync(bridgePid)).toBe(false);
      expect(existsSync(legacyBridgePid)).toBe(true);
      expect(logs.join("\n")).toContain(legacyBridgePid);
      expect(logs.join("\n")).toMatch(/identity cannot be verified/i);
      expect(pidState(unverified.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test.skipIf(gonePid === null)(
    "a verified record and a stale record are both removed",
    async () => {
      const verified = spawnChild();
      const token = processStartToken(verified.pid);
      expect(token).not.toBeNull();
      writeFileSync(bridgePid, relayRecord(verified.pid, token));
      const pid = requireGonePid(gonePid);
      writeFileSync(legacyBridgePid, `${JSON.stringify({ pid, port: 7891 })}\n`);
      const signals: number[] = [];
      const previous = setBridgeStopSignal((pid) => {
        signals.push(pid);
        process.kill(pid, "SIGTERM");
      });
      try {
        await runBridge({ action: "stop" });
      } finally {
        setBridgeStopSignal(previous);
      }

      expect(signals).toEqual([verified.pid]);
      expect(existsSync(bridgePid)).toBe(false);
      expect(existsSync(legacyBridgePid)).toBe(false);
    },
    TIMEOUT,
  );

  test.skipIf(gonePid === null)(
    "an EPERM on the first record still removes a later stale record and reports both",
    async () => {
      const child = spawnChild();
      const token = processStartToken(child.pid);
      expect(token).not.toBeNull();
      writeFileSync(bridgePid, relayRecord(child.pid, token));
      const pid = requireGonePid(gonePid);
      writeFileSync(legacyBridgePid, `${JSON.stringify({ pid, port: 7891 })}\n`);
      // Same construction as the single-record EPERM case: a signal sender that
      // raises EPERM, which is deterministic on every uid.
      const previous = setBridgeStopSignal(() => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      });
      const { logs, restore } = captureLogs();
      try {
        await expect(runBridge({ action: "stop" })).rejects.toThrow(
          new RegExp(`could not be stopped \\(pid ${child.pid}\\)`),
        );
      } finally {
        restore();
        setBridgeStopSignal(previous);
      }

      expect(existsSync(bridgePid)).toBe(true);
      expect(existsSync(legacyBridgePid)).toBe(false);
      expect(logs.join("\n")).toContain(`could not be stopped (pid ${child.pid})`);
      expect(logs.join("\n")).toContain(legacyBridgePid);
      expect(logs.join("\n")).toMatch(/stale pid file removed/i);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "an exit timeout on the first record still keeps and reports a later unverified record",
    async () => {
      const first = spawnChild();
      const token = processStartToken(first.pid);
      expect(token).not.toBeNull();
      writeFileSync(bridgePid, relayRecord(first.pid, token));
      const second = spawnChild();
      writeFileSync(legacyBridgePid, `${JSON.stringify({ pid: second.pid, port: 7891 })}\n`);
      // The signal is accepted, but this sender does not terminate the process,
      // so the stop's exit wait times out.
      const previous = setBridgeStopSignal(() => {});
      const { logs, restore } = captureLogs();
      try {
        await expect(runBridge({ action: "stop" })).rejects.toThrow(
          new RegExp(`could not be stopped \\(pid ${first.pid}\\)`),
        );
      } finally {
        restore();
        setBridgeStopSignal(previous);
      }

      expect(existsSync(bridgePid)).toBe(true);
      expect(existsSync(legacyBridgePid)).toBe(true);
      expect(logs.join("\n")).toContain(`could not be stopped (pid ${first.pid})`);
      expect(logs.join("\n")).toContain(legacyBridgePid);
      expect(logs.join("\n")).toMatch(/identity cannot be verified/i);
      expect(pidState(first.pid)).toBe("alive");
      expect(pidState(second.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "a second record rewritten to a different verified process before its signal is not signalled, is reported, and exits non-zero",
    async () => {
      const first = spawnChild();
      const planned = spawnChild();
      const replacement = spawnChild();
      const firstToken = processStartToken(first.pid);
      const plannedToken = processStartToken(planned.pid);
      const replacementToken = processStartToken(replacement.pid);
      expect(firstToken).not.toBeNull();
      expect(plannedToken).not.toBeNull();
      expect(replacementToken).not.toBeNull();
      writeFileSync(bridgePid, relayRecord(first.pid, firstToken));
      writeFileSync(legacyBridgePid, relayRecord(planned.pid, plannedToken));
      const signals: number[] = [];
      const previous = setBridgeStopSignal((pid) => {
        signals.push(pid);
        if (pid === first.pid) {
          // The first stop has begun: the second record now names another
          // verified live process.
          writeFileSync(legacyBridgePid, relayRecord(replacement.pid, replacementToken));
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        }
        process.kill(pid, "SIGTERM");
      });
      const { logs, restore } = captureLogs();
      try {
        await expect(runBridge({ action: "stop" })).rejects.toThrow(
          /not the planned pid/,
        );
      } finally {
        restore();
        setBridgeStopSignal(previous);
      }

      expect(signals).toEqual([first.pid]);
      expect(existsSync(legacyBridgePid)).toBe(true);
      expect(logs.join("\n")).toContain(legacyBridgePid);
      expect(pidState(planned.pid)).toBe("alive");
      expect(pidState(replacement.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "a pid file that cannot be removed is reported kept and a later record is still processed",
    async () => {
      const first = spawnChild();
      const second = spawnChild();
      const firstToken = processStartToken(first.pid);
      const secondToken = processStartToken(second.pid);
      expect(firstToken).not.toBeNull();
      expect(secondToken).not.toBeNull();
      writeFileSync(bridgePid, relayRecord(first.pid, firstToken));
      writeFileSync(legacyBridgePid, relayRecord(second.pid, secondToken));
      const signals: number[] = [];
      const previous = setBridgeStopSignal((pid) => {
        signals.push(pid);
        if (pid === first.pid) {
          // A non-empty directory in the file's place fails unlink for every
          // uid, root included.
          rmSync(bridgePid);
          mkdirSync(bridgePid);
          writeFileSync(join(bridgePid, "keep"), "x");
        }
        process.kill(pid, "SIGTERM");
      });
      let message = "";
      const { logs, restore } = captureLogs();
      try {
        await runBridge({ action: "stop" }).catch((error) => {
          message = (error as Error).message;
        });
      } finally {
        restore();
        setBridgeStopSignal(previous);
      }

      expect(message).toContain(bridgePid);
      expect(message).toMatch(/could not be removed/);
      expect(message).toMatch(/kept/);
      expect(message).toMatch(/EISDIR|EPERM/);
      expect(message).not.toMatch(/\n\s+at /);
      expect(signals).toEqual([first.pid, second.pid]);
      expect(existsSync(legacyBridgePid)).toBe(false);
      expect(logs.join("\n")).toContain(legacyBridgePid);
      expect(pidState(first.pid)).toBe("gone");
      expect(pidState(second.pid)).toBe("gone");
    },
    TIMEOUT,
  );

  test(
    "two records naming the same verified process send one signal and remove both",
    async () => {
      const child = spawnChild();
      const token = processStartToken(child.pid);
      expect(token).not.toBeNull();
      writeFileSync(bridgePid, relayRecord(child.pid, token));
      writeFileSync(legacyBridgePid, relayRecord(child.pid, token));
      const signals: number[] = [];
      const previous = setBridgeStopSignal((pid) => {
        signals.push(pid);
        process.kill(pid, "SIGTERM");
      });
      try {
        await runBridge({ action: "stop" });
      } finally {
        setBridgeStopSignal(previous);
      }

      expect(signals).toEqual([child.pid]);
      expect(existsSync(bridgePid)).toBe(false);
      expect(existsSync(legacyBridgePid)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "a pid file already gone after the stop reports already gone, not removed",
    async () => {
      const child = spawnChild();
      const token = processStartToken(child.pid);
      expect(token).not.toBeNull();
      writeFileSync(bridgePid, relayRecord(child.pid, token));
      const previous = setBridgeStopSignal((pid) => {
        // The daemon removes its own pid file on SIGTERM, as the real one does.
        rmSync(bridgePid);
        process.kill(pid, "SIGTERM");
      });
      const { logs, restore } = captureLogs();
      try {
        await runBridge({ action: "stop" });
      } finally {
        restore();
        setBridgeStopSignal(previous);
      }

      expect(logs.join("\n")).toMatch(/already gone/);
      expect(logs.join("\n")).not.toMatch(/removed/);
    },
    TIMEOUT,
  );

  test(
    "an EPERM stop keeps the pid file and fails",
    async () => {
      const child = spawnChild();
      const token = processStartToken(child.pid);
      expect(token).not.toBeNull();
      writeFileSync(bridgePid, relayRecord(child.pid, token));
      const previous = setBridgeStopSignal(() => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      });
      try {
        await expect(runBridge({ action: "stop" })).rejects.toThrow(
          new RegExp(`could not be stopped \\(pid ${child.pid}\\)`),
        );
      } finally {
        setBridgeStopSignal(previous);
      }

      expect(existsSync(bridgePid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "a signal failure the probe calls invalid keeps the pid file and fails",
    async () => {
      const child = spawnChild();
      writeFileSync(bridgePid, relayRecord(child.pid, childToken(child.pid)));
      const previous = setBridgeStopSignal(() => {
        throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
      });
      try {
        await expect(runBridge({ action: "stop" })).rejects.toThrow(
          new RegExp(`could not be stopped \\(pid ${child.pid}\\)`),
        );
      } finally {
        setBridgeStopSignal(previous);
      }

      expect(existsSync(bridgePid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "stop with no pid file says the bridge is not running and never mentions stale",
    async () => {
      const { logs, restore } = captureLogs();
      try {
        await runBridge({ action: "stop" });
      } finally {
        restore();
      }

      expect(logs.join("\n")).toMatch(/not running/i);
      expect(logs.join("\n")).not.toMatch(/stale/i);
    },
    TIMEOUT,
  );

  test(
    "a same-pid record whose start token changed is refused as a changed identity, not a changed pid",
    () => {
      const plannedPid = 400001;
      writeFileSync(bridgePid, relayRecord(plannedPid, "token-a"));
      const { status, result } = runRecheckChild("token", {
        PID_PATH: bridgePid,
        PID_VALUE: String(plannedPid),
      });

      expect(status).toBe(1);
      expect(result.signals).toEqual([]);
      expect(result.message).toMatch(/process identity changed/i);
      expect(result.message).not.toMatch(/not the planned pid/i);
      expect(result.message).not.toContain("token-a");
      expect(result.message).not.toContain("token-b");
    },
    TIMEOUT,
  );

  test.skipIf(gonePid === null)(
    "a kept removal on the duplicate-pid branch is reported kept and exits non-zero",
    () => {
      const pid = requireGonePid(gonePid);
      writeFileSync(bridgePid, relayRecord(pid, "token-a"));
      writeFileSync(legacyBridgePid, relayRecord(pid, "token-a"));
      const { status, result } = runRecheckChild("duplicate", {
        PID_PATH: bridgePid,
        SECOND_PATH: legacyBridgePid,
        REMOVE_FAIL_PATH: legacyBridgePid,
        PID_VALUE: String(pid),
      });

      expect(status).toBe(1);
      expect(result.message).toContain(legacyBridgePid);
      expect(result.message).toMatch(/could not be removed/);
      expect(result.message).toMatch(/kept/);
      expect(result.signals.length).toBe(1);
      expect(result.message).toMatch(/EISDIR|EPERM/);
      expect(result.logs.join("\n")).not.toMatch(/already gone/i);
      expect(result.message).not.toMatch(/\n\s+at /);
    },
    TIMEOUT,
  );
});

describe("relay and bridge commands exit non-zero on a refusal", () => {
  test(
    "relay stop with a legacy live pid exits 1 and keeps the file",
    () => {
      const child = spawnChild();
      writeFileSync(relayPid, `${child.pid}\n`);
      const result = spawnSync("node", [TPS_BIN, "mail", "relay", "stop"], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: TIMEOUT,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/identity cannot be verified/);
      expect(existsSync(relayPid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "relay start refuses a verified running relay with exit 1",
    () => {
      const child = spawnChild();
      const token = processStartToken(child.pid);
      expect(token).not.toBeNull();
      writeFileSync(relayPid, relayRecord(child.pid, token));
      const result = spawnSync("node", [TPS_BIN, "mail", "relay", "start"], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: TIMEOUT,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/already running/);
      expect(existsSync(relayPid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "relay stop with a stale mismatched token exits 0 and removes the file",
    () => {
      const child = spawnChild();
      writeFileSync(relayPid, relayRecord(child.pid, foreignStartToken(childToken(child.pid))));
      const result = spawnSync("node", [TPS_BIN, "mail", "relay", "stop"], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: TIMEOUT,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/was stale and was removed/);
      expect(existsSync(relayPid)).toBe(false);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "bridge stop with a stale mismatched token exits 0 and removes the file",
    () => {
      const child = spawnChild();
      writeFileSync(bridgePid, relayRecord(child.pid, foreignStartToken(childToken(child.pid))));
      const result = spawnSync("node", [TPS_BIN, "bridge", "stop"], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: TIMEOUT,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/stale pid file removed/i);
      expect(existsSync(bridgePid)).toBe(false);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );
});

describe("unreadable pid files", () => {
  test(
    "relay stop with a directory at the pid path exits non-zero, names it, and keeps it",
    () => {
      mkdirSync(relayPid);
      const result = spawnSync("node", [TPS_BIN, "mail", "relay", "stop"], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: TIMEOUT,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(relayPid);
      expect(result.stderr).toMatch(/could not be read/);
      expect(existsSync(relayPid)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "bridge stop with a directory at the pid path exits non-zero, names it, and keeps it",
    () => {
      mkdirSync(bridgePid);
      const result = spawnSync("node", [TPS_BIN, "bridge", "stop"], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: TIMEOUT,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(bridgePid);
      expect(result.stderr).toMatch(/is not a regular file/);
      expect(existsSync(bridgePid)).toBe(true);
    },
    TIMEOUT,
  );

  // Root ignores mode 000, so this case registers a visible skip rather than
  // asserting a read failure that cannot happen for uid 0.
  test.skipIf(process.getuid?.() === 0)(
    "relay stop with an unsearchable parent directory exits non-zero and names the file",
    () => {
      writeFileSync(relayPid, "1\n");
      const runDir = join(home, ".tps");
      let result: ReturnType<typeof spawnSync>;
      chmodSync(runDir, 0o000);
      try {
        result = spawnSync("node", [TPS_BIN, "mail", "relay", "stop"], {
          env: { ...process.env, HOME: home },
          encoding: "utf8",
          timeout: TIMEOUT,
        });
      } finally {
        chmodSync(runDir, 0o700);
      }

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(relayPid);
      expect(result.stderr).toMatch(/could not be read/);
      expect(existsSync(relayPid)).toBe(true);
    },
    TIMEOUT,
  );

  test.skipIf(process.getuid?.() === 0)(
    "bridge stop with an unsearchable run directory exits non-zero and names the directory",
    () => {
      writeFileSync(bridgePid, JSON.stringify({ pid: 1, port: 7891 }));
      const runDir = join(home, ".tps", "run");
      let result: ReturnType<typeof spawnSync>;
      chmodSync(runDir, 0o000);
      try {
        result = spawnSync("node", [TPS_BIN, "bridge", "stop"], {
          env: { ...process.env, HOME: home },
          encoding: "utf8",
          timeout: TIMEOUT,
        });
      } finally {
        chmodSync(runDir, 0o700);
      }

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(runDir);
      expect(result.stderr).toMatch(/could not be read/);
      expect(result.stderr).toMatch(/EACCES/);
      expect(existsSync(bridgePid)).toBe(true);
    },
    TIMEOUT,
  );
});

/** Wait for a pid file a spawned writer creates, with a hard wall-clock bound. */
async function waitForFile(path: string, child: Bun.Subprocess, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    if (child.exitCode !== null) throw new Error(`writer exited (${child.exitCode}) before writing ${path}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe("writer-to-reader contract", () => {
  test(
    "the BridgeCore.start record classifies running for the live process and stale after it exits",
    async () => {
      const mailDir = join(home, "bridge-mail");
      const pidPath = join(home, ".tps", "run", "bridge-stdio.pid");
      const child = Bun.spawn(
        ["node", TPS_BIN, "bridge", "start", "--adapter", "stdio", "--default-agent", "agent-a", "--mail-dir", mailDir],
        { env: { ...process.env, HOME: home }, stdio: ["ignore", "ignore", "pipe"] },
      );
      children.push(child);
      await waitForFile(pidPath, child, 10_000);

      const live = readPidFile(pidPath);
      expect(live.kind).toBe("running");
      if (live.kind === "running") expect(live.pid).toBe(child.pid);

      child.kill("SIGKILL");
      await child.exited;
      expect(readPidFile(pidPath).kind).toBe("stale");
    },
    TIMEOUT,
  );

  test(
    "the relay writer record classifies running for the live process and stale after it exits",
    async () => {
      const mailDir = join(home, "relay-mail");
      mkdirSync(mailDir, { recursive: true });
      const child = Bun.spawn(
        ["node", TPS_BIN, "mail", "relay", "_run", mailDir],
        { env: { ...process.env, HOME: home }, stdio: ["ignore", "ignore", "pipe"] },
      );
      children.push(child);
      await waitForFile(relayPid, child, 10_000);

      const live = readPidFile(relayPid);
      expect(live.kind).toBe("running");
      if (live.kind === "running") expect(live.pid).toBe(child.pid);

      child.kill("SIGKILL");
      await child.exited;
      expect(readPidFile(relayPid).kind).toBe("stale");
    },
    TIMEOUT,
  );
});
