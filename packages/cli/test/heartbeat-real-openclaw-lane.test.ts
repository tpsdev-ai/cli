import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOpenClawVersion, assertPortClosed, finishWithCleanup, makeCase, OPENCLAW_VERSION, stopGateway, waitForRpc } from "../../../scripts/heartbeat-real-openclaw-lane.mjs";

const CASE_STUB = { home: "/nonexistent/home", stateDir: "", configPath: "", flairPort: 1 };
const GATEWAY_RUNNING = { exitCode: null };

describe("the OpenClaw version pin", () => {
  test("accepts the exact pin", () => {
    expect(() => assertOpenClawVersion("OpenClaw 2026.5.7\n")).not.toThrow();
  });

  test.each(["2026.5.70", "2026.5.7-beta", "12026.5.7", ""])("refuses version %j", (version) => {
    const output = version ? `OpenClaw ${version}\n` : "";
    expect(() => assertOpenClawVersion(output)).toThrow(
      `expected OpenClaw 2026.5.7, found: ${version || "(missing)"}`,
    );
  });
});

const FIXTURE_DIR = new URL("../../../test/fixtures/heartbeat-openclaw/", import.meta.url);

describe("the committed OpenClaw fixture", () => {
  test("pins the lane's OpenClaw version in its dependency and lockfile", () => {
    const manifest = JSON.parse(readFileSync(new URL("package.json", FIXTURE_DIR), "utf-8"));
    expect(manifest.dependencies).toEqual({ openclaw: OPENCLAW_VERSION });
    const lock = JSON.parse(readFileSync(new URL("package-lock.json", FIXTURE_DIR), "utf-8"));
    const entry = lock.packages["node_modules/openclaw"];
    expect(entry).toBeDefined();
    expect(entry.version).toBe(OPENCLAW_VERSION);
    expect(entry.integrity).toMatch(/^sha512-/);
  });
});

test("the written OpenClaw config binds the local gateway to loopback", () => {
  const root = mkdtempSync(join(tmpdir(), "heartbeat-config-"));
  try {
    const { configPath } = makeCase(root, "live", 1);
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.gateway).toEqual({ mode: "local", bind: "loopback" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
  test("an exited gateway rejects with its exit code before probing", async () => {
    let probes = 0;
    await expect(
      waitForRpc(CASE_STUB, 9, "/nonexistent/bin", { exitCode: 17, signalCode: null }, "/nonexistent/log", {
        runStatus: () => {
          probes++;
          return { status: 0 };
        },
      }),
    ).rejects.toThrow(/gateway exited with code 17 before RPC readiness/);
    expect(probes).toBe(0);
  });

  test("a real child's SIGTERM exit rejects readiness before probing", async () => {
    const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await once(child, "spawn");
      const exited = once(child, "exit");
      expect(child.kill("SIGTERM")).toBe(true);
      await exited;
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBe("SIGTERM");
      let probes = 0;
      const started = performance.now();
      await expect(
        waitForRpc(CASE_STUB, 9, "/nonexistent/bin", child, "/nonexistent/log", {
          timeoutMs: 1000,
          runStatus: () => {
            probes++;
            return { status: 0 };
          },
        }),
      ).rejects.toThrow(/gateway exited with signal SIGTERM before RPC readiness/);
      expect(performance.now() - started).toBeLessThan(500);
      expect(probes).toBe(0);
    } finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  });

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
    let clockMs = 0;
    const probeTimeouts: number[] = [];
    const runStatus = ({ timeout }: { timeout: number }) => {
      probeTimeouts.push(timeout);
      clockMs += 10;
      return { status: 1, stdout: "", stderr: "" };
    };
    await expect(
      waitForRpc(CASE_STUB, 9, "/nonexistent/bin", GATEWAY_RUNNING, "/nonexistent/log", {
        timeoutMs: budgetMs,
        pollMs: 15,
        probeTimeoutMs: 60_000,
        runStatus,
        now: () => clockMs,
        sleep: async (ms: number) => {
          clockMs += ms;
        },
      }),
    ).rejects.toThrow(/did not answer --require-rpc within 0\.06s/);
    expect(probeTimeouts).toEqual([60, 35, 10]);
    expect(clockMs).toBe(budgetMs);
  }, 1000);
});

describe("a cleanup failure does not hide the assertion that failed", () => {
  test("reports the assertion first and the failing stopGateway after it", async () => {
    const assertion = new Error("live gateway: heartbeat exit status must be 0");
    const child = { pid: 4324, exitCode: null };
    let reported: unknown;
    try {
      await finishWithCleanup(
        async () => {
          throw assertion;
        },
        () => stopGateway(child, { graceMs: 5, killMs: 10, pollMs: 2, signalGroup: () => {} }),
      );
    } catch (error) {
      reported = error;
    }
    expect(reported).toBeInstanceOf(AggregateError);
    const aggregate = reported as AggregateError;
    expect(aggregate.errors[0]).toBe(assertion);
    const assertionAt = aggregate.message.indexOf(assertion.message);
    const cleanupAt = aggregate.message.indexOf("did not exit after SIGKILL");
    expect(assertionAt).toBeGreaterThanOrEqual(0);
    expect(cleanupAt).toBeGreaterThan(assertionAt);
  });

  test("a cleanup failure on its own is still reported", async () => {
    const cleanup = new Error("gateway process 4325 did not exit after SIGKILL");
    await expect(
      finishWithCleanup(
        async () => {},
        async () => {
          throw cleanup;
        },
      ),
    ).rejects.toBe(cleanup);
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
