import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assertOpenClawVersion, assertPortClosed, finishWithCleanup, installOpenClaw, makeCase, OPENCLAW_VERSION, runLane, stopGateway, stopGatewayAndCloseLog, waitForRpc } from "../../../scripts/heartbeat-real-openclaw-lane.mjs";

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

const HELPER = join(REPO, "scripts", "npm-ci-tracked-lock.sh");
const FIXTURE = "test/fixtures/heartbeat-openclaw";
const CI_ARGS = ["--ignore-scripts", "--no-audit", "--no-fund"];

/** Host Bash used directly or as a wrapper target. */
function realBash(): string {
  const found = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf-8" });
  const bashBin = found.status === 0 ? found.stdout.trim() : "";
  if (!bashBin.startsWith("/")) throw new Error(`no absolute bash on this host: ${JSON.stringify(bashBin)}`);
  return bashBin;
}

function recordingSpawn() {
  const calls: InstallCall[] = [];
  const spawnInstall = (command: string, args: string[], options: InstallCall["options"]) => {
    calls.push({ command, args, options });
    // Simulate the helper's install: the bin the caller will use must exist.
    const prefix = args[args.indexOf(FIXTURE) + 1];
    mkdirSync(join(prefix, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(prefix, "node_modules", ".bin", "openclaw"), "");
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, spawnInstall };
}

/** An npm stub that records its argv and creates the bin under --prefix. */
function npmStub(dir: string, recordPath: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "npm"),
    `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(recordPath)}
prefix=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--prefix" ]; then prefix="$arg"; fi
  prev="$arg"
done
mkdir -p "$prefix/node_modules/.bin"
: > "$prefix/node_modules/.bin/openclaw"
`,
  );
  chmodSync(join(dir, "npm"), 0o755);
}

function helperTools(root: string): string {
  const tools = join(root, "tools");
  mkdirSync(tools);
  for (const name of ["bash", "node", "git", "mktemp", "mkdir", "cp", "cmp", "rm", "rmdir"]) {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf-8" });
    const tool = found.status === 0 ? found.stdout.trim() : "";
    if (!tool.startsWith("/")) throw new Error(`no absolute ${name} on this host: ${JSON.stringify(tool)}`);
    symlinkSync(tool, join(tools, name));
  }
  return tools;
}

describe("the local fallback installs from the committed fixture lock", () => {
  test("runs the tracked-lock helper on the committed fixture instead of npm install", () => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-install-"));
    try {
      const { calls, spawnInstall } = recordingSpawn();
      const pathEnv = helperTools(root);
      const binDir = installOpenClaw(root, { spawn: spawnInstall, pathEnv, env: { PATH: pathEnv } });
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call.command).toBe(join(pathEnv, "bash"));
      expect(call.args).toEqual([HELPER, "--via", "npm", FIXTURE, join(root, "openclaw"), ...CI_ARGS]);
      expect(call.options.cwd).toBe(REPO);
      expect(binDir).toBe(join(root, "openclaw", "node_modules", ".bin"));
      expect(existsSync(join(binDir, "openclaw"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the sfw path when sfw is on PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-install-"));
    try {
      const stubs = helperTools(root);
      writeFileSync(join(stubs, "sfw"), "#!/bin/sh\n");
      chmodSync(join(stubs, "sfw"), 0o755);
      const { calls, spawnInstall } = recordingSpawn();
      installOpenClaw(join(root, "run"), { spawn: spawnInstall, pathEnv: stubs, env: { PATH: stubs } });
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
      const stubs = helperTools(root);
      const recordPath = join(root, "npm-args.txt");
      writeFileSync(join(stubs, "npm"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(recordPath)}\n`);
      chmodSync(join(stubs, "npm"), 0o755);
      const home = join(root, "home");
      mkdirSync(home);
      const env = { PATH: stubs, HOME: home };
      const throwaway = join(root, "throwaway");
      const binDir = installOpenClaw(throwaway, { repo, env });
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

  test("a relative PATH entry resolves from the helper's working directory", () => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-install-relative-"));
    const previousCwd = process.cwd();
    try {
      const repo = fixtureRepo(root);
      const laneCwd = join(root, "lane-cwd");
      const relBin = join(laneCwd, "relbin");
      mkdirSync(relBin, { recursive: true });
      writeFileSync(join(relBin, "sfw"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(relBin, "sfw"), 0o755);
      const npmDir = helperTools(root);
      const recordPath = join(root, "npm-args.txt");
      npmStub(npmDir, recordPath);
      const home = join(root, "home");
      mkdirSync(home);
      const pathEnv = `relbin:${npmDir}`;
      process.chdir(laneCwd);
      const throwaway = join(root, "throwaway");
      const binDir = installOpenClaw(throwaway, { repo, pathEnv, env: { PATH: pathEnv, HOME: home } });
      expect(readFileSync(recordPath, "utf-8")).toContain("ci");
      expect(existsSync(join(binDir, "openclaw"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a relative PATH entry for bash itself: the lane and the helper use the same bash and both see sfw", () => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-install-relative-bash-"));
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    try {
      const repo = fixtureRepo(root);
      const relBin = join(repo, "relative-bin");
      mkdirSync(relBin, { recursive: true });
      const bashRecord = join(root, "bash-calls.txt");
      writeFileSync(
        join(relBin, "bash"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(bashRecord)}\nexec ${JSON.stringify(realBash())} "$@"\n`,
      );
      chmodSync(join(relBin, "bash"), 0o755);
      const sfwRecord = join(root, "sfw-args.txt");
      writeFileSync(join(relBin, "sfw"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(sfwRecord)}\n`);
      chmodSync(join(relBin, "sfw"), 0o755);
      const tools = helperTools(root);
      const home = join(root, "home");
      mkdirSync(home);
      const pathEnv = `relative-bin:${tools}`;
      const laneCwd = join(root, "lane-cwd");
      mkdirSync(laneCwd);
      process.env.PATH = pathEnv;
      process.chdir(laneCwd);
      const throwaway = join(root, "throwaway");
      installOpenClaw(throwaway, { repo, pathEnv, env: { PATH: pathEnv, HOME: home } });
      const bashCalls = readFileSync(bashRecord, "utf-8").trim().split("\n");
      expect(bashCalls.some((line) => line.includes("command -v sfw"))).toBe(true);
      expect(bashCalls.some((line) => line.includes("--via sfw") && line.includes("npm-ci-tracked-lock.sh"))).toBe(true);
      expect(readFileSync(sfwRecord, "utf-8")).toContain("ci");
    } finally {
      process.chdir(previousCwd);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("an explicit non-executable bash override fails the probe with EACCES", () => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-install-probe-fail-"));
    try {
      const notExecutable = join(root, "bash");
      writeFileSync(notExecutable, "");
      const { calls, spawnInstall } = recordingSpawn();
      const pathEnv = helperTools(root);
      let reported: unknown;
      try {
        installOpenClaw(join(root, "run"), {
          spawn: spawnInstall,
          bashPath: notExecutable,
          pathEnv,
          env: { PATH: pathEnv },
        });
      } catch (error) {
        reported = error;
      }
      expect(reported).toBeInstanceOf(Error);
      expect((reported as Error).message).toBe(`sfw probe cannot launch bash at ${notExecutable}: EACCES`);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an empty PATH entry selects bash from the helper working directory", () => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-bash-empty-"));
    try {
      const bashBin = join(root, "bash");
      symlinkSync(realBash(), bashBin);
      const { calls, spawnInstall } = recordingSpawn();
      installOpenClaw(join(root, "run"), { repo: root, pathEnv: `:${helperTools(root)}`, spawn: spawnInstall });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe(bashBin);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(["directory", "non-executable file"])("skips a %s named bash before a valid executable", (kind) => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-bash-skip-"));
    try {
      const first = join(root, "first");
      const valid = join(root, "valid");
      mkdirSync(first);
      mkdirSync(valid);
      if (kind === "directory") mkdirSync(join(first, "bash"));
      else {
        writeFileSync(join(first, "bash"), "#!/bin/sh\nexit 0\n");
        chmodSync(join(first, "bash"), 0o644);
      }
      const bashBin = join(valid, "bash");
      symlinkSync(realBash(), bashBin);
      const { calls, spawnInstall } = recordingSpawn();
      installOpenClaw(join(root, "run"), { repo: root, pathEnv: `${first}:${valid}`, spawn: spawnInstall });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe(bashBin);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an empty install PATH is refused by name, even when the working directory holds bash", () => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-bash-emptypath-"));
    try {
      symlinkSync(realBash(), join(root, "bash"));
      const { calls, spawnInstall } = recordingSpawn();
      expect(() => installOpenClaw(join(root, "run"), { repo: root, pathEnv: "", spawn: spawnInstall })).toThrow(
        "no executable bash on the install PATH: PATH is empty",
      );
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an empty PATH entry with a relative working directory selects an absolute bash", () => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-bash-relcwd-"));
    try {
      const bashBin = join(root, "bash");
      symlinkSync(realBash(), bashBin);
      const { calls, spawnInstall } = recordingSpawn();
      installOpenClaw(join(root, "run"), { repo: relative(process.cwd(), root), pathEnv: `:${helperTools(root)}`, spawn: spawnInstall });
      expect(calls).toHaveLength(1);
      expect(isAbsolute(calls[0].command)).toBe(true);
      expect(realpathSync(calls[0].command)).toBe(realpathSync(bashBin));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a PATH without bash names the resolver refusal before installing", () => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-bash-missing-"));
    try {
      const { calls, spawnInstall } = recordingSpawn();
      expect(() => installOpenClaw(join(root, "run"), { pathEnv: root, spawn: spawnInstall })).toThrow(
        `no executable bash on the install PATH: tried ${join(root, "bash")}`,
      );
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["unexpected exit", "exit 23", "exited with status 23"],
    ["signal", 'kill -TERM "$$"', "was killed by SIGTERM"],
    ["ENOENT", null, "ENOENT"],
  ])("a probe %s is a named failure before installing", (_kind, script, detail) => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-probe-outcome-"));
    try {
      const bashBin = join(root, "bash");
      if (script !== null) {
        writeFileSync(bashBin, `#!/bin/sh\nexec ${JSON.stringify(realBash())} -c ${JSON.stringify(script)}\n`);
        chmodSync(bashBin, 0o755);
      }
      const { calls, spawnInstall } = recordingSpawn();
      const message = script === null
        ? `sfw probe cannot launch bash at ${bashBin}: ${detail}`
        : `sfw probe with bash at ${bashBin} ${detail}`;
      expect(() => installOpenClaw(join(root, "run"), { bashPath: bashBin, spawn: spawnInstall })).toThrow(message);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["error", { status: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }) }],
    ["signal", { status: null, signal: "SIGTERM" }],
  ])("an install %s names bash and its outcome", (kind, outcome) => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-install-outcome-"));
    try {
      const bashBin = realBash();
      let installs = 0;
      let reported: unknown;
      try {
        installOpenClaw(root, { bashPath: bashBin, pathEnv: root, spawn: () => {
          installs++;
          return outcome;
        } });
      } catch (error) {
        reported = error;
      }
      expect(installs).toBe(1);
      expect(reported).toBeInstanceOf(Error);
      expect((reported as Error).message).toBe(kind === "error"
        ? `tracked-lock install cannot launch bash at ${bashBin}: ENOENT`
        : `tracked-lock install with bash at ${bashBin} was killed by SIGTERM`);
      expect((reported as Error).message).not.toContain("status null");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an sfw PATH entry that is a directory is not an installer", () => {
    const root = mkdtempSync(join(tmpdir(), "heartbeat-install-dir-sfw-"));
    try {
      const repo = fixtureRepo(root);
      const dirEntry = join(root, "dir-entry");
      mkdirSync(join(dirEntry, "sfw"), { recursive: true });
      const npmDir = helperTools(root);
      const recordPath = join(root, "npm-args.txt");
      npmStub(npmDir, recordPath);
      const home = join(root, "home");
      mkdirSync(home);
      const pathEnv = `${dirEntry}:${npmDir}`;
      const throwaway = join(root, "throwaway");
      const binDir = installOpenClaw(throwaway, { repo, pathEnv, env: { PATH: pathEnv, HOME: home } });
      expect(readFileSync(recordPath, "utf-8")).toContain("ci");
      expect(existsSync(join(binDir, "openclaw"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
