/**
 * cli#954 — `mail relay stop` re-reads the pid record immediately before
 * signalling and signals only the same pid with the same start token; a record
 * that changed between the first read and the signal is reported and sends
 * nothing.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { runMail, setRelayStopRecordReader, setRelayStopSignal } from "../src/commands/mail.js";
import { readRelayPidFile } from "../src/utils/mail-relay.js";

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

function staleRecord(child: Bun.Subprocess): string {
  return record(child.pid, foreignStartToken(childToken(child.pid)));
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
    "a record that turned stale between the reads is reported and sends no signal",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, record(child.pid, childToken(child.pid)));
      expect(readRelayPidFile().kind).toBe("running");

      let reads = 0;
      const previousReader = setRelayStopRecordReader(() => {
        const state = readRelayPidFile();
        reads++;
        // The record changes after the first read, before the re-read.
        if (reads === 1) writeFileSync(relayPid, staleRecord(child));
        return state;
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

      expect(reads).toBe(2);
      expect(signals).toEqual([]);
      expect(logs.join("\n")).toContain(`Mail relay pid file ${relayPid} is now stale`);
      expect(logs.join("\n")).toContain("signalled no process");
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
        const state = readRelayPidFile();
        reads++;
        if (reads === 1) {
          writeFileSync(relayPid, record(replacement.pid, childToken(replacement.pid)));
        }
        return state;
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

      expect(reads).toBe(2);
      expect(signals).toEqual([]);
      expect(logs.join("\n")).toContain(
        `Mail relay pid file ${relayPid} now names pid ${replacement.pid}, not the pid ${planned.pid} that was read`,
      );
      expect(logs.join("\n")).toContain("signalled no process");
      expect(pidState(planned.pid)).toBe("alive");
      expect(pidState(replacement.pid)).toBe("alive");
    },
    20_000,
  );
});
