/**
 * cli#970 item 2 — `mail relay stop` removes the pid record only while it
 * still holds the bytes the stop read. A relay that starts and writes its own
 * record before the removal keeps it, and the output names the kept record.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { runMail, setRelayStopSignal } from "../src/commands/mail.js";

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
        `Mail relay stopped (pid=${planned.pid}); pid file ${relayPid} now belongs to a different relay process (pid ${replacement.pid}) and was kept.`,
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
        `Recorded relay process (pid ${planned.pid}) is gone; pid file ${relayPid} now belongs to a different relay process (pid ${replacement.pid}) and was kept.`,
      );
      expect(readFileSync(relayPid, "utf8")).toBe(replacementBytes);
      expect(pidState(replacement.pid)).toBe("alive");
    },
    CASE_TIMEOUT_MS,
  );
});
