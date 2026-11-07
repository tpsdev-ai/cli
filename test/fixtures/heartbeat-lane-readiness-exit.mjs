// Run the lane's readiness recheck under node against a stub gateway that
// answers one readiness probe and exits.
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { waitForTermination } from "./process-termination.mjs";

const { waitForRpc } = await import(pathToFileURL(process.argv[2]).href);

const stubSource =
  'import net from "node:net";const server=net.createServer((socket)=>{socket.end("ready");setTimeout(()=>process.exit(0),10);});server.listen(0,"127.0.0.1",()=>process.stdout.write(String(server.address().port)+"\\n"));';
const stub = spawn(process.execPath, ["--input-type=module", "-e", stubSource], {
  stdio: ["ignore", "pipe", "inherit"],
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
        // Block until the stub has terminated at the OS level; node has not
        // reaped it, so its exit event is pending for waitForRpc's recheck.
        waitForTermination(stub.pid);
        return { status: probe.status ?? 1, stdout: probe.stdout ?? "", stderr: probe.stderr ?? "" };
      },
    },
  );
  console.log("READINESS_ACCEPTED");
  process.exitCode = 2;
} catch (error) {
  console.log(`READINESS_FAILED: ${error.message.split("\n")[0]}`);
} finally {
  if (stub.exitCode === null && stub.signalCode === null) {
    const exited = new Promise((resolveExit) => stub.once("exit", resolveExit));
    stub.kill("SIGKILL");
    await exited;
  }
}
