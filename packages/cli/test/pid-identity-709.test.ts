/**
 * cli#709 — relay and bridge pid files carry the process start token, and stop
 * signals only a process whose identity matches the record. These tests use
 * real child processes and real pid files under a temp HOME.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { runMail, setRelayStopSignal } from "../src/commands/mail.js";
import { runBridge, setBridgeStopSignal } from "../src/commands/bridge.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const TIMEOUT = 20_000;

let home: string;
let relayPid: string;
let bridgePid: string;
let savedHome: string | undefined;
const children: Bun.Subprocess[] = [];

function spawnChild(): Bun.Subprocess {
  const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  return child;
}

function relayRecord(pid: number, token: string | null): string {
  return `${JSON.stringify({ pid, startToken: token })}\n`;
}

function captureLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  return { logs, restore: () => spy.mockRestore() };
}

afterEach(() => {
  mock.restore();
});

beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "tps-pid-identity-709-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".tps", "run"), { recursive: true });
  relayPid = join(home, ".tps", "relay.pid");
  bridgePid = join(home, ".tps", "run", "bridge-openclaw.pid");
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
    "a reused pid gets no signal, the stale file is removed, and the stop succeeds",
    async () => {
      const child = spawnChild();
      // A token from another process stands for a pid that has since been
      // reused: the recorded identity is not the process now holding the pid.
      writeFileSync(relayPid, relayRecord(child.pid, processStartToken(process.pid)));
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

  test(
    "a legacy file whose pid is gone is removed as stale",
    async () => {
      const child = Bun.spawn(["true"], { stdio: ["ignore", "ignore", "ignore"] });
      await child.exited;
      // A reaped pid is gone unless the OS reused it in this window.
      try {
        process.kill(child.pid, 0);
        return;
      } catch {
        /* gone, as expected */
      }
      writeFileSync(relayPid, `${child.pid}\n`);
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
        expect(logs.join("\n")).toMatch(/invalid pid file removed/i);
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
});

describe("bridge stop identity", () => {
  test(
    "a reused pid gets no signal and the stale file is removed",
    async () => {
      const child = spawnChild();
      writeFileSync(bridgePid, relayRecord(child.pid, processStartToken(process.pid)));
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

  test(
    "a legacy file whose pid is gone is removed as stale",
    async () => {
      const child = Bun.spawn(["true"], { stdio: ["ignore", "ignore", "ignore"] });
      await child.exited;
      try {
        process.kill(child.pid, 0);
        return;
      } catch {
        /* gone, as expected */
      }
      writeFileSync(bridgePid, JSON.stringify({ pid: child.pid, port: 7891 }));
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
        expect(logs.join("\n")).toMatch(/stale pid file removed/i);
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
    "relay stop with a stale reused pid exits 0 and removes the file",
    () => {
      const child = spawnChild();
      writeFileSync(relayPid, relayRecord(child.pid, processStartToken(process.pid)));
      const result = spawnSync("node", [TPS_BIN, "mail", "relay", "stop"], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: TIMEOUT,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/stale pid file removed/);
      expect(existsSync(relayPid)).toBe(false);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "bridge stop with a stale reused pid exits 0 and removes the file",
    () => {
      const child = spawnChild();
      writeFileSync(bridgePid, relayRecord(child.pid, processStartToken(process.pid)));
      const result = spawnSync("node", [TPS_BIN, "bridge", "stop"], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: TIMEOUT,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/stale pid file removed/);
      expect(existsSync(bridgePid)).toBe(false);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );
});
