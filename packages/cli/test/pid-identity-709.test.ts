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
import { runMail, setRelayStopSignal } from "../src/commands/mail.js";
import { runBridge, setBridgeStopSignal } from "../src/commands/bridge.js";
import { readPidFile } from "../src/utils/pid-file.js";

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
function reapedPid(): number | null {
  const child = spawnSync("true", []);
  if (child.pid === undefined) return null;
  try {
    process.kill(child.pid, 0);
    return null;
  } catch {
    return child.pid;
  }
}

/** Resolved once at registration so a reused pid registers a visible skip. */
const gonePid = reapedPid();

function relayRecord(pid: number, token: string | null): string {
  return `${JSON.stringify({ pid, startToken: token })}\n`;
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

  test.skipIf(gonePid === null)(
    "a legacy file whose pid is gone is removed as stale",
    async () => {
      writeFileSync(relayPid, `${gonePid}\n`);
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

  test(
    "a pid file that cannot be removed is reported kept and the stop exits non-zero",
    async () => {
      const child = spawnChild();
      const token = processStartToken(child.pid);
      expect(token).not.toBeNull();
      writeFileSync(relayPid, relayRecord(child.pid, token));
      const previous = setRelayStopSignal((pid) => {
        // A non-empty directory in the file's place fails unlink for every uid,
        // root included.
        rmSync(relayPid);
        mkdirSync(relayPid);
        writeFileSync(join(relayPid, "keep"), "x");
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
    "a mismatched token gets no signal and the stale file is removed",
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

  test.skipIf(gonePid === null)(
    "a legacy file whose pid is gone is removed as stale",
    async () => {
      writeFileSync(bridgePid, JSON.stringify({ pid: gonePid, port: 7891 }));
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
      writeFileSync(legacyBridgePid, `${JSON.stringify({ pid: gonePid, port: 7891 })}\n`);
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
      writeFileSync(legacyBridgePid, `${JSON.stringify({ pid: gonePid, port: 7891 })}\n`);
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
    "relay stop with a stale mismatched token exits 0 and removes the file",
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
    "bridge stop with a stale mismatched token exits 0 and removes the file",
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
      expect(result.stderr).toMatch(/could not be read/);
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
    "bridge stop with an unsearchable parent directory exits non-zero and names the file",
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
      expect(result.stderr).toContain(bridgePid);
      expect(result.stderr).toMatch(/could not be read/);
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
