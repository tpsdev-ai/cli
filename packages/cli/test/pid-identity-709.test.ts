/**
 * cli#709 — relay and bridge pid files carry the process start token. A stop
 * checks the recorded token immediately before signalling and refuses on a
 * mismatch; the pid can still be reused between that check and the signal, and
 * the ps fallback compares start time only to the second. These tests use real
 * child processes and real pid files under a temp HOME.
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
let legacyBridgePid: string;
let savedHome: string | undefined;
const children: Bun.Subprocess[] = [];

function spawnChild(): Bun.Subprocess {
  const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  return child;
}

/** A pid that was live and is now reaped, or null when the OS reused it. */
async function gonePid(): Promise<number | null> {
  const child = Bun.spawn(["true"], { stdio: ["ignore", "ignore", "ignore"] });
  await child.exited;
  try {
    process.kill(child.pid, 0);
    return null;
  } catch {
    return child.pid;
  }
}

function skipGonePid(): void {
  console.warn("SKIP: the reaped pid was reused before the assertion; the gone-pid case was not exercised");
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
      const gone = await gonePid();
      if (gone === null) {
        skipGonePid();
        return;
      }
      writeFileSync(relayPid, `${gone}\n`);
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
        expect(logs.join("\n")).toMatch(/invalid pid file removed/i);
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
      const gone = await gonePid();
      if (gone === null) {
        skipGonePid();
        return;
      }
      writeFileSync(bridgePid, JSON.stringify({ pid: gone, port: 7891 }));
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
    "a verified stop keeps an unverifiable second record and reports it",
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
        await runBridge({ action: "stop" });
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

  test(
    "a verified record and a stale record are both removed",
    async () => {
      const verified = spawnChild();
      const gone = await gonePid();
      if (gone === null) {
        skipGonePid();
        return;
      }
      const token = processStartToken(verified.pid);
      expect(token).not.toBeNull();
      writeFileSync(bridgePid, relayRecord(verified.pid, token));
      writeFileSync(legacyBridgePid, `${JSON.stringify({ pid: gone, port: 7891 })}\n`);
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
      expect(result.stdout).toMatch(/stale pid file removed/i);
      expect(existsSync(bridgePid)).toBe(false);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );
});
