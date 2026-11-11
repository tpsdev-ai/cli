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

/** Listen on an ephemeral port and keep the listener open. */
function holdPort(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.once("error", rejectPort);
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("no address"));
        return;
      }
      resolvePort({ server, port: address.port });
    });
  });
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function freePort(): Promise<number> {
  const { server, port } = await holdPort();
  await closeServer(server);
  return port;
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

/** Resolve with the printed port as soon as the join token appears. */
function waitForToken(child: ChildProcess): Promise<number> {
  return new Promise((resolveToken, rejectToken) => {
    let output = "";
    const timer = setTimeout(() => {
      rejectToken(new Error(`no join token within ${WAIT_MS} ms: ${output}`));
    }, WAIT_MS);
    const onData = (chunk: Buffer) => {
      output += String(chunk);
      const listening = /Listening on 0\.0\.0\.0:(\d+)/.exec(output);
      if (listening && output.includes("tps://join?")) {
        clearTimeout(timer);
        resolveToken(Number(listening[1]));
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
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
      const { server, port } = await holdPort();
      try {
        const child = spawnInit(port, transport);
        const { code, output } = await collect(child);

        expect(code).not.toBe(0);
        expect(output).not.toContain("tps://join?");
        expect(output).toContain(`Failed to listen on 0.0.0.0:${port}`);
        expect(output).not.toContain("Join token");
        expect(output).not.toContain(`Listening on 0.0.0.0:${port}`);
      } finally {
        await closeServer(server);
      }
    }, 60_000);

    test(`${transport}: the token appears once the printed port accepts a connection`, async () => {
      const port = await freePort();
      const child = spawnInit(port, transport);

      const printedPort = await waitForToken(child);
      expect(printedPort).toBe(port);

      // The token has just been read from stdout: connect once, with no retry.
      expect(await connectOnce(printedPort, 5_000)).toBe(true);
    }, 60_000);
  }
});
