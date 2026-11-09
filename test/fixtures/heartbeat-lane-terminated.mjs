// Teardown fixture for heartbeat-lane-fixture-teardown.test.ts. It starts a
// detached stub gateway that answers readiness and has a child of its own, so a
// teardown that signals only the gateway pid leaves the group alive, and a
// teardown that signals the group stops both. The fixture then blocks until the
// test terminates it.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installGatewayTeardown } from "./heartbeat-lane-fixture-teardown.mjs";

const root = process.env.TEARDOWN_DIR;
if (!root) throw new Error("TEARDOWN_DIR is not set");
mkdirSync(root, { recursive: true });
const portFile = join(root, "gateway.port");
const childPidFile = join(root, "gateway-child.pid");

const stubSource = `import net from "node:net";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.env.STUB_CHILD_PID_FILE, String(child.pid));
const server = net.createServer((socket) => socket.end("ready"));
server.listen(0, "127.0.0.1", () => writeFileSync(process.env.STUB_PORT_FILE, String(server.address().port)));
setInterval(() => {}, 1000);`;

const gateway = spawn(process.execPath, ["--input-type=module", "-e", stubSource], {
  stdio: "ignore",
  detached: true,
  env: { ...process.env, STUB_CHILD_PID_FILE: childPidFile, STUB_PORT_FILE: portFile },
});
if (!gateway.pid) throw new Error("stub gateway did not start");
installGatewayTeardown(gateway, process.env.TEARDOWN_STUB_SURVIVOR === "1" ? { probeSurvivors: () => [gateway.pid] } : {});
writeFileSync(join(root, "gateway.pid"), String(gateway.pid));

console.log("TEARDOWN_FIXTURE_READY");
if (process.env.TEARDOWN_EXIT === "normal") {
  process.stdin.once("data", () => process.exit(0));
} else {
  setInterval(() => {}, 1000);
}
