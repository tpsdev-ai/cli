// Run the lane's live-heartbeat exit check under node against a stub gateway
// that answers one readiness probe and exits a short delay after the heartbeat
// starts, well after a single event-loop turn: the grace window still sees it.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installGatewayTeardown } from "./heartbeat-lane-fixture-teardown.mjs";

const { assertGatewaySurvivedHeartbeat, finishWithCleanup, waitForRpc } = await import(
  pathToFileURL(process.argv[2]).href
);

const root = mkdtempSync(join(tmpdir(), "heartbeat-live-exit-"));
const trigger = join(root, "heartbeat-started");
const EXIT_DELAY_MS = 10;
const stubSource = `import net from "node:net";import { existsSync } from "node:fs";let exiting=false;const server=net.createServer((socket)=>{socket.end("ready");});server.listen(0,"127.0.0.1",()=>{process.stdout.write(String(server.address().port)+"\\n");setInterval(()=>{if(!exiting&&existsSync(process.env.TRIGGER)){exiting=true;setTimeout(()=>process.exit(0),${EXIT_DELAY_MS});}},10);});`;
const stub = spawn(process.execPath, ["--input-type=module", "-e", stubSource], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, TRIGGER: trigger },
  detached: true,
});
if (!stub.pid) throw new Error("stub gateway did not start");
installGatewayTeardown(stub.pid);
const port = await new Promise((resolvePort, rejectPort) => {
  stub.stdout.once("data", (chunk) => resolvePort(Number(String(chunk).trim())));
  stub.once("error", rejectPort);
  stub.once("exit", (code) => rejectPort(new Error(`stub gateway exited before naming its port (code ${code})`)));
});

const probeSource = `import net from "node:net";const socket=net.connect(${port},"127.0.0.1");let answered="";socket.setEncoding("utf8");socket.on("data",(chunk)=>{answered+=chunk;});socket.on("end",()=>process.exit(answered==="ready"?0:1));socket.on("error",()=>process.exit(1));`;

try {
  await waitForRpc(
    { home: "/nonexistent/home", stateDir: "", configPath: "", flairPort: 1 },
    9,
    "/nonexistent/bin",
    stub,
    "/nonexistent/log",
    {
      timeoutMs: 5000,
      runStatus: () => {
        const probe = spawnSync(process.execPath, ["--input-type=module", "-e", probeSource], {
          encoding: "utf-8",
          timeout: 10_000,
        });
        return { status: probe.status ?? 1, stdout: probe.stdout ?? "", stderr: probe.stderr ?? "" };
      },
    },
  );
  // Stand-in for runHeartbeat: the stub exits a short delay after it sees this
  // write, while the check below waits out the grace window. No sleep here: the
  // exit is not queued yet when the check starts, so the window is what sees it.
  writeFileSync(trigger, "heartbeat started\n");
  await finishWithCleanup(
    () => assertGatewaySurvivedHeartbeat(stub, "/nonexistent/log"),
    async () => {
      throw new Error("the heartbeat result was evaluated before the gateway exit check");
    },
  );
  console.log("LIVE_HEARTBEAT_ACCEPTED");
  process.exitCode = 2;
} catch (error) {
  console.log(`LIVE_HEARTBEAT_FAILED: ${error.message.split("\n")[0]}`);
} finally {
  if (stub.exitCode === null && stub.signalCode === null) {
    const exited = new Promise((resolveExit) => stub.once("exit", resolveExit));
    stub.kill("SIGKILL");
    await exited;
  }
  rmSync(root, { recursive: true, force: true });
}
