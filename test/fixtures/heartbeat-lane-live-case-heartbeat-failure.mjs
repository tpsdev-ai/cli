// Drive the lane's production live-case path (runLiveCase) with a stub
// openclaw and a stub heartbeat that fails: the gateway answers readiness, the
// heartbeat tells it to exit, waits until its port refuses connections, then
// reports gateway unreachable and exits 1. The gateway exit and the heartbeat
// assertion must both be reported, the exit first.
//
// The stubs coordinate through the gateway's listening socket, not delays: the
// port closes when the gateway process exits, even while it is an unreaped
// zombie of the lane blocked in spawnSync, so the exit has happened before
// spawnSync returns. Each wait is capped; a gateway that never listens or never
// exits fails the stub heartbeat naming which (GATEWAY_NOT_LISTENING,
// GATEWAY_DID_NOT_EXIT).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "heartbeat-live-case-failure-"));
const binDir = join(root, "bin");
mkdirSync(binDir, { recursive: true });
const trigger = join(root, "heartbeat-started");
const pidFile = join(root, "gateway.pid");

const gatewayStub = `import net from "node:net";
import { existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "gateway" && args[1] === "run") {
  const port = Number(args[args.indexOf("--port") + 1]);
  writeFileSync(process.env.GATEWAY_PID_FILE, String(process.pid));
  const server = net.createServer((socket) => {
    // A probe that resets the connection must not crash the gateway.
    socket.on("error", () => {});
    socket.end("ready");
  });
  server.listen(port, "127.0.0.1");
  setInterval(() => {
    if (existsSync(process.env.TRIGGER)) process.exit(0);
  }, 10);
} else if (args[0] === "gateway" && args[1] === "status") {
  process.exit(0);
} else {
  process.exit(1);
}
`;
const openclaw = join(binDir, "openclaw");
writeFileSync(openclaw, `#!/usr/bin/env node\n${gatewayStub}`, { mode: 0o755 });
chmodSync(openclaw, 0o755);

const heartbeatStub = `import net from "node:net";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
const WAIT_MS = 5000;
const POLL_MS = 10;
const port = Number(process.env.OPENCLAW_GATEWAY_PORT);
if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write("GATEWAY_PORT_MISSING: OPENCLAW_GATEWAY_PORT is not a port\\n");
  process.exit(1);
}
function probe(timeoutMs) {
  return new Promise((resolveProbe) => {
    const socket = net.connect(port, "127.0.0.1");
    const finish = (outcome) => {
      socket.destroy();
      resolveProbe(outcome);
    };
    socket.setTimeout(timeoutMs, () => finish("timeout"));
    socket.once("connect", () => finish("open"));
    socket.once("error", (error) => finish(error.code === "ECONNREFUSED" ? "refused" : "error"));
  });
}
// Use a monotonic WAIT_MS retry budget, checked between attempts. On exhaustion, write the failure and exit non-zero.
async function waitForPort(wanted, failure) {
  const deadline = performance.now() + WAIT_MS;
  for (let remaining = WAIT_MS; remaining > 0; remaining = deadline - performance.now()) {
    if ((await probe(Math.max(1, Math.min(1000, remaining)))) === wanted) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_MS));
  }
  process.stderr.write(failure + " within " + WAIT_MS + "ms\\n");
  process.exit(1);
}
await waitForPort("open", "GATEWAY_NOT_LISTENING: gateway port " + port + " did not accept a connection");
writeFileSync(process.env.TRIGGER, "heartbeat started\\n");
await waitForPort("refused", "GATEWAY_DID_NOT_EXIT: gateway port " + port + " did not refuse connections");
console.log("Heartbeat for agent-a: gateway unreachable");
process.exit(1);
`;
const tpsStub = join(root, "tps-stub.mjs");
writeFileSync(tpsStub, heartbeatStub);

process.env.TRIGGER = trigger;
process.env.GATEWAY_PID_FILE = pidFile;
process.env.TPS_HEARTBEAT_BIN = tpsStub;

const { runLiveCase } = await import(pathToFileURL(process.argv[2]).href);

try {
  await runLiveCase(root, binDir);
  console.log("LIVE_CASE_ACCEPTED");
  process.exitCode = 2;
} catch (error) {
  const [firstLine, ...rest] = error.message.split("\n");
  console.log(`LIVE_CASE_FAILED: ${firstLine}`);
  console.log("LIVE_CASE_MESSAGE_BEGIN");
  console.log(error.message);
  console.log("LIVE_CASE_MESSAGE_END");
  // A stub heartbeat that hit a wait cap names it in its stderr, inside the message.
  const stubFailure = rest.find((line) => /^GATEWAY_[A-Z_]+: /.test(line));
  if (stubFailure) console.log(stubFailure);
} finally {
  try {
    const pid = Number(readFileSync(pidFile, "utf-8").trim());
    if (Number.isInteger(pid) && pid > 0) process.kill(-pid, "SIGKILL");
  } catch {
    // The gateway already exited, or never recorded its pid.
  }
  rmSync(root, { recursive: true, force: true });
}
