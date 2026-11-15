/**
 * cli#970 item 2 — `mail relay stop` compares the relay pid record's bytes
 * before it removes the path, at the two removal sites after a signal and
 * before removing a stale or invalid record. A record a new relay wrote after
 * that read is kept and the output names the kept record. With no record lock,
 * a write between the compare and the unlink can still be removed.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { runMail, setRelayStopRecordReader, setRelayStopSignal } from "../src/commands/mail.js";
import { snapshotPidRecord } from "../src/utils/pid-file.js";

const CASE_TIMEOUT_MS = 20_000;
const WAIT_DEADLINE_MS = 5_000;

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

function record(pid: number, token: string): string {
  return `${JSON.stringify({ pid, startToken: token })}\n`;
}

/** A token from the same source as `real` whose value the child cannot carry,
 *  so the record is stale by construction on Linux and macOS. */
function foreignStartToken(real: string): string {
  if (real.startsWith("ps:")) return "ps:Thu Jan 1 00:00:00 1970";
  if (real.startsWith("proc:")) return "proc:1";
  throw new Error(`unexpected start token source: ${real}`);
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

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${WAIT_DEADLINE_MS} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Replace the record with a directory: `readPidFile` reports it unreadable for
 *  every uid, root included. */
function leaveUnreadableRecord(): void {
  rmSync(relayPid);
  mkdirSync(relayPid);
}

beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "tps-relay-stop-replaced-970-"));
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

describe("mail relay stop keeps a record replaced before removal", () => {
  test(
    "a record replaced by a live relay after the first relay exits is kept and named",
    async () => {
      const planned = spawnChild();
      const replacement = spawnChild();
      const plannedBytes = record(planned.pid, childToken(planned.pid));
      const replacementBytes = record(replacement.pid, childToken(replacement.pid));
      writeFileSync(relayPid, plannedBytes);

      const previousSignal = setRelayStopSignal((pid) => {
        // The targeted relay exits, and a new relay writes its record before
        // the stop reaches its removal step.
        process.kill(pid, "SIGKILL");
        writeFileSync(relayPid, replacementBytes);
      });
      const { logs, restore } = captureLogs();
      try {
        await runMail({ action: "relay", agent: "stop" });
      } finally {
        restore();
        setRelayStopSignal(previousSignal);
      }

      await waitUntil(() => pidState(planned.pid) === "gone", "the targeted relay to exit");
      expect(logs.join("\n")).toContain(
        `Mail relay stopped (pid=${planned.pid}); pid file ${relayPid} now belongs to a different process (pid ${replacement.pid}) and was kept.`,
      );
      expect(readFileSync(relayPid, "utf8")).toBe(replacementBytes);
      expect(pidState(replacement.pid)).toBe("alive");
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a record replaced by a live relay before the gone-branch removal is kept and named",
    async () => {
      const planned = spawnChild();
      const replacement = spawnChild();
      const plannedBytes = record(planned.pid, childToken(planned.pid));
      const replacementBytes = record(replacement.pid, childToken(replacement.pid));
      writeFileSync(relayPid, plannedBytes);

      const previousSignal = setRelayStopSignal((pid) => {
        // The signal finds the targeted pid gone, and a new relay has already
        // written its record at the same path.
        process.kill(pid, "SIGKILL");
        writeFileSync(relayPid, replacementBytes);
        throw Object.assign(new Error(`kill ESRCH (pid ${pid})`), { code: "ESRCH" });
      });
      const { logs, restore } = captureLogs();
      try {
        await runMail({ action: "relay", agent: "stop" });
      } finally {
        restore();
        setRelayStopSignal(previousSignal);
      }

      await waitUntil(() => pidState(planned.pid) === "gone", "the targeted relay to exit");
      expect(logs.join("\n")).toContain(
        `Recorded relay process (pid ${planned.pid}) is gone; pid file ${relayPid} now belongs to a different process (pid ${replacement.pid}) and was kept.`,
      );
      expect(readFileSync(relayPid, "utf8")).toBe(replacementBytes);
      expect(pidState(replacement.pid)).toBe("alive");
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a record rewritten after the pre-signal snapshot is kept and its process is not signalled",
    async () => {
      const planned = spawnChild();
      const replacement = spawnChild();
      writeFileSync(relayPid, record(planned.pid, childToken(planned.pid)));
      const replacementBytes = record(replacement.pid, childToken(replacement.pid));

      let reads = 0;
      const previousReader = setRelayStopRecordReader(() => {
        const snapshot = snapshotPidRecord(relayPid);
        reads++;
        // The pre-signal snapshot names the planned relay; the record changes
        // after that read and before the signal goes out.
        if (reads === 2) writeFileSync(relayPid, replacementBytes);
        return snapshot;
      });
      const signals: number[] = [];
      const previousSignal = setRelayStopSignal((pid) => {
        signals.push(pid);
        process.kill(pid, "SIGKILL");
      });
      const { logs, restore } = captureLogs();
      try {
        await runMail({ action: "relay", agent: "stop" });
      } finally {
        restore();
        setRelayStopSignal(previousSignal);
        setRelayStopRecordReader(previousReader);
      }

      await waitUntil(() => pidState(planned.pid) === "gone", "the targeted relay to exit");
      expect(reads).toBe(2);
      expect(signals).toEqual([planned.pid]);
      expect(pidState(replacement.pid)).toBe("alive");
      expect(logs.join("\n")).toContain(
        `Mail relay stopped (pid=${planned.pid}); pid file ${relayPid} now belongs to a different process (pid ${replacement.pid}) and was kept.`,
      );
      expect(readFileSync(relayPid, "utf8")).toBe(replacementBytes);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a record left unreadable after the relay exits fails the stop at the final check",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, record(child.pid, childToken(child.pid)));

      const previousSignal = setRelayStopSignal((pid) => {
        process.kill(pid, "SIGKILL");
        leaveUnreadableRecord();
      });
      try {
        await expect(runMail({ action: "relay", agent: "stop" })).rejects.toThrow(
          "could not be read at the final check",
        );
      } finally {
        setRelayStopSignal(previousSignal);
      }

      await waitUntil(() => pidState(child.pid) === "gone", "the targeted relay to exit");
      expect(existsSync(relayPid)).toBe(true);
      expect(statSync(relayPid).isDirectory()).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a record left unreadable in the gone branch fails the stop at the final check",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, record(child.pid, childToken(child.pid)));

      const previousSignal = setRelayStopSignal((pid) => {
        process.kill(pid, "SIGKILL");
        leaveUnreadableRecord();
        throw Object.assign(new Error(`kill ESRCH (pid ${pid})`), { code: "ESRCH" });
      });
      try {
        await expect(runMail({ action: "relay", agent: "stop" })).rejects.toThrow(
          "could not be read at the final check",
        );
      } finally {
        setRelayStopSignal(previousSignal);
      }

      await waitUntil(() => pidState(child.pid) === "gone", "the targeted relay to exit");
      expect(existsSync(relayPid)).toBe(true);
      expect(statSync(relayPid).isDirectory()).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a record rewritten with the same pid and different bytes before removal is kept",
    async () => {
      const child = spawnChild();
      const token = childToken(child.pid);
      writeFileSync(relayPid, record(child.pid, token));
      // The same identity, serialized with the keys in the other order.
      const rewritten = `${JSON.stringify({ startToken: token, pid: child.pid })}\n`;

      const previousSignal = setRelayStopSignal((pid) => {
        process.kill(pid, "SIGKILL");
        writeFileSync(relayPid, rewritten);
      });
      const { logs, restore } = captureLogs();
      try {
        await runMail({ action: "relay", agent: "stop" });
      } finally {
        restore();
        setRelayStopSignal(previousSignal);
      }

      await waitUntil(() => pidState(child.pid) === "gone", "the targeted relay to exit");
      expect(logs.join("\n")).toContain(
        `Mail relay stopped (pid=${child.pid}); pid file ${relayPid} no longer holds the record this stop read and was kept.`,
      );
      expect(readFileSync(relayPid, "utf8")).toBe(rewritten);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a record rewritten to name a different, gone pid before removal is kept",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, record(child.pid, childToken(child.pid)));
      const other = spawnChild();
      const otherBytes = record(other.pid, childToken(other.pid));
      process.kill(other.pid, "SIGKILL");
      await waitUntil(() => pidState(other.pid) === "gone", "the other child to exit");

      const previousSignal = setRelayStopSignal((pid) => {
        process.kill(pid, "SIGKILL");
        writeFileSync(relayPid, otherBytes);
      });
      const { logs, restore } = captureLogs();
      try {
        await runMail({ action: "relay", agent: "stop" });
      } finally {
        restore();
        setRelayStopSignal(previousSignal);
      }

      await waitUntil(() => pidState(child.pid) === "gone", "the targeted relay to exit");
      expect(logs.join("\n")).toContain(
        `Mail relay stopped (pid=${child.pid}); pid file ${relayPid} no longer holds the record this stop read and was kept.`,
      );
      expect(readFileSync(relayPid, "utf8")).toBe(otherBytes);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a record rewritten after the first read is not signalled",
    async () => {
      const planned = spawnChild();
      const replacement = spawnChild();
      writeFileSync(relayPid, record(planned.pid, childToken(planned.pid)));
      const replacementBytes = record(replacement.pid, childToken(replacement.pid));

      let reads = 0;
      const previousReader = setRelayStopRecordReader(() => {
        const snapshot = snapshotPidRecord(relayPid);
        reads++;
        if (reads === 1) writeFileSync(relayPid, replacementBytes);
        return snapshot;
      });
      const signals: number[] = [];
      const previousSignal = setRelayStopSignal((pid) => signals.push(pid));
      try {
        await expect(runMail({ action: "relay", agent: "stop" })).rejects.toThrow(
          `Mail relay pid file ${relayPid} now names pid ${replacement.pid}, not the pid ${planned.pid} that was read`,
        );
      } finally {
        setRelayStopSignal(previousSignal);
        setRelayStopRecordReader(previousReader);
      }

      expect(reads).toBe(2);
      expect(signals).toEqual([]);
      expect(readFileSync(relayPid, "utf8")).toBe(replacementBytes);
      expect(pidState(planned.pid)).toBe("alive");
      expect(pidState(replacement.pid)).toBe("alive");
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a stale record replaced by a live relay before its removal is kept and named",
    async () => {
      const planned = spawnChild();
      const replacement = spawnChild();
      const staleBytes = record(planned.pid, foreignStartToken(childToken(planned.pid)));
      const replacementBytes = record(replacement.pid, childToken(replacement.pid));
      writeFileSync(relayPid, staleBytes);

      let reads = 0;
      const previousReader = setRelayStopRecordReader(() => {
        const snapshot = snapshotPidRecord(relayPid);
        reads++;
        // The classification reads the stale record; a live relay writes its
        // own record before the removal check.
        if (reads === 1) writeFileSync(relayPid, replacementBytes);
        return snapshot;
      });
      const signals: number[] = [];
      const previousSignal = setRelayStopSignal((pid) => signals.push(pid));
      const { logs, restore } = captureLogs();
      try {
        await runMail({ action: "relay", agent: "stop" });
      } finally {
        restore();
        setRelayStopSignal(previousSignal);
        setRelayStopRecordReader(previousReader);
      }

      expect(reads).toBe(1);
      expect(signals).toEqual([]);
      expect(logs.join("\n")).toContain(
        `Mail relay pid file ${relayPid} was stale; pid file ${relayPid} now belongs to a different process (pid ${replacement.pid}) and was kept. This command signalled no process, and the relay's state is unknown.`,
      );
      expect(readFileSync(relayPid, "utf8")).toBe(replacementBytes);
      expect(pidState(replacement.pid)).toBe("alive");
      expect(pidState(planned.pid)).toBe("alive");
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a stale record left unreadable at the final check fails the stop",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, record(child.pid, foreignStartToken(childToken(child.pid))));
      const stale = snapshotPidRecord(relayPid);
      expect(stale.state.kind).toBe("stale");
      // The classification read returns the stale snapshot; the re-read in
      // `reportBadRecord` then finds a directory at the path.
      leaveUnreadableRecord();

      let reads = 0;
      const previousReader = setRelayStopRecordReader(() => {
        reads++;
        return stale;
      });
      try {
        await expect(runMail({ action: "relay", agent: "stop" })).rejects.toThrow(
          `Mail relay pid file ${relayPid} was stale and could not be read at the final check`,
        );
      } finally {
        setRelayStopRecordReader(previousReader);
      }

      expect(reads).toBe(1);
      expect(existsSync(relayPid)).toBe(true);
      expect(statSync(relayPid).isDirectory()).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "an unchanged stale record is still removed",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, record(child.pid, foreignStartToken(childToken(child.pid))));

      const signals: number[] = [];
      const previousSignal = setRelayStopSignal((pid) => signals.push(pid));
      const { logs, restore } = captureLogs();
      try {
        await runMail({ action: "relay", agent: "stop" });
      } finally {
        restore();
        setRelayStopSignal(previousSignal);
      }

      expect(signals).toEqual([]);
      expect(logs.join("\n")).toContain(
        `Mail relay pid file ${relayPid} was stale and was removed; this command signalled no process, and the relay's state is unknown.`,
      );
      expect(existsSync(relayPid)).toBe(false);
      expect(pidState(child.pid)).toBe("alive");
    },
    CASE_TIMEOUT_MS,
  );
});
