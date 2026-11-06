#!/usr/bin/env node
/**
 * heartbeat-real-openclaw-lane.mjs — cli#758.
 *
 * Runs the built tps heartbeat against a real, pinned OpenClaw release:
 *
 *   dead  — OPENCLAW_GATEWAY_PORT points at a loopback port nothing listens on.
 *           heartbeat must persist `gateway unreachable` and exit 1.
 *   live  — the real gateway runs on an ephemeral loopback port. The lane waits
 *           for `gateway status --require-rpc` and heartbeat must exit 0 with an
 *           online record.
 *
 * The lane installs OpenClaw into a throwaway prefix with --ignore-scripts
 * unless OPENCLAW_BIN_DIR names an existing install. It writes nothing to the
 * repository: no lockfile, no node_modules.
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

const OPENCLAW_VERSION = "2026.5.7";
const AGENT = "agent-a";
const TOKEN = "ci-lane-token";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TPS_BIN = resolve(process.env.TPS_HEARTBEAT_BIN ?? join(REPO, "packages", "cli", "dist", "bin", "tps.js"));
const KEEP = process.env.TPS_HEARTBEAT_KEEP === "1";
const READY_TIMEOUT_MS = 90_000;

if (process.argv.includes("--pin")) {
  process.stdout.write(`${OPENCLAW_VERSION}\n`);
  process.exit(0);
}

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

async function assertPortClosed(port) {
  const outcome = await new Promise((resolveProbe) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (kind) => {
      socket.destroy();
      resolveProbe(kind);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done("open"));
    socket.once("error", () => done("closed"));
    socket.once("timeout", () => done("closed"));
  });
  assert.equal(outcome, "closed", `port ${port} is listening; the dead-gateway case needs a closed port`);
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

function makeCase(root, name, flairPort) {
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
  writeFileSync(configPath, `${JSON.stringify({ gateway: { mode: "local" } })}\n`, "utf-8");
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

async function waitForRpc(testCase, port, binDir, gateway, logPath) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    if (gateway.exitCode !== null) {
      throw new Error(
        `gateway exited with ${gateway.exitCode} before RPC readiness\n${readLogTail(logPath)}`,
      );
    }
    last = spawnSync(
      join(binDir, "openclaw"),
      ["gateway", "status", "--require-rpc", "--timeout", "2000"],
      {
        env: laneEnv(testCase, port, binDir),
        encoding: "utf-8",
        timeout: 5000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    if (last.status === 0) return;
    await delay(1000);
  }
  throw new Error(
    `gateway did not answer --require-rpc within ${READY_TIMEOUT_MS / 1000}s\n${describeRun(last)}\n${readLogTail(logPath)}`,
  );
}

function readLogTail(path) {
  try {
    return readFileSync(path, "utf-8").split("\n").slice(-30).join("\n");
  } catch {
    return "(no gateway log)";
  }
}

async function stopGateway(child) {
  if (!child.pid) return;
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  signalGroup("SIGTERM");
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && Date.now() < deadline) await delay(100);
  if (child.exitCode === null) {
    signalGroup("SIGKILL");
    const killDeadline = Date.now() + 5_000;
    while (child.exitCode === null && Date.now() < killDeadline) await delay(100);
    if (child.exitCode === null) console.error(`[lane] warning: gateway process ${child.pid} did not exit after SIGKILL`);
  }
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
  try {
    await waitForRpc(testCase, port, binDir, gateway, logPath);
    const result = runHeartbeat(testCase, port, binDir);
    assert.equal(result.status, 0, `live gateway: heartbeat exit status must be 0\n${describeRun(result)}`);
    assert.match(result.stdout, /Heartbeat for .*: online/, `live gateway: stdout must report online\n${describeRun(result)}`);
    const persisted = readPersisted(testCase);
    assert.equal(persisted.status, "online", "live gateway: persisted status must be online");
    assert.deepEqual(persisted.errors ?? [], [], "live gateway: persisted errors must be empty");
    console.log("PASS live gateway: exit 0, persisted online with no errors");
  } finally {
    await stopGateway(gateway);
    closeSync(logFd);
  }
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
  assert.match(version.stdout, new RegExp(OPENCLAW_VERSION.replaceAll(".", "\\.")), `expected OpenClaw ${OPENCLAW_VERSION}, got: ${version.stdout.trim()}`);
  console.log(`[lane] using ${openclawBin} (${version.stdout.trim()})`);

  await runDeadCase(root, binDir);
  await runLiveCase(root, binDir);
  console.log("[lane] both cases passed");
} finally {
  if (KEEP) console.log(`[lane] kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
