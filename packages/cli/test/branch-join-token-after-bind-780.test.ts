/**
 * cli#780 — `tps branch init` prints "Listening on" and the join token only
 * after the join listener has bound, on both transports.
 *
 * Each case runs the real CLI against a real socket: (1) with the port already
 * held by another listener, the command exits non-zero, names the port and
 * prints no join token; (2) on a free port, the token is printed only once the
 * port accepts a connection, so a client connects on its first attempt.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bindErrorIn, holdPort, withPortRetry } from "./helpers/port.js";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");
const TRANSPORTS = ["tcp", "ws"] as const;
const WAIT_MS = 20_000;

let root: string;
const children: ChildProcess[] = [];

function launcherEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.HOME = root;
  env.TPS_ROOT = join(root, ".tps");
  env.TPS_BRANCH_NO_DAEMON = "1";
  delete env.NODE_ENV;
  delete env.TPS_AGENT_ID;
  delete env.TPS_IDENTITY_DIR;
  delete env.TPS_REGISTRY_DIR;
  return env;
}

function spawnInit(port: number, transport: (typeof TRANSPORTS)[number]): ChildProcess {
  const child = spawn(
    "node",
    [
      TPS_BIN,
      "--quiet-nono-check",
      "branch",
      "init",
      "--listen",
      String(port),
      "--host",
      "127.0.0.1",
      "--transport",
      transport,
    ],
    { env: launcherEnv(), stdio: ["ignore", "pipe", "pipe"] }
  );
  children.push(child);
  return child;
}

function collect(child: ChildProcess): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveDone, rejectDone) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectDone(new Error(`branch init did not exit within ${WAIT_MS} ms: ${output}`));
    }, WAIT_MS);
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveDone({ code, output });
    });
  });
}

/** One connection attempt, no retry. */
function connectOnce(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveConnect(connected);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/** Kill a child and wait for it to be gone before the next attempt. */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGKILL");
  await exited;
}

/** Resolve with the printed port as soon as the join token appears. */
function waitForToken(child: ChildProcess): Promise<number> {
  return new Promise((resolveToken, rejectToken) => {
    let output = "";
    const timer = setTimeout(() => {
      rejectToken(new Error(`no join token within ${WAIT_MS} ms: ${output}`));
    }, WAIT_MS);
    const onData = (chunk: Buffer) => {
      output += String(chunk);
      const failed = bindErrorIn(output);
      if (failed) {
        clearTimeout(timer);
        rejectToken(failed);
        return;
      }
      const listening = /Listening on 0\.0\.0\.0:(\d+)/.exec(output);
      if (listening && output.includes("tps://join?")) {
        clearTimeout(timer);
        resolveToken(Number(listening[1]));
      }
    };
    // `branch init` writes a bind failure to stderr; read both streams so the
    // attempt rejects at once instead of waiting out the deadline.
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // Classify the drained output when the child closes: "exit" can fire
    // before a piped stderr has drained, so a bind error can be missed.
    child.once("close", (code) => {
      clearTimeout(timer);
      rejectToken(
        bindErrorIn(output) ??
          new Error(`branch init exited (code ${code}) before printing a join token: ${output}`),
      );
    });
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tps-780-"));
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  rmSync(root, { recursive: true, force: true });
});

describe("branch init join token after bind (cli#780)", () => {
  for (const transport of TRANSPORTS) {
    test(`${transport}: a bound port exits non-zero, names it, and prints no token`, async () => {
      const { port, close } = await holdPort();
      try {
        const child = spawnInit(port, transport);
        const { code, output } = await collect(child);

        expect(code).not.toBe(0);
        expect(output).not.toContain("tps://join?");
        expect(output).toContain(`Failed to listen on 0.0.0.0:${port}`);
        expect(output).not.toContain("Join token");
        expect(output).not.toContain(`Listening on 0.0.0.0:${port}`);
      } finally {
        await close();
      }
    }, 60_000);

    test(`${transport}: the token appears once the printed port accepts a connection`, async () => {
      const { port } = await withPortRetry(async (port) => {
        rmSync(join(root, ".tps", "branch.conf.json"), { force: true });
        const child = spawnInit(port, transport);
        try {
          const printedPort = await waitForToken(child);
          expect(printedPort).toBe(port);

          // The token has just been read from stdout: connect once, with no retry.
          expect(await connectOnce(printedPort, 5_000)).toBe(true);
          return printedPort;
        } catch (error) {
          await stopChild(child);
          throw error;
        }
      });
      expect(port).toBeGreaterThan(0);
    }, 60_000);
  }

  test("tcp: a taken first port is retried and the token appears on a free one", async () => {
    const held = await holdPort();
    let attempts = 0;
    try {
      const { port } = await withPortRetry(async (port) => {
        attempts += 1;
        // A failed attempt leaves branch.conf.json behind; remove it so the
        // next attempt reaches its listener instead of the already-exists guard.
        rmSync(join(root, ".tps", "branch.conf.json"), { force: true });
        const child = spawnInit(port, "tcp");
        try {
          const printedPort = await waitForToken(child);
          expect(await connectOnce(printedPort, 5_000)).toBe(true);
          return printedPort;
        } catch (error) {
          await stopChild(child);
          throw error;
        }
      }, { firstPort: held.port });
      expect(port).toBeGreaterThan(0);
    } finally {
      await held.close();
    }
    expect(attempts).toBe(2);
  }, 60_000);
});
