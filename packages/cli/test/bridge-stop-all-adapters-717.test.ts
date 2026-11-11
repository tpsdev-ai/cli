/**
 * `BridgeCore.start` writes `bridge-<adapter>.pid`. These tests use the real
 * writer for a non-openclaw adapter under a temp HOME, plus records that name
 * real child processes, so the stop path exercises the same identity check and
 * per-record reporting as the openclaw record.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { runBridge, setBridgeStopSignal } from "../src/commands/bridge.js";
import { bridgePidFiles, bridgeStatus } from "../src/utils/mail-bridge.js";
import { readPidFile } from "../src/utils/pid-file.js";
import { patchShared } from "./helpers/patch-shared.js";

const TIMEOUT = 30_000;
const START_TIMEOUT = 10_000;
/** Room the FIFO child's deadline leaves before the timeout of the test that
 *  arms it, so a hung child reports the named error rather than bun's generic
 *  timeout. */
const FIFO_DEADLINE_MARGIN = 2_000;
const FIFO_TEST_TIMEOUT = 10_000;
const FIFO_DEADLINE = FIFO_TEST_TIMEOUT - FIFO_DEADLINE_MARGIN;
/** This test also starts a real bridge before the FIFO read, so its timeout
 *  covers START_TIMEOUT as well. */
const FIFO_STOP_TEST_TIMEOUT = FIFO_TEST_TIMEOUT + START_TIMEOUT;

/** The time a FIFO test needs: what it spends before the FIFO read, the read's
 *  deadline, and the margin. A timeout below this fails registration. */
function checkFifoTimeout(name: string, timeoutMs: number, preReadMs: number): void {
  const needed = preReadMs + FIFO_DEADLINE + FIFO_DEADLINE_MARGIN;
  if (timeoutMs < needed) {
    throw new Error(`FIFO test "${name}": timeout ${timeoutMs} ms is below ${needed} ms (pre-read ${preReadMs} + FIFO_DEADLINE ${FIFO_DEADLINE} + margin ${FIFO_DEADLINE_MARGIN})`);
  }
}

/** Names of the tests registered through fifoTest. A count, not an identity:
 *  the runFifoRead refusal below is the real backstop. */
const fifoCases: string[] = [];
/** Set only while a fifoTest body runs: when it started, the timeout it was
 *  registered with, and each deadline it armed. runFifoRead refuses without it.
 *  Sound because bun runs this file's tests serially; test.concurrent here would break it. */
let fifoBudget: { startedAt: number; timeoutMs: number; armed: { elapsedMs: number; deadlineMs: number }[] } | null = null;
/** Below this, a FIFO read is refused rather than armed with a deadline too short to mean anything. */
const FIFO_MIN_DEADLINE = 1_000;

/** The deadline a FIFO read is armed with: FIFO_DEADLINE, cut to what the
 *  test's own budget has left after the time it has already spent and the
 *  margin. Derived, not passed in, so the armed deadline always ends at least
 *  FIFO_DEADLINE_MARGIN before the test's timeout and a hung child reports the
 *  named error rather than bun's generic timeout. */
function fifoDeadline(elapsedMs: number, timeoutMs: number): number {
  const deadline = Math.min(FIFO_DEADLINE, timeoutMs - elapsedMs - FIFO_DEADLINE_MARGIN);
  if (deadline < FIFO_MIN_DEADLINE) {
    throw new Error(`FIFO read budget exceeded: ${elapsedMs} ms elapsed of ${timeoutMs} ms leaves ${deadline} ms after the ${FIFO_DEADLINE_MARGIN} ms margin (minimum ${FIFO_MIN_DEADLINE} ms)`);
  }
  return deadline;
}

/** The only way to register a test that runs a FIFO read: its own timeout is
 *  checked where it is declared, so no list can drift from the call sites. */
function fifoTest(name: string, fn: () => Promise<void>, timeoutMs: number, preReadMs = 0): void {
  checkFifoTimeout(name, timeoutMs, preReadMs);
  fifoCases.push(name);
  test(name, async () => {
    const budget = { startedAt: Date.now(), timeoutMs, armed: [] as { elapsedMs: number; deadlineMs: number }[] };
    fifoBudget = budget;
    try {
      await fn();
      // Every deadline this test actually armed ended inside its budget, margin included.
      expect(budget.armed.length).toBeGreaterThan(0);
      for (const { elapsedMs, deadlineMs } of budget.armed) {
        expect(elapsedMs + deadlineMs + FIFO_DEADLINE_MARGIN).toBeLessThanOrEqual(timeoutMs);
      }
    } finally {
      fifoBudget = null;
    }
  }, timeoutMs);
}
const CORE_URL = new URL("../src/bridge/core.js", import.meta.url).href;
const STDIO_URL = new URL("../src/bridge/stdio-adapter.js", import.meta.url).href;
const COMMANDS_URL = new URL("../src/commands/bridge.js", import.meta.url).href;
const MAIL_BRIDGE_URL = new URL("../src/utils/mail-bridge.js", import.meta.url).href;
const BUILT_PID_FILE_URL = new URL("../dist/src/utils/pid-file.js", import.meta.url).href;
const BUILT_MAIL_BRIDGE_URL = new URL("../dist/src/utils/mail-bridge.js", import.meta.url).href;
const BUILT_COMMANDS_URL = new URL("../dist/src/commands/bridge.js", import.meta.url).href;

function cannotListRestrictedDirectory(): boolean {
  const directory = mkdtempSync(join(tmpdir(), "tps-bridge-717-mode-"));
  try {
    chmodSync(directory, 0o300);
    try {
      readdirSync(directory);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
      return true;
    }
  } finally {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
}

const cannotList = cannotListRestrictedDirectory();

/** A child that starts a real BridgeCore with the stdio adapter and stays
 *  alive on its stdin pipe until SIGTERM, when it runs the real stop path. */
const BRIDGE_CHILD = `
const { BridgeCore } = await import(${JSON.stringify(CORE_URL)});
const { StdioAdapter } = await import(${JSON.stringify(STDIO_URL)});
const core = new BridgeCore(new StdioAdapter(), {
  bridgeAgentId: "stdio-bridge",
  defaultAgentId: "agent-a",
  mailDir: process.env.TPS_MAIL_DIR,
});
await core.start();
const shutdown = () => { void core.stop().then(() => process.exit(0)); };
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
console.log("READY");
`;

/** Runs `bridge start` with the real start check and a recording stand-in for
 *  the daemon, so the decision is observable without binding a port. */
const START_CHILD = `
const { mock } = await import("bun:test");
const actual = await import(${JSON.stringify(MAIL_BRIDGE_URL)});
let started = 0;
mock.module(${JSON.stringify(MAIL_BRIDGE_URL)}, () => ({
  ...actual,
  startBridgeDaemon: () => { started += 1; },
}));
const { runBridge } = await import(${JSON.stringify(COMMANDS_URL)});
try {
  await runBridge({ action: "start" });
  console.log(JSON.stringify({ started }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
`;

let home: string;
let runDir: string;
let stdioPid: string;
let legacyPid: string;
let savedHome: string | undefined;
const children: Bun.Subprocess[] = [];

function spawnSleep(): Bun.Subprocess {
  const child = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return child;
}

function spawnScript(script: string, env: Record<string, string>): Bun.Subprocess {
  const child = Bun.spawn(["bun", script], {
    env: { ...process.env, ...env, HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return child;
}

async function waitForRunning(path: string, child: Bun.Subprocess): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < START_TIMEOUT) {
    if (readPidFile(path).kind === "running") return;
    if (child.exitCode !== null) {
      throw new Error(`bridge child exited (${child.exitCode}) before writing ${path}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`bridge child did not write a running record at ${path}`);
}

/** Start the real BridgeCore.start writer for the stdio adapter. */
async function startStdioBridge(): Promise<Bun.Subprocess> {
  const script = join(home, "start-bridge.mts");
  writeFileSync(script, BRIDGE_CHILD);
  const child = spawnScript(script, { TPS_MAIL_DIR: join(home, ".tps", "mail") });
  await waitForRunning(stdioPid, child);
  return child;
}

/** Run the openclaw start path and return what it printed and its exit code. */
async function runStartDecision(): Promise<{ stdout: string; exitCode: number }> {
  const script = join(home, "start-openclaw.mts");
  writeFileSync(script, START_CHILD);
  const child = spawnScript(script, {});
  const exitCode = await child.exited;
  return { stdout: await new Response(child.stdout).text(), exitCode };
}

async function runFifoRead(script: string): Promise<Record<string, unknown>> {
  if (fifoBudget === null) throw new Error("runFifoRead runs only inside a test registered with fifoTest");
  const budget = fifoBudget;
  const path = join(home, "fifo-read.mts");
  writeFileSync(path, script);
  const child = spawnScript(path, {});
  // Sampled at arming time, after the write and the spawn, so the recorded
  // elapsed time covers everything the test spent before the timer starts.
  const elapsedMs = Date.now() - budget.startedAt;
  let deadlineMs: number;
  try {
    deadlineMs = fifoDeadline(elapsedMs, budget.timeoutMs);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  budget.armed.push({ elapsedMs, deadlineMs });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    child.kill("SIGKILL");
  }, deadlineMs);
  try {
    const exitCode = await child.exited;
    if (expired) throw new Error(`FIFO child deadline exceeded (${deadlineMs} ms)`);
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    if (exitCode !== 0) throw new Error(`FIFO child exited ${exitCode}: ${stderr}`);
    const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT:"));
    if (line === undefined) throw new Error(`FIFO child printed no result: ${stdout}`);
    return JSON.parse(line.slice("RESULT:".length));
  } finally {
    clearTimeout(timer);
  }
}

function record(pid: number, token: string | null): string {
  return `${JSON.stringify({ pid, startToken: token })}\n`;
}

function tokenOf(pid: number): string {
  const token = processStartToken(pid);
  if (token === null) throw new Error(`no start token for pid ${pid}`);
  return token;
}

beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "tps-bridge-717-"));
  process.env.HOME = home;
  runDir = join(home, ".tps", "run");
  mkdirSync(runDir, { recursive: true });
  stdioPid = join(runDir, "bridge-stdio.pid");
  legacyPid = join(runDir, "mail-bridge.pid");
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

describe("bridge stop finds the discovered bridge pid records", () => {
  test(
    "a bridge started by BridgeCore.start for the stdio adapter is stopped and its record removed",
    async () => {
      const child = await startStdioBridge();
      expect(basename(stdioPid)).toBe("bridge-stdio.pid");
      expect(readPidFile(stdioPid).kind).toBe("running");
      expect(bridgeStatus("stdio", pidState)).toEqual({ running: true, pid: child.pid, adapter: "stdio" });

      await runBridge({ action: "stop" });
      await child.exited;

      expect(pidState(child.pid)).toBe("gone");
      expect(existsSync(stdioPid)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "the records are ordered by file name",
    async () => {
      const names = ["mail-bridge.pid", "bridge-stdio.pid", "bridge-discord.pid", "bridge-openclaw.pid"];
      for (const name of names) writeFileSync(join(runDir, name), "");

      expect(bridgePidFiles().map((entry) => basename(entry.path))).toEqual([
        "bridge-discord.pid",
        "bridge-openclaw.pid",
        "bridge-stdio.pid",
        "mail-bridge.pid",
      ]);
    },
    TIMEOUT,
  );

  test(
    "a file name that is not a whole bridge pid name is ignored",
    async () => {
      const child = spawnSleep();
      const content = record(child.pid, tokenOf(child.pid));
      const ignored = ["bridge-x.pid.bak", "bridge-.pid", "bridge-Stdio.pid", "mail-bridge.pid.bak"];
      for (const name of ignored) writeFileSync(join(runDir, name), content);

      const signals: number[] = [];
      const previous = setBridgeStopSignal((pid) => signals.push(pid));
      try {
        await runBridge({ action: "stop" });
      } finally {
        setBridgeStopSignal(previous);
      }

      expect(signals).toEqual([]);
      for (const name of ignored) expect(existsSync(join(runDir, name))).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    },
    TIMEOUT,
  );

  test(
    "a run directory that cannot be read fails the stop and the status",
    async () => {
      rmSync(runDir, { recursive: true, force: true });
      writeFileSync(runDir, "not a directory");

      const stopError = await runBridge({ action: "stop" }).then(
        () => null,
        (error: Error) => error,
      );
      expect(stopError?.message).toContain(`Bridge run directory ${runDir} could not be read (ENOTDIR)`);
      expect(() => bridgeStatus("openclaw")).toThrow(`Bridge run directory ${runDir} could not be read (ENOTDIR)`);
    },
    TIMEOUT,
  );
});

describe("bridge stop timeout", () => {
  test(
    "a record that does not exit gets exactly one signal, keeps its file, and the next record is still handled",
    async () => {
      const timedOut = await startStdioBridge();
      const next = spawnSleep();
      writeFileSync(legacyPid, record(next.pid, tokenOf(next.pid)));

      const signals: number[] = [];
      const previous = setBridgeStopSignal((pid) => {
        signals.push(pid);
        // The first process never exits; the second is stopped normally.
        if (pid === next.pid) process.kill(pid, "SIGTERM");
      });
      let message = "";
      try {
        await runBridge({ action: "stop" }).catch((error) => {
          message = (error as Error).message;
        });
      } finally {
        setBridgeStopSignal(previous);
      }

      expect(signals).toEqual([timedOut.pid, next.pid]);
      expect(message).toContain(`could not be stopped (pid ${timedOut.pid})`);
      expect(existsSync(stdioPid)).toBe(true);
      expect(existsSync(legacyPid)).toBe(false);
      expect(pidState(timedOut.pid)).toBe("alive");
      await next.exited;
      expect(pidState(next.pid)).toBe("gone");
    },
    TIMEOUT,
  );
});

describe("bridge start checks only the OpenClaw records", () => {
  test(
    "a running stdio bridge does not refuse the openclaw start path",
    async () => {
      await startStdioBridge();

      const { stdout, exitCode } = await runStartDecision();

      expect(exitCode).toBe(0);
      expect(stdout).toContain('"started":1');
      expect(stdout).not.toContain("Bridge already running");
    },
    TIMEOUT,
  );

  test.skipIf(!cannotList)(
    "a run directory that cannot be listed does not refuse the openclaw start path",
    async () => {
      chmodSync(runDir, 0o300);
      try {
        const { stdout, exitCode } = await runStartDecision();

        expect(exitCode).toBe(0);
        expect(stdout).toContain('"started":1');
        expect(stdout).not.toContain("Bridge already running");
      } finally {
        chmodSync(runDir, 0o700);
      }
    },
    10_000,
  );

  for (const name of ["bridge-openclaw.pid", "mail-bridge.pid"]) {
    test(
      `a live ${name} record still refuses the openclaw start path`,
      async () => {
        const child = spawnSleep();
        writeFileSync(join(runDir, name), record(child.pid, tokenOf(child.pid)));

        const { stdout, exitCode } = await runStartDecision();

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Bridge already running");
        expect(stdout).not.toContain('"started"');
      },
      TIMEOUT,
    );
  }

  test(
    "a non-regular OpenClaw record refuses the start and names the path",
    async () => {
      const openclawPid = join(runDir, "bridge-openclaw.pid");
      mkdirSync(openclawPid);

      const { stdout, exitCode } = await runStartDecision();

      expect(exitCode).toBe(1);
      expect(stdout).toContain(
        JSON.stringify({ error: `Bridge pid file ${openclawPid} is not a regular file; refusing to start.` }),
      );
      expect(stdout).not.toContain('"started"');
    },
    TIMEOUT,
  );
});

describe("bridge status names the adapter of each running record", () => {
  test(
    "human output names the running adapters and omits a port the record does not have",
    async () => {
      const stdio = await startStdioBridge();
      const openclaw = spawnSleep();
      writeFileSync(
        join(runDir, "bridge-openclaw.pid"),
        `${JSON.stringify({ pid: openclaw.pid, startToken: tokenOf(openclaw.pid), port: 7891 })}\n`,
      );

      const lines: string[] = [];
      const restore = patchShared(console, "log", (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
      try {
        await runBridge({ action: "status" });
      } finally {
        restore();
      }

      expect(lines).toEqual([
        `Bridge running: adapter=openclaw, pid=${openclaw.pid}, port=7891`,
        `Bridge running: adapter=stdio, pid=${stdio.pid}`,
      ]);
    },
    TIMEOUT,
  );

  test(
    "json keeps the single OpenClaw fields and names the adapter",
    async () => {
      const child = spawnSleep();
      writeFileSync(
        join(runDir, "bridge-openclaw.pid"),
        `${JSON.stringify({ pid: child.pid, startToken: tokenOf(child.pid), port: 7891 })}\n`,
      );

      const lines: string[] = [];
      const restore = patchShared(console, "log", (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
      try {
        await runBridge({ action: "status", json: true });
      } finally {
        restore();
      }

      expect(JSON.parse(lines[0])).toEqual({
        running: true,
        pid: child.pid,
        port: 7891,
        adapter: "openclaw",
        bridges: [{ adapter: "openclaw", pid: child.pid, port: 7891 }],
        records: [
          {
            adapter: "openclaw",
            path: join(runDir, "bridge-openclaw.pid"),
            state: "running",
            pid: child.pid,
          },
        ],
      });
    },
    TIMEOUT,
  );

  test(
    "json lists each running adapter under the OpenClaw fields",
    async () => {
      const discord = spawnSleep();
      const openclaw = spawnSleep();
      writeFileSync(join(runDir, "bridge-discord.pid"), record(discord.pid, tokenOf(discord.pid)));
      writeFileSync(join(runDir, "bridge-openclaw.pid"), record(openclaw.pid, tokenOf(openclaw.pid)));

      const lines: string[] = [];
      const restore = patchShared(console, "log", (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
      try {
        await runBridge({ action: "status", json: true });
      } finally {
        restore();
      }

      const status = JSON.parse(lines[0]);
      expect(status.running).toBe(true);
      expect(status.pid).toBe(openclaw.pid);
      expect(status.adapter).toBe("openclaw");
      expect(status.bridges).toEqual([
        { adapter: "discord", pid: discord.pid },
        { adapter: "openclaw", pid: openclaw.pid },
      ]);
    },
    TIMEOUT,
  );

  test(
    "json reports running false when only another adapter runs",
    async () => {
      const discord = spawnSleep();
      writeFileSync(join(runDir, "bridge-discord.pid"), record(discord.pid, tokenOf(discord.pid)));

      const lines: string[] = [];
      const restore = patchShared(console, "log", (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
      try {
        await runBridge({ action: "status", json: true });
      } finally {
        restore();
      }

      expect(JSON.parse(lines[0])).toEqual({
        running: false,
        bridges: [{ adapter: "discord", pid: discord.pid }],
        records: [
          {
            adapter: "discord",
            path: join(runDir, "bridge-discord.pid"),
            state: "running",
            pid: discord.pid,
          },
        ],
      });
    },
    TIMEOUT,
  );
});

describe("FIFO deadline bounds", () => {
  test("a FIFO test timeout below pre-read + deadline + margin is refused, and exactly enough is accepted", () => {
    const needed = START_TIMEOUT + FIFO_DEADLINE + FIFO_DEADLINE_MARGIN;
    expect(() => checkFifoTimeout("probe", needed - 1, START_TIMEOUT)).toThrow("is below");
    expect(() => checkFifoTimeout("probe", needed, START_TIMEOUT)).not.toThrow();
    expect(() => checkFifoTimeout("probe", FIFO_DEADLINE + FIFO_DEADLINE_MARGIN - 1, 0)).toThrow("is below");
    // fifoTest itself refuses before registering anything, so these probes add no test.
    expect(() => fifoTest("probe", async () => {}, FIFO_DEADLINE + FIFO_DEADLINE_MARGIN - 1)).toThrow("is below");
    expect(() => fifoTest("probe", async () => {}, needed - 1, START_TIMEOUT)).toThrow("is below");
  });

  test("every test that runs a FIFO read is registered through fifoTest", () => {
    expect(fifoCases).toHaveLength(5);
  });

  test("runFifoRead refuses outside a fifoTest", async () => {
    await expect(runFifoRead("")).rejects.toThrow("only inside a test registered with fifoTest");
  });

  test("the armed FIFO deadline never runs past the test's budget less the margin", () => {
    expect(fifoDeadline(0, FIFO_TEST_TIMEOUT)).toBe(FIFO_DEADLINE);
    expect(fifoDeadline(3_000, FIFO_TEST_TIMEOUT)).toBe(FIFO_TEST_TIMEOUT - 3_000 - FIFO_DEADLINE_MARGIN);
    expect(fifoDeadline(START_TIMEOUT, FIFO_STOP_TEST_TIMEOUT)).toBe(FIFO_DEADLINE);
    for (const [elapsed, timeout] of [[0, FIFO_TEST_TIMEOUT], [3_000, FIFO_TEST_TIMEOUT], [12_500, FIFO_STOP_TEST_TIMEOUT]] as const) {
      expect(elapsed + fifoDeadline(elapsed, timeout) + FIFO_DEADLINE_MARGIN).toBeLessThanOrEqual(timeout);
    }
    expect(() => fifoDeadline(FIFO_TEST_TIMEOUT - FIFO_DEADLINE_MARGIN - FIFO_MIN_DEADLINE + 1, FIFO_TEST_TIMEOUT)).toThrow("FIFO read budget exceeded");
  });
});

describe("child environment", () => {
  test(
    "a caller's env cannot override the temp HOME",
    async () => {
      const script = join(home, "print-home.mts");
      writeFileSync(script, 'console.log("HOME:" + process.env.HOME);');
      const child = spawnScript(script, { HOME: join(home, "other") });
      const exitCode = await child.exited;
      const stdout = await new Response(child.stdout).text();

      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe(`HOME:${home}`);
    },
    TIMEOUT,
  );
});

describe("guarded pid-file reads", () => {
  // The only FIFO case whose child never exits on its own: it proves the armed
  // timer, the kill and the named error, which the prompt FIFO cases below leave
  // unexercised (~8 s).
  fifoTest("a hung FIFO child is killed at the armed deadline and reports the named error", async () => {
    await expect(runFifoRead("await new Promise(() => {});")).rejects.toThrow("FIFO child deadline exceeded");
  }, FIFO_TEST_TIMEOUT);

  fifoTest(
    "a discovered regular record replaced by a FIFO is classified without being read and kept",
    async () => {
      const fifo = join(runDir, "bridge-fifo.pid");
      writeFileSync(fifo, "");
      expect(bridgePidFiles().map((entry) => entry.path)).toEqual([fifo]);
      rmSync(fifo);
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);

      const result = await runFifoRead(`
const { readPidFile } = await import(${JSON.stringify(BUILT_PID_FILE_URL)});
console.log("RESULT:" + JSON.stringify(readPidFile(${JSON.stringify(fifo)})));
`);

      expect(result).toEqual({ kind: "unreadable", path: fifo, reason: "is not a regular file" });
      expect(existsSync(fifo)).toBe(true);
    },
    FIFO_TEST_TIMEOUT,
  );

  fifoTest("a final-component symlink is classified without reading its target and kept", async () => {
    const target = join(runDir, "target");
    const path = join(runDir, "bridge-openclaw.pid");
    expect(Bun.spawnSync(["mkfifo", target]).exitCode).toBe(0);
    symlinkSync(target, path);

    const result = await runFifoRead(`
const { readPidFile } = await import(${JSON.stringify(BUILT_PID_FILE_URL)});
console.log("RESULT:" + JSON.stringify(readPidFile(${JSON.stringify(path)})));
`);

    expect(result).toEqual({ kind: "unreadable", path, reason: "could not be opened (ELOOP: symlink resolution refused)" });
    expect(existsSync(path)).toBe(true);
  }, FIFO_TEST_TIMEOUT);

  fifoTest("a FIFO replacement before stop's fresh check is kept without signalling", async () => {
    const path = join(runDir, "bridge-fifo.pid");
    writeFileSync(path, "");

    const result = await runFifoRead(`
const { mock } = await import("bun:test");
const { rmSync } = await import("node:fs");
const real = await import(${JSON.stringify(BUILT_PID_FILE_URL)});
const read = real.readPidFile;
const path = ${JSON.stringify(path)};
let reads = 0;
let fresh;
mock.module(${JSON.stringify(BUILT_PID_FILE_URL)}, () => ({
  ...real,
  readPidFile(file, ...args) {
    const state = read(file, ...args);
    if (file !== path) return state;
    reads += 1;
    if (reads === 1) {
      rmSync(path);
      if (Bun.spawnSync(["mkfifo", path]).exitCode !== 0) throw new Error("mkfifo failed");
      return { kind: "running", path, pid: process.pid, startToken: "planned-token" };
    }
    fresh = state;
    return state;
  },
}));
const { runBridge, setBridgeStopSignal } = await import(${JSON.stringify(BUILT_COMMANDS_URL)});
const signals = [];
setBridgeStopSignal((pid) => signals.push(pid));
let message;
try { await runBridge({ action: "stop" }); } catch (error) { message = error.message; }
console.log("RESULT:" + JSON.stringify({ fresh, signals, message, reads }));
`);

    expect(result).toMatchObject({ reads: 2 });
    expect(result.fresh).toEqual({ kind: "unreadable", path, reason: "is not a regular file" });
    expect(result.signals).toEqual([]);
    expect(result.message).toContain("the pid file was kept");
    expect(existsSync(path)).toBe(true);
  }, FIFO_TEST_TIMEOUT);

  fifoTest(
    "a FIFO record is reported as kept while the other records are stopped",
    async () => {
      const child = await startStdioBridge();
      const fifo = join(runDir, "bridge-fifo.pid");
      const made = Bun.spawnSync(["mkfifo", fifo]);
      expect(made.exitCode).toBe(0);

      const result = await runFifoRead(`
const { bridgeRunningRecords } = await import(${JSON.stringify(BUILT_MAIL_BRIDGE_URL)});
const { runBridge } = await import(${JSON.stringify(BUILT_COMMANDS_URL)});
const adapters = bridgeRunningRecords().map((entry) => entry.adapter);
let message;
try { await runBridge({ action: "stop" }); } catch (error) { message = error.message; }
console.log("RESULT:" + JSON.stringify({ adapters, message }));
`);

      expect(result.adapters).toEqual(["stdio"]);
      expect(result.message).toContain(`Bridge pid file ${fifo} is not a regular file`);
      expect(result.message).toContain("the pid file was kept");
      await child.exited;
      expect(pidState(child.pid)).toBe("gone");
      expect(existsSync(stdioPid)).toBe(false);
      expect(existsSync(fifo)).toBe(true);
    },
    FIFO_STOP_TEST_TIMEOUT,
    START_TIMEOUT,
  );
});
