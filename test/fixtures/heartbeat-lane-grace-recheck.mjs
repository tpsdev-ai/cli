// The child writes "ready", then exits on a short timer. The lane arms
// waitForGatewayExit and blocks with Atomics.wait past the exit and grace window.
// The expired timer runs before the poll phase delivers the child's exit.
//
// A child that never reports ready fails naming STUB_GATEWAY_NOT_READY,
// and the test runs under an explicit timeout.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { installGatewayTeardown } from "./heartbeat-lane-fixture-teardown.mjs";

const { waitForGatewayExit } = await import(pathToFileURL(process.argv[2]).href);

const EXIT_DELAY_MS = 100;
const GRACE_MS = 250;
const BLOCK_MS = 1000;
const READY_TIMEOUT_MS = 5000;

const child = spawn(
  process.execPath,
  ["--input-type=module", "-e", `process.stdout.write("ready\\n");setTimeout(() => process.exit(0), ${EXIT_DELAY_MS});`],
  { stdio: ["ignore", "pipe", "inherit"], detached: true },
);
if (!child.pid) throw new Error("STUB_GATEWAY_NOT_STARTED: spawn returned no pid");
installGatewayTeardown(child.pid);

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

  // Arm the grace timer before blocking past the child's exit and the window.
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
