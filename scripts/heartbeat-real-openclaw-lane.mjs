#!/usr/bin/env node
/**
 * heartbeat-real-openclaw-lane.mjs — cli#758.
 *
 * Runs the built tps heartbeat against a real, pinned OpenClaw release:
 *
 *   dead  — OPENCLAW_GATEWAY_PORT points at a loopback port nothing listens on.
 *           heartbeat must persist `gateway unreachable` and exit 1.
 *   live  — waits for `gateway status --require-rpc`; heartbeat must exit 0 with an
 *           online record.
 *
 * Without OPENCLAW_BIN_DIR, the lane installs OpenClaw into a throwaway prefix
 * with --ignore-scripts. A supplied directory must contain openclaw.
 *
 * The dead and live cases run together, and should not be split: the dead case
 * passes on a failed probe, while the live case is the control that shows the
 * same command succeeds against a healthy gateway.
 *
 * Env:
 *   OPENCLAW_BIN_DIR       reuse an installed OpenClaw bin directory
 *   TPS_HEARTBEAT_BIN      built tps entry point (default packages/cli/dist/bin/tps.js)
 *   TPS_HEARTBEAT_KEEP=1   keep the throwaway root for inspection
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OPENCLAW_VERSION = "2026.5.7";
const AGENT = "agent-a";
const TOKEN = "ci-lane-token";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TPS_BIN = resolve(process.env.TPS_HEARTBEAT_BIN ?? join(REPO, "packages", "cli", "dist", "bin", "tps.js"));
const KEEP = process.env.TPS_HEARTBEAT_KEEP === "1";
const READY_TIMEOUT_MS = 90_000;
/** The only connect failure that means "nothing is listening". */
const PORT_CLOSED_CODES = new Set(["ECONNREFUSED"]);

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

/**
 * Probe a port once (loopback by default). Resolves "open" when a connection is
 * accepted and "closed" only on ECONNREFUSED; a timeout or any other error rejects
 * with that error named, because neither proves the port refuses connections.
 */
export function probePort(port, { host = "127.0.0.1", timeoutMs = 1000, connect = net.connect } = {}) {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (outcome, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectProbe(error);
      else resolveProbe(outcome);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("open"));
    socket.once("timeout", () =>
      finish("timeout", new Error(`probe of ${host}:${port} timed out after ${timeoutMs}ms`)),
    );
    socket.once("error", (error) => {
      if (PORT_CLOSED_CODES.has(error.code)) finish("closed");
      else finish("error", new Error(`probe of ${host}:${port} failed: ${error.code ?? error.message}`));
    });
  });
}

export async function assertPortClosed(port, options = {}) {
  const outcome = await probePort(port, options);
  assert.equal(
    outcome,
    "closed",
    `port ${port} is listening; the dead-gateway case needs a port that refuses connections`,
  );
}

export function assertOpenClawVersion(stdout) {
  const found = stdout.trim().match(/^(?:OpenClaw\s+)?(\S+)/)?.[1] ?? "(missing)";
  assert.equal(found, OPENCLAW_VERSION, `expected OpenClaw ${OPENCLAW_VERSION}, found: ${found}`);
}

function installOpenClaw(root) {
  const prefix = join(root, "openclaw");
  console.error(`[lane] installing openclaw@${OPENCLAW_VERSION} into ${prefix}`);
  const result = spawnSync(
    "npm",
    ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", `openclaw@${OPENCLAW_VERSION}`],
    { stdio: "inherit", timeout: 600_000 },
  );
  assert.equal(result.status, 0, `npm install openclaw@${OPENCLAW_VERSION} failed (status ${result.status})`);
  return join(prefix, "node_modules", ".bin");
}

function laneEnv(testCase, port, binDir) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("OPENCLAW_")) env[name] = value;
  }
  Object.assign(env, {
    HOME: testCase.home,
    TMPDIR: join(testCase.home, "tmp"),
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    FLAIR_URL: `http://127.0.0.1:${testCase.flairPort}`,
    TPS_HOST_FINGERPRINT: "ci-lane",
    OPENCLAW_STATE_DIR: testCase.stateDir,
    OPENCLAW_CONFIG_PATH: testCase.configPath,
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_GATEWAY_TOKEN: TOKEN,
  });
  return env;
}

export function makeCase(root, name, flairPort) {
  const dir = join(root, name);
  const home = join(dir, "home");
  const workspace = join(home, ".tps", "branch-office", AGENT);
  const stateDir = join(dir, "state");
  const configPath = join(dir, "openclaw.json");
  mkdirSync(join(home, ".tps", "agents", AGENT), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(home, "tmp"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(home, ".tps", "agents", AGENT, "agent.yaml"),
    `agentId: ${AGENT}\nname: ${AGENT}\nworkspace: ${workspace}\nmailDir: ${join(home, ".tps", "mail")}\n`,
    "utf-8",
  );
  writeFileSync(configPath, `${JSON.stringify({ gateway: { mode: "local", bind: "loopback" } })}\n`, "utf-8");
  return { dir, home, workspace, stateDir, configPath, flairPort };
}

function runHeartbeat(testCase, port, binDir) {
  return spawnSync(process.execPath, [TPS_BIN, "heartbeat", AGENT], {
    cwd: testCase.home,
    env: laneEnv(testCase, port, binDir),
    encoding: "utf-8",
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function readPersisted(testCase) {
  const path = join(testCase.home, ".tps", "status", "nodes", `${AGENT}.json`);
  assert.ok(existsSync(path), `heartbeat did not write ${path}`);
  return JSON.parse(readFileSync(path, "utf-8"));
}

function describeRun(result) {
  return `status=${result.status} signal=${result.signal ?? "none"}\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`;
}

function defaultStatusProbe({ binDir, testCase, port, timeout, rpcTimeout }) {
  return spawnSync(join(binDir, "openclaw"), ["gateway", "status", "--require-rpc", "--timeout", String(rpcTimeout)], {
    env: laneEnv(testCase, port, binDir),
    encoding: "utf-8",
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * Poll `gateway status --require-rpc` until it succeeds, the gateway exits, or
 * the readiness deadline passes. Each probe's timeout and each sleep are capped
 * by the time left, and a success observed after the deadline is rejected.
 */
export async function waitForRpc(testCase, port, binDir, gateway, logPath, options = {}) {
  const {
    timeoutMs = READY_TIMEOUT_MS,
    pollMs = 1000,
    probeTimeoutMs = 5000,
    rpcTimeoutMs = 2000,
    runStatus = defaultStatusProbe,
    now = Date.now,
    sleep = delay,
  } = options;
  const deadline = now() + timeoutMs;
  let last;
  while (now() < deadline) {
    if (gateway.exitCode !== null || (gateway.signalCode ?? null) !== null) {
      throw new Error(
        `gateway exited with ${gateway.exitCode !== null ? `code ${gateway.exitCode}` : `signal ${gateway.signalCode}`} before RPC readiness\n${readLogTail(logPath)}`,
      );
    }
    const remaining = Math.max(1, deadline - now());
    last = runStatus({
      binDir,
      testCase,
      port,
      timeout: Math.min(probeTimeoutMs, remaining),
      rpcTimeout: Math.max(1, Math.min(rpcTimeoutMs, remaining)),
    });
    if (last.status === 0) {
      if (now() > deadline) {
        throw new Error(`gateway answered --require-rpc after the ${timeoutMs / 1000}s readiness deadline`);
      }
      return;
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  throw new Error(
    `gateway did not answer --require-rpc within ${timeoutMs / 1000}s\n${describeRun(last)}\n${readLogTail(logPath)}`,
  );
}

function readLogTail(path) {
  try {
    return readFileSync(path, "utf-8").split("\n").slice(-30).join("\n");
  } catch {
    return "(no gateway log)";
  }
}

function defaultSignalGroup(pid) {
  return (signal) => {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
}

/**
 * Signal the gateway process group and confirm the direct child exits. Throws
 * when the exit is not confirmed after SIGKILL: an unconfirmed stop must fail
 * the lane, not warn.
 */
export async function stopGateway(child, options = {}) {
  if (!child.pid) return;
  const { graceMs = 10_000, killMs = 5_000, pollMs = 100, signalGroup = defaultSignalGroup(child.pid) } = options;
  // A child killed by a signal keeps exitCode null and reports the signal instead.
  const exited = () => child.exitCode !== null || (child.signalCode ?? null) !== null;
  signalGroup("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (!exited() && Date.now() < deadline) await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  if (exited()) return;
  signalGroup("SIGKILL");
  const killDeadline = Date.now() + killMs;
  while (!exited() && Date.now() < killDeadline) {
    await delay(Math.min(pollMs, Math.max(1, killDeadline - Date.now())));
  }
  if (!exited()) {
    throw new Error(`gateway process ${child.pid} did not exit after SIGKILL within ${killMs / 1000}s`);
  }
}

/**
 * Run `action`, then `cleanup`; preserve thrown values, action first.
 */
export async function finishWithCleanup(action, cleanup) {
  let actionFailed = false;
  let failure;
  try {
    await action();
  } catch (error) {
    actionFailed = true;
    failure = error;
  }
  try {
    await cleanup();
  } catch (error) {
    if (!actionFailed) throw error;
    throw new AggregateError([failure, error], `${failure?.message}\ncleanup also failed: ${error?.message}`);
  }
  if (actionFailed) throw failure;
}

async function runDeadCase(root, binDir) {
  const port = await freePort();
  await assertPortClosed(port);
  const testCase = makeCase(root, "dead", (await freePort()));
  const result = runHeartbeat(testCase, port, binDir);
  assert.equal(result.status, 1, `dead gateway: heartbeat exit status must be 1\n${describeRun(result)}`);
  assert.match(result.stdout, /gateway unreachable/, `dead gateway: stdout must name the failed probe\n${describeRun(result)}`);
  const persisted = readPersisted(testCase);
  assert.equal(persisted.status, "error", "dead gateway: persisted status must be error");
  assert.equal(persisted.lastError, "gateway unreachable", "dead gateway: persisted lastError must be gateway unreachable");
  assert.ok(
    Array.isArray(persisted.errors) && persisted.errors.some((entry) => entry.reason === "gateway unreachable"),
    "dead gateway: persisted errors must record gateway unreachable",
  );
  console.log("PASS dead gateway: exit 1, persisted error gateway unreachable");
}

async function runLiveCase(root, binDir) {
  const port = await freePort();
  const testCase = makeCase(root, "live", (await freePort()));
  const logPath = join(testCase.dir, "gateway.log");
  const logFd = openSync(logPath, "a");
  const gateway = spawn(
    join(binDir, "openclaw"),
    ["gateway", "run", "--port", String(port), "--allow-unconfigured", "--auth", "token"],
    {
      cwd: testCase.home,
      env: laneEnv(testCase, port, binDir),
      detached: true,
      stdio: ["ignore", logFd, logFd],
    },
  );
  await finishWithCleanup(
    async () => {
      await waitForRpc(testCase, port, binDir, gateway, logPath);
      const result = runHeartbeat(testCase, port, binDir);
      assert.equal(result.status, 0, `live gateway: heartbeat exit status must be 0\n${describeRun(result)}`);
      assert.match(result.stdout, /Heartbeat for .*: online/, `live gateway: stdout must report online\n${describeRun(result)}`);
      const persisted = readPersisted(testCase);
      assert.equal(persisted.status, "online", "live gateway: persisted status must be online");
      assert.deepEqual(persisted.errors ?? [], [], "live gateway: persisted errors must be empty");
      console.log("PASS live gateway: exit 0, persisted online with no errors");
    },
    async () => {
      try {
        await stopGateway(gateway);
      } finally {
        closeSync(logFd);
      }
    },
  );
}

export async function main() {
  if (process.argv.includes("--pin")) {
    process.stdout.write(`${OPENCLAW_VERSION}\n`);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "tps-heartbeat-lane-"));
  let binDir;
  try {
    assert.ok(existsSync(TPS_BIN), `built tps entry point not found: ${TPS_BIN}`);
    binDir = process.env.OPENCLAW_BIN_DIR ? resolve(process.env.OPENCLAW_BIN_DIR) : installOpenClaw(root);
    const openclawBin = join(binDir, "openclaw");
    assert.ok(existsSync(openclawBin), `openclaw not found in ${binDir}`);
    const version = spawnSync(openclawBin, ["--version"], { encoding: "utf-8", timeout: 30_000 });
    assert.equal(version.status, 0, `openclaw --version failed: ${version.stderr ?? ""}`);
    assertOpenClawVersion(version.stdout);
    console.log(`[lane] using ${openclawBin} (${version.stdout.trim()})`);

    await runDeadCase(root, binDir);
    await runLiveCase(root, binDir);
    console.log("[lane] both cases passed");
  } finally {
    if (KEEP) console.log(`[lane] kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
