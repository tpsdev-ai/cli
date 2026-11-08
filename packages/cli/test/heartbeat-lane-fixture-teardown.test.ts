import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("../../../test/fixtures/heartbeat-lane-terminated.mjs", import.meta.url));
const WAIT_MS = 10_000;
const POLL_MS = 25;

async function waitFor<T>(read: () => T | Promise<T | null> | null, description: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let answered = "";
    socket.setEncoding("utf8");
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("data", (chunk) => {
      answered += chunk;
    });
    socket.on("end", () => resolve(answered === "ready"));
    socket.on("error", () => resolve(false));
  });
}

async function terminatedFixture(signal: NodeJS.Signals, expectedStatus: number) {
  const root = mkdtempSync(join(tmpdir(), "heartbeat-terminated-"));
  const fixture = spawn(process.env.NODE_BIN ?? "node", [FIXTURE], {
    env: { ...process.env, TEARDOWN_DIR: root },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const gatewayPid = Number(await waitFor(() => readText(join(root, "gateway.pid")), "the gateway pid"));
    const gatewayChildPid = Number(await waitFor(() => readText(join(root, "gateway-child.pid")), "the gateway child pid"));
    const port = Number(await waitFor(() => readText(join(root, "gateway.port")), "the gateway port"));
    await waitFor(() => probe(port), "the gateway to answer a readiness probe");
    expect(pidAlive(gatewayPid)).toBe(true);
    expect(pidAlive(gatewayChildPid)).toBe(true);

    const exited = once(fixture, "exit");
    fixture.kill(signal);
    const [code, signalName] = (await exited) as [number | null, string | null];

    await waitFor(() => !groupAlive(gatewayPid), "the gateway process group to exit");
    expect(pidAlive(gatewayPid)).toBe(false);
    expect(pidAlive(gatewayChildPid)).toBe(false);
    expect(signalName).toBeNull();
    expect(code).toBe(expectedStatus);
  } finally {
    if (fixture.exitCode === null && fixture.signalCode === null) {
      fixture.kill("SIGKILL");
      await once(fixture, "exit");
    }
    rmSync(root, { recursive: true, force: true });
  }
}

describe("a heartbeat-lane fixture stops its detached stub gateway when terminated", () => {
  test("SIGTERM stops the gateway's process group and re-exits with 143", async () => {
    await terminatedFixture("SIGTERM", 143);
  }, 30_000);

  test("SIGINT stops the gateway's process group and re-exits with 130", async () => {
    await terminatedFixture("SIGINT", 130);
  }, 30_000);
});
