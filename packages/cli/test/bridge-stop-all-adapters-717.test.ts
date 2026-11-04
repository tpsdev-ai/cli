/**
 * cli#717 — `bridge stop` stops the bridges whose pid records it discovers.
 *
 * `BridgeCore.start` writes `bridge-<adapter>.pid`. These tests use the real
 * writer for a non-openclaw adapter under a temp HOME, plus records that name
 * real child processes, so the stop path exercises the same identity check and
 * per-record reporting as the openclaw record.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { runBridge, setBridgeStopSignal } from "../src/commands/bridge.js";
import { bridgePidFiles, bridgeStatus } from "../src/utils/mail-bridge.js";
import { readPidFile } from "../src/utils/pid-file.js";
import { patchShared } from "./helpers/patch-shared.js";

const TIMEOUT = 30_000;
const CORE_URL = new URL("../src/bridge/core.js", import.meta.url).href;
const STDIO_URL = new URL("../src/bridge/stdio-adapter.js", import.meta.url).href;
const COMMANDS_URL = new URL("../src/commands/bridge.js", import.meta.url).href;
const MAIL_BRIDGE_URL = new URL("../src/utils/mail-bridge.js", import.meta.url).href;

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
await runBridge({ action: "start" });
console.log(JSON.stringify({ started }));
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
    env: { ...process.env, HOME: home, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return child;
}

async function waitForRunning(path: string, child: Bun.Subprocess): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
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

/** Run the openclaw start path and return what it printed. */
async function runStartDecision(): Promise<string> {
  const script = join(home, "start-openclaw.mts");
  writeFileSync(script, START_CHILD);
  const child = spawnScript(script, {});
  await child.exited;
  return new Response(child.stdout).text();
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
      expect(bridgeStatus()).toEqual({ running: true, pid: child.pid, adapter: "stdio" });

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
      expect(() => bridgeStatus()).toThrow(`Bridge run directory ${runDir} could not be read (ENOTDIR)`);
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

      const stdout = await runStartDecision();

      expect(stdout).toContain('"started":1');
      expect(stdout).not.toContain("Bridge already running");
    },
    TIMEOUT,
  );

  for (const name of ["bridge-openclaw.pid", "mail-bridge.pid"]) {
    test(
      `a live ${name} record still refuses the openclaw start path`,
      async () => {
        const child = spawnSleep();
        writeFileSync(join(runDir, name), record(child.pid, tokenOf(child.pid)));

        const stdout = await runStartDecision();

        expect(stdout).toContain("Bridge already running");
        expect(stdout).not.toContain('"started"');
      },
      TIMEOUT,
    );
  }
});

describe("bridge status names the adapter of each running record", () => {
  test(
    "human output names the running adapters",
    async () => {
      const stdio = await startStdioBridge();
      const openclaw = spawnSleep();
      writeFileSync(join(runDir, "bridge-openclaw.pid"), record(openclaw.pid, tokenOf(openclaw.pid)));

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
        `Bridge running: adapter=openclaw, pid=${openclaw.pid}, port=undefined`,
        `Bridge running: adapter=stdio, pid=${stdio.pid}, port=undefined`,
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
      });
    },
    TIMEOUT,
  );

  test(
    "json lists each running adapter",
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
      expect(status.bridges).toEqual([
        { adapter: "discord", pid: discord.pid },
        { adapter: "openclaw", pid: openclaw.pid },
      ]);
    },
    TIMEOUT,
  );
});
