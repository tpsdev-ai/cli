// Run the lane's live-heartbeat exit check under node against a stub gateway
// that answers one readiness probe and exits while the heartbeat runs.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { waitForTermination } from "./process-termination.mjs";

const { assertGatewaySurvivedHeartbeat, finishWithCleanup, waitForRpc } = await import(
  pathToFileURL(process.argv[2]).href
);

const root = mkdtempSync(join(tmpdir(), "heartbeat-live-exit-"));
const trigger = join(root, "heartbeat-started");
const stubSource =
  'import net from "node:net";import { existsSync } from "node:fs";const server=net.createServer((socket)=>{socket.end("ready");});server.listen(0,"127.0.0.1",()=>{process.stdout.write(String(server.address().port)+"\\n");setInterval(()=>{if(existsSync(process.env.TRIGGER))process.exit(0);},10);});';
const stub = spawn(process.execPath, ["--input-type=module", "-e", stubSource], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, TRIGGER: trigger },
});
if (!stub.pid) throw new Error("stub gateway did not start");
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
  // Stand-in for runHeartbeat: the stub exits while this blocks, and node has
  // not reaped it, so its exit event is pending for the check that follows.
  writeFileSync(trigger, "heartbeat started\n");
  waitForTermination(stub.pid);
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
