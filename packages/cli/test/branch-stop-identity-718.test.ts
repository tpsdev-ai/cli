import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidState, processStartToken } from "@tpsdev-ai/agent";
import { runBranch, setBranchStopSignal } from "../src/commands/branch.js";

import { readPidFile } from "../src/utils/pid-file.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const TIMEOUT = 20_000;

let root: string;
let pidFile: string;
let savedHome: string | undefined;
let savedRoot: string | undefined;
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

/**
 * A token from the same source as `real` whose value the child cannot carry,
 * so the record is a mismatch by construction on Linux and macOS. A token
 * from a different source is "unverified", not "stale", so the source prefix
 * is kept.
 */
function foreignStartToken(real: string): string {
  if (real.startsWith("ps:")) return "ps:Thu Jan 1 00:00:00 1970";
  if (real.startsWith("proc:")) return "proc:1";
  throw new Error(`unexpected start token source: ${real}`);
}

function record(pid: number, token: string | null): string {
  return `${JSON.stringify({ pid, startToken: token })}\n`;
}

/** A pid that was live and is now reaped, or null when the spawn failed or
 *  pidState(child.pid) is not "gone" at registration. */
function reapedPid(): number | null {
  const child = spawnSync("true", []);
  if (child.pid === undefined) return null;
  return pidState(child.pid) === "gone" ? child.pid : null;
}

const gonePid = reapedPid();

/** Re-probe the registered pid; reuse after this check remains possible. */
function requireGonePid(pid: number | null): number {
  if (pid === null) throw new Error("no reaped pid was registered; rerun the test");
  if (pidState(pid) !== "gone") throw new Error(`pid ${pid} was reused after registration; rerun the test`);
  return pid;
}

async function expectRefusal(contents: string, child: Bun.Subprocess): Promise<void> {
  writeFileSync(pidFile, contents);
  const signals: number[] = [];
  const original = setBranchStopSignal((pid) => {
    signals.push(pid);
  });
  let message = "";
  try {
    await runBranch({ action: "stop" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  } finally {
    setBranchStopSignal(original);
  }
  expect(message).toContain(pidFile);
  expect(signals).toEqual([]);
  expect(existsSync(pidFile)).toBe(true);
  expect(pidState(child.pid)).toBe("alive");
}

afterEach(() => {
  mock.restore();
});

beforeEach(() => {
  savedHome = process.env.HOME;
  savedRoot = process.env.TPS_ROOT;
  root = mkdtempSync(join(tmpdir(), "tps-branch-stop-718-"));
  process.env.HOME = root;
  process.env.TPS_ROOT = join(root, ".tps");
  mkdirSync(process.env.TPS_ROOT, { recursive: true });
  pidFile = join(process.env.TPS_ROOT, "branch.pid");
});

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }
  rmSync(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedRoot === undefined) delete process.env.TPS_ROOT;
  else process.env.TPS_ROOT = savedRoot;
});

describe("branch stop PID record classification", () => {
  test("a legacy bare-pid record with a live pid is refused without a signal", async () => {
    const child = spawnChild();
    await expectRefusal(`${child.pid}\n`, child);
  });

  test("a live pid with a mismatched same-source token is not signalled; successful unlink removes its stale record", async () => {
    const child = spawnChild();
    writeFileSync(pidFile, record(child.pid, foreignStartToken(childToken(child.pid))));
    const signals: number[] = [];
    const original = setBranchStopSignal((pid) => { signals.push(pid); });
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    try {
      await runBranch({ action: "status" });
      expect(logs.join("\n")).toContain(`Branch daemon: not running (stale pid file ${pidFile}; pid ${child.pid} was not signalled)`);
      expect(existsSync(pidFile)).toBe(true);
      logs.length = 0;
      await runBranch({ action: "stop" });
    } finally {
      logSpy.mockRestore();
      setBranchStopSignal(original);
    }
    expect(signals).toEqual([]);
    expect(existsSync(pidFile)).toBe(false);
    expect(pidState(child.pid)).toBe("alive");
    expect(logs).toEqual([`Branch daemon is not running (stale PID file removed; pid ${child.pid} was not signalled).`]);
    expect(logs.join("\n")).not.toMatch(/stop it yourself|check that pid|remove .* if/i);
  });

  for (const shape of ["legacy", "unverified"] as const) {
    test(`the command exits non-zero naming the file for a live ${shape} record`, () => {
      const child = spawnChild();
      const contents =
        shape === "legacy"
          ? `${child.pid}\n`
          : record(child.pid, null);
      writeFileSync(pidFile, contents);

      const result = spawnSync("node", [TPS_BIN, "branch", "stop"], {
        env: { ...process.env },
        encoding: "utf8",
        timeout: TIMEOUT,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(pidFile);
      expect(existsSync(pidFile)).toBe(true);
      expect(pidState(child.pid)).toBe("alive");
    });
  }

  test("a matching record reaches SIGTERM and successful unlink removes the file", async () => {
    const child = spawnChild();
    writeFileSync(pidFile, record(child.pid, childToken(child.pid)));
    const signals: number[] = [];
    const original = setBranchStopSignal((pid) => {
      signals.push(pid);
      process.kill(pid, "SIGTERM");
    });
    try {
      await runBranch({ action: "stop" });
    } finally {
      setBranchStopSignal(original);
    }

    expect(signals).toEqual([child.pid]);
    expect(existsSync(pidFile)).toBe(false);
  });

  test("an invalid record naming a live process reports unknown daemon state without signalling", async () => {
    const child = spawnChild();
    writeFileSync(pidFile, JSON.stringify({ pid: child.pid, startToken: 42 }));
    const signals: number[] = [];
    const original = setBranchStopSignal((pid) => { signals.push(pid); });
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    try {
      await runBranch({ action: "status" });
      expect(logs).toEqual([`Branch daemon: unknown (invalid pid file ${pidFile})`]);
      expect(existsSync(pidFile)).toBe(true);
      logs.length = 0;
      await runBranch({ action: "stop" });
    } finally {
      logSpy.mockRestore();
      setBranchStopSignal(original);
    }
    expect(signals).toEqual([]);
    expect(existsSync(pidFile)).toBe(false);
    expect(pidState(child.pid)).toBe("alive");
    expect(logs).toEqual([`Branch PID file ${pidFile} was invalid and was removed; the branch daemon's state is unknown.`]);
  });

  test.skipIf(gonePid === null)("successful unlink removes a stale record for a dead pid", async () => {
    const pid = requireGonePid(gonePid);
    writeFileSync(pidFile, record(pid, "proc:1"));
    const signals: number[] = [];
    const original = setBranchStopSignal((signalled) => {
      signals.push(signalled);
    });
    try {
      await runBranch({ action: "stop" });
    } finally {
      setBranchStopSignal(original);
    }

    expect(signals).toEqual([]);
    expect(existsSync(pidFile)).toBe(false);
  });
});

for (const action of ["init", "start"] as const) {
  test(`${action} writer records a real child for the shared PID reader`, async () => {
    if (action === "start") writeFileSync(join(process.env.TPS_ROOT!, "branch.conf.json"), JSON.stringify({
      port: 6458, transport: "ws", agentId: "writer-agent",
    }));
    const marker = join(root, "child.pid");
    const script = join(root, "writer.ts");
    const transportPath = resolve(import.meta.dir, "../src/utils/ws-noise-transport.ts");
    const branchPath = resolve(import.meta.dir, "../src/commands/branch.ts");
    writeFileSync(script, `
      import { mock } from "bun:test";
      import * as childProcess from "node:child_process";
      import { writeFileSync } from "node:fs";
      const realSpawn = childProcess.spawn;
      mock.module("node:child_process", () => ({ ...childProcess, spawn() {
        const child = realSpawn("sleep", ["60"], { stdio: "ignore" });
        writeFileSync(${JSON.stringify(marker)}, String(child.pid));
        return child;
      }}));
      const transport = await import(${JSON.stringify(transportPath)});
      mock.module(${JSON.stringify(transportPath)}, () => ({ ...transport,
        listenForJoinWs: async () => ({ hostId: "host", hostPubkey: new Uint8Array(32),
          hostFingerprint: "fixture", channel: { async close() {} }, server: { async close() {} } }),
      }));
      const { runBranch } = await import(${JSON.stringify(branchPath)});
      await runBranch({ action: ${JSON.stringify(action)}, agent: "writer-agent" });
    `);
    const env = { ...process.env, NODE_ENV: "production" };
    delete env.TPS_BRANCH_DAEMON;
    delete env.TPS_BRANCH_NO_DAEMON;
    const writer = Bun.spawn([process.execPath, script], { env, stdio: ["ignore", "ignore", "pipe"] });
    try {
      const exit = await writer.exited;
      if (exit !== 0) throw new Error(await new Response(writer.stderr).text());
      expect(exit).toBe(0);
      const pid = Number(readFileSync(marker, "utf8"));
      expect(pidState(pid)).toBe("alive");
      const token = processStartToken(pid);
      expect(JSON.parse(readFileSync(pidFile, "utf8"))).toEqual({ pid, startToken: token });
      const state = readPidFile(pidFile);
      expect(state.kind).toBe(token === null ? "unverified" : "running");
      if (state.kind === "running" || state.kind === "unverified") expect(state.pid).toBe(pid);
    } finally {
      if (writer.exitCode === null) writer.kill("SIGKILL");
      if (existsSync(marker)) process.kill(Number(readFileSync(marker, "utf8")), "SIGKILL");
    }
  }, TIMEOUT);
}
