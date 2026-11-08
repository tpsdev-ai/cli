// Drive the lane's production live-case path (runLiveCase) under node with a
// stub openclaw and a stub heartbeat: the gateway answers readiness, the
// heartbeat succeeds, and the gateway exits while the heartbeat's spawnSync
// still blocks the event loop.
//
// The stubs coordinate through the gateway's listening socket, not delays: the
// heartbeat waits until the port accepts a connection, tells the gateway to
// exit, then returns only once the port refuses connections. The port closes
// when the gateway process exits, even while it is an unreaped zombie of the
// lane blocked in spawnSync, so the exit has happened before spawnSync returns.
// Each wait is capped; a gateway that never listens or never exits fails the
// stub heartbeat naming which (GATEWAY_NOT_LISTENING, GATEWAY_DID_NOT_EXIT).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "heartbeat-live-case-"));
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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
const WAIT_MS = 5000;
const POLL_MS = 10;
const port = Number(process.env.OPENCLAW_GATEWAY_PORT);
if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write("GATEWAY_PORT_MISSING: OPENCLAW_GATEWAY_PORT is not a port\\n");
  process.exit(1);
}
// One connect attempt: "open" when accepted, "refused" only on ECONNREFUSED.
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
// Probe until the port reports the wanted outcome, for at most WAIT_MS on the
// monotonic clock; on the cap, write the failure and exit non-zero.
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
const dir = join(process.env.HOME, ".tps", "status", "nodes");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "agent-a.json"), JSON.stringify({ status: "online", errors: [] }));
console.log("Heartbeat for agent-a: online");
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
