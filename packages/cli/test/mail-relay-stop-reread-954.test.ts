/**
 * cli#954 — `mail relay stop` re-reads the pid record immediately before
 * signalling and signals only the same pid with the same start token; a record
 * that changed between the first read and the signal is reported and sends
 * nothing.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidState, processIsGone, processStartToken } from "@tpsdev-ai/agent";
import { runMail, setRelayStopRecordReader, setRelayStopSignal } from "../src/commands/mail.js";
import { snapshotPidRecord } from "../src/utils/pid-file.js";
import { readRelayPidFile } from "../src/utils/mail-relay.js";
import type { PidFileState } from "../src/utils/pid-file.js";

let home: string;
let relayPid: string;
let savedHome: string | undefined;
const children: Bun.Subprocess[] = [];

function spawnChild(): Bun.Subprocess {
  const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  return child;
}

/** Starts `sleep` as the child of a shell this process also starts. The shell
 *  reaps it, so a killed process disappears without this process waiting on
 *  it, which a synchronous reader cannot do. */
async function spawnReapableChild(): Promise<number> {
  const shell = Bun.spawn(["sh", "-c", "sleep 60 & echo $!; wait"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  children.push(shell);
  const reader = shell.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const pid = Number(new TextDecoder().decode(value).trim());
  if (!Number.isInteger(pid) || pid < 1) throw new Error(`no child pid on stdout: ${value}`);
  return pid;
}

/** Kill `pid` and block until the process is gone, so the next reader call sees
 *  it. The synchronous wait ends on its own; it does not depend on this
 *  process reaping the pid. */
function killAndWaitGone(pid: number, token: string): void {
  process.kill(pid, "SIGKILL");
  const deadline = Date.now() + 5_000;
  while (!processIsGone(pid, token)) {
    if (Date.now() >= deadline) throw new Error(`pid ${pid} is still present`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function childToken(pid: number): string {
  const token = processStartToken(pid);
  if (token === null) throw new Error(`no start token for pid ${pid}`);
  return token;
}

/** A token from the same source as `real` whose value the child cannot carry,
 *  so the record is stale by construction on Linux and macOS. */
function foreignStartToken(real: string): string {
  if (real.startsWith("ps:")) return "ps:Thu Jan 1 00:00:00 1970";
  if (real.startsWith("proc:")) return "proc:1";
  throw new Error(`unexpected start token source: ${real}`);
}

function record(pid: number, token: string | null): string {
  return `${JSON.stringify({ pid, startToken: token })}\n`;
}

/** The refusal guidance every re-read branch appends, naming the pid the first
 *  read planned to stop. */
function guidance(pid: number): string {
  return `The relay process (pid ${pid}) may still be running; check it with ps -p ${pid} and stop it yourself.`;
}

function staleRecord(child: Bun.Subprocess): string {
  return record(child.pid, foreignStartToken(childToken(child.pid)));
}

/** Makes the first read the real record and the second read `second`, with the
 *  second snapshot's raw bytes read from the path that state names. `raw` is
 *  null when the state is missing or unreadable, or the read fails. */
function installSecondRead(second: () => PidFileState): { reads: () => number; restore: () => void } {
  let reads = 0;
  const previous = setRelayStopRecordReader(() => {
    reads++;
    if (reads === 1) return snapshotPidRecord(relayPid);
    const state = second();
    let raw: Buffer | null = null;
    if (state.kind !== "missing" && state.kind !== "unreadable") {
      try {
        raw = readFileSync(state.path);
      } catch {
        raw = null;
      }
    }
    return { state, raw };
  });
  return { reads: () => reads, restore: () => setRelayStopRecordReader(previous) };
}

function captureSignals(): { signals: number[]; restore: () => void } {
  const signals: number[] = [];
  const previous = setRelayStopSignal((pid) => signals.push(pid));
  return { signals, restore: () => setRelayStopSignal(previous) };
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

beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "tps-relay-stop-reread-954-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".tps"), { recursive: true });
  relayPid = join(home, ".tps", "relay.pid");
});

// Every spy is restored even when an assertion throws.
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

describe("mail relay stop re-reads the record before signalling", () => {
  test(
    "a process killed and reaped between the reads is a completed stop and sends no signal",
    async () => {
      const pid = await spawnReapableChild();
      const token = childToken(pid);
      writeFileSync(relayPid, record(pid, token));
      expect(readRelayPidFile().kind).toBe("running");

      let reads = 0;
      const previousReader = setRelayStopRecordReader(() => {
        reads++;
        // The process the first read verified dies before the re-read.
        if (reads === 2) killAndWaitGone(pid, token);
        return snapshotPidRecord(relayPid);
      });
      const signals: number[] = [];
      const previousSignal = setRelayStopSignal((signalled) => signals.push(signalled));
      const { logs, restore } = captureLogs();
      try {
        await runMail({ action: "relay", agent: "stop" });
      } finally {
        restore();
        setRelayStopSignal(previousSignal);
        setRelayStopRecordReader(previousReader);
      }

      expect(reads).toBe(2);
      expect(signals).toEqual([]);
      expect(logs.join("\n")).toContain(`Mail relay stopped (pid=${pid}); pid file ${relayPid} is stale.`);
      expect(existsSync(relayPid)).toBe(true);
    },
    20_000,
  );

  test(
    "a record rewritten to the same pid with a different start token exits non-zero, keeps the record, and sends no signal",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, record(child.pid, childToken(child.pid)));
      expect(readRelayPidFile().kind).toBe("running");

      const rewritten = staleRecord(child);
      let reads = 0;
      const previousReader = setRelayStopRecordReader(() => {
        const snapshot = snapshotPidRecord(relayPid);
        reads++;
        // The record changes after the first read, before the re-read.
        if (reads === 1) writeFileSync(relayPid, rewritten);
        return snapshot;
      });
      const signals: number[] = [];
      const previousSignal = setRelayStopSignal((signalled) => signals.push(signalled));
      let error: Error | null = null;
      try {
        error = await runMail({ action: "relay", agent: "stop" }).then(
          () => null,
          (thrown: Error) => thrown,
        );
      } finally {
        setRelayStopSignal(previousSignal);
        setRelayStopRecordReader(previousReader);
      }

      expect(error?.message).toContain(`holds a stale record for pid ${child.pid}, but it does not prove the process this command verified is gone`);
      expect(error?.message).toContain(guidance(child.pid));
      expect(reads).toBe(2);
      expect(signals).toEqual([]);
      expect(readFileSync(relayPid, "utf8")).toBe(rewritten);
      expect(pidState(child.pid)).toBe("alive");
    },
    20_000,
  );

  test(
    "a second read that is stale under a different pid exits non-zero and sends no signal",
    async () => {
      const child = spawnChild();
      const other = spawnChild();
      writeFileSync(relayPid, record(child.pid, childToken(child.pid)));

      const reader = installSecondRead(() => ({ kind: "stale", path: relayPid, pid: other.pid }));
      const signalling = captureSignals();
      let error: Error | null = null;
      try {
        error = await runMail({ action: "relay", agent: "stop" }).then(
          () => null,
          (thrown: Error) => thrown,
        );
      } finally {
        signalling.restore();
        reader.restore();
      }

      expect(error?.message).toContain(`now holds a stale record for pid ${other.pid}, not the pid ${child.pid}`);
      expect(error?.message).toContain(guidance(child.pid));
      expect(error?.message).not.toContain(`ps -p ${other.pid}`);
      expect(reader.reads()).toBe(2);
      expect(signalling.signals).toEqual([]);
      expect(existsSync(relayPid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    20_000,
  );

  test(
    "a record replaced by another running pid is reported and sends no signal",
    async () => {
      const planned = spawnChild();
      const replacement = spawnChild();
      writeFileSync(relayPid, record(planned.pid, childToken(planned.pid)));

      let reads = 0;
      const previousReader = setRelayStopRecordReader(() => {
        const snapshot = snapshotPidRecord(relayPid);
        reads++;
        if (reads === 1) {
          writeFileSync(relayPid, record(replacement.pid, childToken(replacement.pid)));
        }
        return snapshot;
      });
      const signals: number[] = [];
      const previousSignal = setRelayStopSignal((pid) => signals.push(pid));
      let error: Error | null = null;
      try {
        error = await runMail({ action: "relay", agent: "stop" }).then(
          () => null,
          (thrown: Error) => thrown,
        );
      } finally {
        setRelayStopSignal(previousSignal);
        setRelayStopRecordReader(previousReader);
      }

      expect(error?.message).toContain(`Mail relay pid file ${relayPid} now names pid ${replacement.pid}, not the pid ${planned.pid} that was read`);
      expect(error?.message).toContain(guidance(planned.pid));
      expect(error?.message).not.toContain(`ps -p ${replacement.pid}`);
      expect(reads).toBe(2);
      expect(signals).toEqual([]);
      expect(pidState(planned.pid)).toBe("alive");
      expect(pidState(replacement.pid)).toBe("alive");
    },
    20_000,
  );

  test(
    "a record whose start token changed for the same pid is reported and sends no signal",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, record(child.pid, childToken(child.pid)));
      expect(readRelayPidFile().kind).toBe("running");

      const reader = installSecondRead(() => ({
        kind: "running",
        path: relayPid,
        pid: child.pid,
        startToken: foreignStartToken(childToken(child.pid)),
      }));
      const signalling = captureSignals();
      let error: Error | null = null;
      try {
        error = await runMail({ action: "relay", agent: "stop" }).then(
          () => null,
          (thrown: Error) => thrown,
        );
      } finally {
        signalling.restore();
        reader.restore();
      }

      expect(error?.message).toContain(`Mail relay pid file ${relayPid} still names pid ${child.pid}, but its start token changed before it was signalled`);
      expect(error?.message).toContain(guidance(child.pid));
      expect(reader.reads()).toBe(2);
      expect(signalling.signals).toEqual([]);
      expect(pidState(child.pid)).toBe("alive");
    },
    20_000,
  );

  test(
    "a second read that is unreadable refuses and sends no signal",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, record(child.pid, childToken(child.pid)));

      const reader = installSecondRead(() => ({ kind: "unreadable", path: relayPid }));
      const signalling = captureSignals();
      let error: Error | null = null;
      try {
        error = await runMail({ action: "relay", agent: "stop" }).then(
          () => null,
          (thrown: Error) => thrown,
        );
      } finally {
        signalling.restore();
        reader.restore();
      }

      expect(error?.message).toContain(`Mail relay pid file ${relayPid} could not be re-read`);
      expect(error?.message).toContain(guidance(child.pid));
      expect(reader.reads()).toBe(2);
      expect(signalling.signals).toEqual([]);
      expect(pidState(child.pid)).toBe("alive");
    },
    20_000,
  );

  test(
    "a second read that is missing exits non-zero and sends no signal",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, record(child.pid, childToken(child.pid)));

      const reader = installSecondRead(() => ({ kind: "missing" }));
      const signalling = captureSignals();
      let error: Error | null = null;
      try {
        error = await runMail({ action: "relay", agent: "stop" }).then(
          () => null,
          (thrown: Error) => thrown,
        );
      } finally {
        signalling.restore();
        reader.restore();
      }

      expect(error?.message).toContain("disappeared before it was signalled");
      expect(error?.message).toContain(guidance(child.pid));
      expect(reader.reads()).toBe(2);
      expect(signalling.signals).toEqual([]);
      expect(existsSync(relayPid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    20_000,
  );

  test(
    "a second read that is invalid exits non-zero and sends no signal",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, record(child.pid, childToken(child.pid)));

      const reader = installSecondRead(() => ({ kind: "invalid", path: relayPid, reason: "not a JSON object" }));
      const signalling = captureSignals();
      let error: Error | null = null;
      try {
        error = await runMail({ action: "relay", agent: "stop" }).then(
          () => null,
          (thrown: Error) => thrown,
        );
      } finally {
        signalling.restore();
        reader.restore();
      }

      expect(error?.message).toContain(`Mail relay pid file ${relayPid} is now invalid`);
      expect(error?.message).toContain(guidance(child.pid));
      expect(reader.reads()).toBe(2);
      expect(signalling.signals).toEqual([]);
      expect(existsSync(relayPid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    20_000,
  );

  test(
    "a second read that is unverified refuses and sends no signal",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, record(child.pid, childToken(child.pid)));

      const reader = installSecondRead(() => ({ kind: "unverified", path: relayPid, pid: child.pid, startToken: null }));
      const signalling = captureSignals();
      let error: Error | null = null;
      try {
        error = await runMail({ action: "relay", agent: "stop" }).then(
          () => null,
          (thrown: Error) => thrown,
        );
      } finally {
        signalling.restore();
        reader.restore();
      }

      expect(error?.message).toContain(`Mail relay pid file ${relayPid} now names pid ${child.pid}, but that process's identity cannot be verified`);
      expect(error?.message).toContain(guidance(child.pid));
      expect(reader.reads()).toBe(2);
      expect(signalling.signals).toEqual([]);
      expect(pidState(child.pid)).toBe("alive");
    },
    20_000,
  );
});
