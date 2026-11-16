import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmodSync, closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertOpenClawVersion, assertPortClosed, finishWithCleanup, installOpenClaw, makeCase, OPENCLAW_VERSION, runLane, stopGateway, stopGatewayAndCloseLog, waitForRpc } from "../../../scripts/heartbeat-real-openclaw-lane.mjs";
import { withPortRetry } from "./helpers/port.js";

const REPO = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

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
  // The port must refuse connections now: probe it after the listener closes,
  // and choose another if something took it in between.
  const { port } = await withPortRetry(async (port) => {
    await assertPortClosed(port);
  }, { retryOn: () => true });
  return port;
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
  test.each([undefined, 0])("preserves thrown %p when cleanup succeeds", async (value) => {
    await expect(
      finishWithCleanup(
        async () => {
          throw value;
        },
        async () => {},
      ),
    ).rejects.toBe(value);
  });

  test.each([
    [undefined, undefined],
    [0, undefined],
    [undefined, "heartbeat also failed"],
    [0, "heartbeat also failed"],
  ])("preserves thrown %p before the cleanup failure with label %p", async (value, failureLabel) => {
    const cleanup = new Error("cleanup failed");
    let reported: unknown;
    try {
      await finishWithCleanup(
        async () => {
          throw value;
        },
        async () => {
          throw cleanup;
        },
        failureLabel,
      );
    } catch (error) {
      reported = error;
    }
    expect(reported).toBeInstanceOf(AggregateError);
    const aggregate = reported as AggregateError;
    expect(aggregate.message.split("\n")[0]).toBe(String(value));
    expect(aggregate.message).toBe(`${String(value)}\n${failureLabel ?? "cleanup also failed"}: ${cleanup.message}`);
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toBe(value);
    expect(aggregate.errors[1]).toBe(cleanup);
  });

  test.each([
    ["a null-prototype object", Object.create(null)],
    ["an object with a throwing message getter", {
      get message() {
        throw new TypeError("message getter failed");
      },
    }],
  ])("preserves %s before the cleanup failure", async (_label, value) => {
    const cleanup = new Error("cleanup failed");
    let reported: unknown;
    try {
      await finishWithCleanup(
        async () => {
          throw value;
        },
        async () => {
          throw cleanup;
        },
      );
    } catch (error) {
      reported = error;
    }
    expect(reported).toBeInstanceOf(AggregateError);
    const aggregate = reported as AggregateError;
    expect(aggregate.message).toBe("<unprintable thrown value>\ncleanup also failed: cleanup failed");
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toBe(value);
    expect(aggregate.errors[1]).toBe(cleanup);
  });

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

  test("reports the assertion first, then the failing gateway stop, then the failing log close", async () => {
    const assertion = new Error("live gateway: heartbeat exit status must be 0");
    const child = { pid: 4326, exitCode: null };
    const root = mkdtempSync(join(tmpdir(), "heartbeat-cleanup-"));
    try {
      const logFd = openSync(join(root, "gateway.log"), "w");
      closeSync(logFd);
      let reported: unknown;
      try {
        await finishWithCleanup(
          async () => {
            throw assertion;
          },
          () => stopGatewayAndCloseLog(child, logFd, { graceMs: 5, killMs: 10, pollMs: 2, signalGroup: () => {} }),
        );
      } catch (error) {
        reported = error;
      }
      expect(reported).toBeInstanceOf(AggregateError);
      const aggregate = reported as AggregateError;
      expect(aggregate.errors[0]).toBe(assertion);
      const cleanup = aggregate.errors[1] as AggregateError;
      expect(cleanup).toBeInstanceOf(AggregateError);
      expect(cleanup.errors).toHaveLength(2);
      expect((cleanup.errors[0] as Error).message).toMatch(/gateway process 4326 did not exit after SIGKILL/);
      expect((cleanup.errors[1] as NodeJS.ErrnoException).code).toBe("EBADF");
      const lines = aggregate.message.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe(assertion.message);
      expect(lines[1]).toMatch(/^cleanup also failed: gateway process 4326 did not exit after SIGKILL/);
      expect(lines[2]).toMatch(/^cleanup also failed: EBADF/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe("the temp tree removal failure is attached after the lane failure", () => {
  test("reports the lane failure first and the removal failure after it", async () => {
    const laneFailure = new Error("live gateway: heartbeat exit status must be 0");
    const removalFailure = Object.assign(new Error("EPERM: operation not permitted, rm"), { code: "EPERM" });
    let removed = "";
    let reported: unknown;
    try {
      await runLane({
        action: async () => {
          throw laneFailure;
        },
        removeTree: (path: string) => {
          removed = path;
          rmSync(path, { recursive: true, force: true });
          throw removalFailure;
        },
      });
    } catch (error) {
      reported = error;
    }
    expect(reported).toBeInstanceOf(AggregateError);
    const aggregate = reported as AggregateError;
    expect(aggregate.errors).toEqual([laneFailure, removalFailure]);
    expect(aggregate.message.split("\n")).toEqual([
      laneFailure.message,
      `cleanup also failed: ${removalFailure.message}`,
    ]);
    expect(removed).toContain("tps-heartbeat-lane-");
  });

  test("a removal failure with no lane failure still fails the lane", async () => {
    const removalFailure = new Error("EBUSY: resource busy or locked, rm");
    let reported: unknown;
    try {
      await runLane({
        action: async () => {},
        removeTree: (path: string) => {
          rmSync(path, { recursive: true, force: true });
          throw removalFailure;
        },
      });
    } catch (error) {
      reported = error;
    }
    expect(reported).toBe(removalFailure);
  });
});

type InstallCall = { command: string; args: string[]; options: { cwd?: string } };

function recordingSpawn() {
  const calls: InstallCall[] = [];
  const spawnInstall = (command: string, args: string[], options: InstallCall["options"]) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, spawnInstall };
}

const HELPER = join(REPO, "scripts", "npm-ci-tracked-lock.sh");
const FIXTURE = "test/fixtures/heartbeat-openclaw";
const CI_ARGS = ["--ignore-scripts", "--no-audit", "--no-fund"];

describe("the local fallback installs from the committed fixture lock", () => {
  test("runs the tracked-lock helper on the committed fixture instead of npm install", () => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-install-"));
    try {
      const { calls, spawnInstall } = recordingSpawn();
      const binDir = installOpenClaw(root, { spawn: spawnInstall, pathEnv: "", env: {} });
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call.command).toBe("bash");
      expect(call.args).toEqual([HELPER, "--via", "npm", FIXTURE, join(root, "openclaw"), ...CI_ARGS]);
      expect(call.options.cwd).toBe(REPO);
      expect(binDir).toBe(join(root, "openclaw", "node_modules", ".bin"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the sfw path when sfw is on PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-install-"));
    try {
      const stubs = join(root, "stubs");
      mkdirSync(stubs);
      writeFileSync(join(stubs, "sfw"), "#!/bin/sh\n");
      chmodSync(join(stubs, "sfw"), 0o755);
      const { calls, spawnInstall } = recordingSpawn();
      installOpenClaw(join(root, "run"), { spawn: spawnInstall, pathEnv: stubs });
      expect(calls[0].args).toEqual([HELPER, "--via", "sfw", FIXTURE, join(root, "run", "openclaw"), ...CI_ARGS]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function fixtureRepo(root: string): string {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
    mkdirSync(join(repo, "test", "fixtures", "heartbeat-openclaw"), { recursive: true });
    cpSync(join(REPO, "scripts", "npm-ci-tracked-lock.sh"), join(repo, "scripts", "npm-ci-tracked-lock.sh"));
    cpSync(join(REPO, "scripts", "lib", "npm-ci-revision.sh"), join(repo, "scripts", "lib", "npm-ci-revision.sh"));
    for (const file of ["package.json", "package-lock.json"]) {
      cpSync(join(REPO, "test", "fixtures", "heartbeat-openclaw", file), join(repo, "test", "fixtures", "heartbeat-openclaw", file));
    }
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    };
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=lane-fixture@example.com", "-c", "user.name=lane-fixture", "commit", "-qm", "fixture");
    return repo;
  }

  test("the real helper accepts that argv and installs the committed lock", () => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-install-helper-"));
    try {
      const repo = fixtureRepo(root);
      const stubs = join(root, "stubs");
      mkdirSync(stubs);
      const recordPath = join(root, "npm-args.txt");
      writeFileSync(join(stubs, "npm"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(recordPath)}\n`);
      chmodSync(join(stubs, "npm"), 0o755);
      const home = join(root, "home");
      mkdirSync(home);
      const env = { PATH: `${stubs}:${process.env.PATH ?? ""}`, HOME: home };
      const throwaway = join(root, "throwaway");
      const binDir = installOpenClaw(throwaway, { repo, pathEnv: stubs, env });
      expect(binDir).toBe(join(throwaway, "openclaw", "node_modules", ".bin"));
      const argv = readFileSync(recordPath, "utf-8").trim().split("\n");
      expect(argv[0]).toBe("ci");
      expect(argv[argv.indexOf("--prefix") + 1]).toBe(join(throwaway, "openclaw"));
      for (const arg of CI_ARGS) expect(argv).toContain(arg);
      expect(argv.some((arg) => arg.startsWith("--registry="))).toBe(true);
      const lock = readFileSync(join(repo, "test", "fixtures", "heartbeat-openclaw", "package-lock.json"), "utf-8");
      expect(readFileSync(join(throwaway, "openclaw", "package-lock.json"), "utf-8")).toBe(lock);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
