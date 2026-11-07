// Drive the lane's production live-case path (runLiveCase) under node with a
// stub openclaw and a stub heartbeat: the gateway answers readiness, the
// heartbeat succeeds, and the gateway exits while the heartbeat's spawnSync
// still blocks the event loop.
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
  const server = net.createServer((socket) => socket.end("ready"));
  server.listen(port, "127.0.0.1");
  let exiting = false;
  setInterval(() => {
    if (!exiting && existsSync(process.env.TRIGGER)) {
      exiting = true;
      setTimeout(() => process.exit(0), 10);
    }
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

const heartbeatStub = `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(process.env.TRIGGER, "heartbeat started\\n");
await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
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
  console.log(`LIVE_CASE_FAILED: ${error.message.split("\n")[0]}`);
} finally {
  try {
    const pid = Number(readFileSync(pidFile, "utf-8").trim());
    if (Number.isInteger(pid) && pid > 0) process.kill(-pid, "SIGKILL");
  } catch {
    // The gateway already exited, or never recorded its pid.
  }
  rmSync(root, { recursive: true, force: true });
}
