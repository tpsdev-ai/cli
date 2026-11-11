/**
 * cli#938 — follow-ups from #923: pin the mixed-record human status, the
 * signalled-path "is gone" line, non-zero exits on a relay stop refusal, and
 * the additive per-record state in `tps bridge status --json`.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { runBridge } from "../src/commands/bridge.js";
import { runMail, setRelayStopSignal } from "../src/commands/mail.js";
import { setRunDirReader, setStatusProbe } from "../src/utils/mail-bridge.js";
import { readPidFile } from "../src/utils/pid-file.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const TIMEOUT = 20_000;

let home: string;
let relayPid: string;
let runDir: string;
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

function record(pid: number, token: string | null, port?: number): string {
  const fields: Record<string, unknown> = { pid, startToken: token };
  if (port !== undefined) fields.port = port;
  return `${JSON.stringify(fields)}\n`;
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

function writeBridgeRecord(name: string, contents: string): string {
  const path = join(runDir, name);
  writeFileSync(path, contents);
  return path;
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
  home = mkdtempSync(join(tmpdir(), "tps-relay-bridge-938-"));
  process.env.HOME = home;
  runDir = join(home, ".tps", "run");
  mkdirSync(runDir, { recursive: true });
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

describe("tps bridge status with one running record and one bad record", () => {
  const badRecords: Array<{ kind: string; article: string; write: (name: string) => string }> = [
    { kind: "invalid", article: "an", write: (name) => writeBridgeRecord(name, "not-a-pid\n") },
    {
      kind: "stale",
      article: "a",
      write: (name) => writeBridgeRecord(name, staleRecord(spawnChild())),
    },
    {
      kind: "unverified",
      article: "an",
      write: (name) => writeBridgeRecord(name, record(spawnChild().pid, null)),
    },
    {
      kind: "unreadable",
      article: "an",
      write: (name) => {
        const path = join(runDir, name);
        symlinkSync(join(home, "missing-bridge-target"), path);
        return path;
      },
    },
  ];

  for (const { kind, article, write } of badRecords) {
    test(
      `${article} ${kind} record is not mentioned while a bridge is running`,
      () => {
        const child = spawnChild();
        writeBridgeRecord("bridge-openclaw.pid", record(child.pid, childToken(child.pid)));
        const badPath = write("bridge-discord.pid");

        const result = runCli(["bridge", "status"]);

        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe(`Bridge running: adapter=openclaw, pid=${child.pid}`);
        expect(result.stdout).not.toContain(badPath);
        expect(pidState(child.pid)).toBe("alive");
      },
      TIMEOUT,
    );
  }
});

describe("tps mail relay stop with a signalled record that is gone", () => {
  test(
    "prints the whole gone line and removes the pid file",
    async () => {
      const child = spawnChild();
      writeFileSync(relayPid, record(child.pid, childToken(child.pid)));
      expect(readPidFile(relayPid).kind).toBe("running");

      // The signal sender is the code's own seam. The process exits between
      // the record read and the signal, so the signal raises the kernel's
      // ESRCH for that pid.
      const previous = setRelayStopSignal((pid) => {
        expect(pid).toBe(child.pid);
        child.kill("SIGKILL");
        throw Object.assign(new Error(`kill ESRCH`), { code: "ESRCH" });
      });
      const { logs, restore } = captureLogs();
      try {
        await runMail({ action: "relay", agent: "stop" });
      } finally {
        restore();
        setRelayStopSignal(previous);
      }

      expect(logs.join("\n")).toContain(
        `Recorded relay process (pid ${child.pid}) is gone (stale pid file removed).`,
      );
      expect(existsSync(relayPid)).toBe(false);
    },
    TIMEOUT,
  );
});

describe("tps mail relay stop refusals exit non-zero", () => {
  test(
    "an unverified record prints guidance, signals nothing, keeps the file and exits 1",
    () => {
      const child = spawnChild();
      writeFileSync(relayPid, record(child.pid, null));

      const result = runCli(["mail", "relay", "stop"]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(relayPid);
      expect(result.stderr).toMatch(/identity cannot be verified/);
      expect(existsSync(relayPid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "an unreadable record prints guidance, signals nothing, keeps the file and exits 1",
    () => {
      const child = spawnChild();
      mkdirSync(relayPid);

      const result = runCli(["mail", "relay", "stop"]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(relayPid);
      expect(result.stderr).toMatch(/could not be read|is not a regular file/);
      expect(existsSync(relayPid)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );
});

describe("tps bridge status --json records", () => {
  test(
    "a bad record adds its kind and reason to records and leaves running false",
    () => {
      const badPath = writeBridgeRecord("bridge-openclaw.pid", "not-a-pid\n");

      const result = runCli(["bridge", "status", "--json"]);

      expect(result.status).toBe(0);
      const status = JSON.parse(result.stdout);
      expect(status.running).toBe(false);
      expect(status.records).toEqual([
        { adapter: "openclaw", path: badPath, state: "invalid", reason: "pid is not a whole positive decimal integer" },
      ]);
    },
    TIMEOUT,
  );

  test(
    "a running record keeps the existing fields and adds each record's state",
    () => {
      const child = spawnChild();
      const goodPath = writeBridgeRecord(
        "bridge-openclaw.pid",
        record(child.pid, childToken(child.pid), 7891),
      );
      const badPath = writeBridgeRecord("bridge-discord.pid", "not-a-pid\n");

      const result = runCli(["bridge", "status", "--json"]);

      expect(result.status).toBe(0);
      const status = JSON.parse(result.stdout);
      expect(status.running).toBe(true);
      expect(status.pid).toBe(child.pid);
      expect(status.port).toBe(7891);
      expect(status.adapter).toBe("openclaw");
      expect(status.bridges).toEqual([{ adapter: "openclaw", pid: child.pid, port: 7891 }]);
      expect(status.records).toEqual([
        { adapter: "discord", path: badPath, state: "invalid", reason: "pid is not a whole positive decimal integer" },
        { adapter: "openclaw", path: goodPath, state: "running", pid: child.pid },
      ]);
    },
    TIMEOUT,
  );

  test(
    "records names the kind of a stale, unverified and unreadable record",
    () => {
      const staleChild = spawnChild();
      const unverifiedChild = spawnChild();
      const stalePath = writeBridgeRecord("bridge-alpha.pid", staleRecord(staleChild));
      const unverifiedPath = writeBridgeRecord("bridge-beta.pid", record(unverifiedChild.pid, null));
      const unreadablePath = join(runDir, "bridge-gamma.pid");
      symlinkSync(join(home, "missing-bridge-target"), unreadablePath);

      const result = runCli(["bridge", "status", "--json"]);

      expect(result.status).toBe(0);
      const status = JSON.parse(result.stdout);
      expect(status.running).toBe(false);
      // `bridges` promotes the unverified record whose pid is alive.
      expect(status.bridges).toEqual([{ adapter: "beta", pid: unverifiedChild.pid }]);
      expect(status.records.slice(0, 2)).toEqual([
        { adapter: "alpha", path: stalePath, state: "stale", pid: staleChild.pid },
        { adapter: "beta", path: unverifiedPath, state: "unverified", pid: unverifiedChild.pid },
      ]);
      const unreadable = status.records.find((entry: { adapter: string }) => entry.adapter === "gamma");
      expect(unreadable).toMatchObject({
        adapter: "gamma",
        path: unreadablePath,
        state: "unreadable",
      });
      expect(typeof unreadable.reason).toBe("string");
      expect(unreadable.reason.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test(
    "one probe per unverified pid decides both the record and its promotion",
    async () => {
      const first = spawnChild();
      const second = spawnChild();
      const firstPath = writeBridgeRecord("bridge-alpha.pid", record(first.pid, null));
      const secondPath = writeBridgeRecord("bridge-beta.pid", record(second.pid, null));
      const thirdPath = writeBridgeRecord("bridge-gamma.pid", record(first.pid, null));

      // The seam answers alive the first time it sees a pid and gone on any
      // later call for that pid, so a second probe of one pid makes the
      // document contradict itself.
      const seen = new Map<number, number>();
      const probed: number[] = [];
      const previous = setStatusProbe((pid) => {
        probed.push(pid);
        const count = (seen.get(pid) ?? 0) + 1;
        seen.set(pid, count);
        return count === 1 ? "alive" : "gone";
      });
      const { logs, restore } = captureLogs();
      try {
        await runBridge({ action: "status", json: true });
      } finally {
        restore();
        setStatusProbe(previous);
      }

      const status = JSON.parse(logs[0]);
      expect(status.bridges).toEqual([
        { adapter: "alpha", pid: first.pid },
        { adapter: "beta", pid: second.pid },
        { adapter: "gamma", pid: first.pid },
      ]);
      expect(status.records).toEqual([
        { adapter: "alpha", path: firstPath, state: "unverified", pid: first.pid },
        { adapter: "beta", path: secondPath, state: "unverified", pid: second.pid },
        { adapter: "gamma", path: thirdPath, state: "unverified", pid: first.pid },
      ]);
      expect(probed.slice().sort((a, b) => a - b)).toEqual([first.pid, second.pid].sort((a, b) => a - b));
    },
    TIMEOUT,
  );

  test(
    "an unverified record the probe finds gone is stale and not promoted",
    async () => {
      // The child is alive, so only the seam's answer can make the record stale.
      const child = spawnChild();
      const path = writeBridgeRecord("bridge-openclaw.pid", record(child.pid, null));

      const probed: number[] = [];
      const previous = setStatusProbe((pid) => {
        probed.push(pid);
        return "gone";
      });
      const { logs, restore } = captureLogs();
      try {
        await runBridge({ action: "status", json: true });
      } finally {
        restore();
        setStatusProbe(previous);
      }

      const status = JSON.parse(logs[0]);
      expect(status.running).toBe(false);
      expect(status).not.toHaveProperty("bridges");
      expect(status.records).toEqual([{ adapter: "openclaw", path, state: "stale", pid: child.pid }]);
      expect(probed).toEqual([child.pid]);
    },
    TIMEOUT,
  );

  test(
    "an empty run directory is exactly {running:false,records:[]}",
    () => {
      const result = runCli(["bridge", "status", "--json"]);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('{"running":false,"records":[]}');
    },
    TIMEOUT,
  );

  test(
    "every field comes from one directory read",
    async () => {
      const child = spawnChild();
      writeBridgeRecord("bridge-openclaw.pid", record(child.pid, childToken(child.pid)));

      const reads: string[] = [];
      const previous = setRunDirReader((dir) => {
        reads.push(dir);
        return readdirSync(dir);
      });
      const { logs, restore } = captureLogs();
      try {
        await runBridge({ action: "status", json: true });
      } finally {
        restore();
        setRunDirReader(previous);
      }

      expect(reads).toHaveLength(1);
      const status = JSON.parse(logs[0]);
      expect(status.records).toEqual([
        { adapter: "openclaw", path: join(runDir, "bridge-openclaw.pid"), state: "running", pid: child.pid },
      ]);
      expect(status.bridges).toEqual([{ adapter: "openclaw", pid: child.pid }]);
    },
    TIMEOUT,
  );
});
