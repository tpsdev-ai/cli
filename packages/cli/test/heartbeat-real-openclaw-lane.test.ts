import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import net from "node:net";
import { assertPortClosed, stopGateway, waitForRpc } from "../../../scripts/heartbeat-real-openclaw-lane.mjs";

const CASE_STUB = { home: "/nonexistent/home", stateDir: "", configPath: "", flairPort: 1 };
const GATEWAY_RUNNING = { exitCode: null };

function blockedFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

class FakeSocket extends EventEmitter {
  setTimeout(_ms: number): void {}
  destroy(): void {}
}

function fakeConnect(event: string, value?: unknown) {
  return () => {
    const socket = new FakeSocket();
    setTimeout(() => socket.emit(event, value), 0);
    return socket as unknown as net.Socket;
  };
}

async function refusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listener has no port");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

describe("the dead-gateway precondition accepts only a refused connection", () => {
  test("a loopback port that refuses connections passes", async () => {
    await expect(assertPortClosed(await refusedPort())).resolves.toBeUndefined();
  });

  test("a probe timeout fails the lane and names the timeout", async () => {
    await expect(assertPortClosed(9, { connect: fakeConnect("timeout"), timeoutMs: 5 })).rejects.toThrow(
      /probe of 127\.0\.0\.1:9 timed out after 5ms/,
    );
  });

  test("a socket error other than ECONNREFUSED fails the lane and names the error", async () => {
    const error = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    await expect(assertPortClosed(9, { connect: fakeConnect("error", error) })).rejects.toThrow(
      /probe of 127\.0\.0\.1:9 failed: ECONNRESET/,
    );
  });

  test("a listening port fails the dead-gateway precondition", async () => {
    await expect(assertPortClosed(9, { connect: fakeConnect("connect") })).rejects.toThrow(
      /needs a port that refuses connections/,
    );
  });
});

describe("the readiness deadline bounds each probe", () => {
  test("a success observed after the deadline is rejected", async () => {
    const runStatus = () => {
      blockedFor(150);
      return { status: 0, stdout: "", stderr: "" };
    };
    await expect(
      waitForRpc(CASE_STUB, 9, "/nonexistent/bin", GATEWAY_RUNNING, "/nonexistent/log", {
        timeoutMs: 100,
        pollMs: 5,
        runStatus,
      }),
    ).rejects.toThrow(/answered --require-rpc after the 0\.1s readiness deadline/);
  });

  test("a probe timeout never exceeds the time left before the deadline", async () => {
    const budgetMs = 60;
    const probeTimeouts: number[] = [];
    const runStatus = ({ timeout }: { timeout: number }) => {
      probeTimeouts.push(timeout);
      return { status: 1, stdout: "", stderr: "" };
    };
    await expect(
      waitForRpc(CASE_STUB, 9, "/nonexistent/bin", GATEWAY_RUNNING, "/nonexistent/log", {
        timeoutMs: budgetMs,
        pollMs: 10,
        probeTimeoutMs: 60_000,
        runStatus,
      }),
    ).rejects.toThrow(/did not answer --require-rpc within 0\.06s/);
    expect(probeTimeouts.length).toBeGreaterThan(1);
    for (const timeout of probeTimeouts) expect(timeout).toBeLessThanOrEqual(budgetMs);
    expect(probeTimeouts.at(-1)).toBeLessThan(probeTimeouts[0]);
  });
});

describe("cleanup fails the lane when the gateway does not exit", () => {
  test("an exit never confirmed after SIGKILL names the pid", async () => {
    const signals: string[] = [];
    const child = { pid: 4321, exitCode: null };
    await expect(
      stopGateway(child, { graceMs: 20, killMs: 30, pollMs: 5, signalGroup: (signal: string) => signals.push(signal) }),
    ).rejects.toThrow(/gateway process 4321 did not exit after SIGKILL/);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("an exit by SIGKILL is confirmed by the signal", async () => {
    const child: { pid: number; exitCode: number | null; signalCode?: string | null } = { pid: 4323, exitCode: null };
    await stopGateway(child, {
      graceMs: 10,
      killMs: 30,
      pollMs: 5,
      signalGroup: (signal: string) => {
        if (signal === "SIGKILL") child.signalCode = "SIGKILL";
      },
    });
    expect(child.signalCode).toBe("SIGKILL");
  });

  test("an exit confirmed during the SIGTERM grace period succeeds", async () => {
    const child: { pid: number; exitCode: number | null } = { pid: 4322, exitCode: null };
    await stopGateway(child, {
      graceMs: 20,
      killMs: 30,
      pollMs: 5,
      signalGroup: (signal: string) => {
        if (signal === "SIGTERM") child.exitCode = 0;
      },
    });
    expect(child.exitCode).toBe(0);
  });
});
