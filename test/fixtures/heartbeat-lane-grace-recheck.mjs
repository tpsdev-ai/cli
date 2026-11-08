// A gateway child exits while the lane's event loop is blocked synchronously
// past the exit grace window: the child writes "ready", then exits on a short
// timer; the lane arms waitForGatewayExit and blocks with Atomics.wait longer
// than both the exit and the window. The child has exited by the time the loop
// runs again, but the exit is not delivered until the poll phase, after the
// expired timer. waitForGatewayExit must still report the exit.
//
// Each wait is capped: a child that never reports ready fails naming
// STUB_GATEWAY_NOT_READY, and the test runs under an explicit timeout.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const { waitForGatewayExit } = await import(pathToFileURL(process.argv[2]).href);

const EXIT_DELAY_MS = 100;
const GRACE_MS = 250;
const BLOCK_MS = 1000;
const READY_TIMEOUT_MS = 5000;

const child = spawn(
  process.execPath,
  ["--input-type=module", "-e", `process.stdout.write("ready\\n");setTimeout(() => process.exit(0), ${EXIT_DELAY_MS});`],
  { stdio: ["ignore", "pipe", "inherit"] },
);
if (!child.pid) throw new Error("STUB_GATEWAY_NOT_STARTED: spawn returned no pid");

try {
  await new Promise((resolveReady, rejectReady) => {
    const cap = setTimeout(
      () => rejectReady(new Error(`STUB_GATEWAY_NOT_READY: no ready line within ${READY_TIMEOUT_MS}ms`)),
      READY_TIMEOUT_MS,
    );
    const settle = (action) => (value) => {
      clearTimeout(cap);
      action(value);
    };
    child.stdout.once("data", settle(resolveReady));
    child.once("error", settle(rejectReady));
    child.once("exit", (code) => settle(rejectReady)(new Error(`STUB_GATEWAY_EXITED_BEFORE_READY: code ${code}`)));
  });

  // Arm the timer first, then block the loop past the child's exit and the
  // window, so the expired timer is handled before the exit is delivered.
  const pending = waitForGatewayExit(child, GRACE_MS);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BLOCK_MS);
  const exited = await pending;
  console.log(exited ? "GRACE_RECHECK_EXITED" : "GRACE_RECHECK_SURVIVED");
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = new Promise((resolveExit) => child.once("exit", resolveExit));
    child.kill("SIGKILL");
    await exit;
  }
}
