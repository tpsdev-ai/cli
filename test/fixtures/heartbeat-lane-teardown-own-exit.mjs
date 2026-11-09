// Teardown fixture for heartbeat-lane-fixture-teardown.test.ts.
// Every `process.kill` call the teardown makes is
// appended to `kill.log`, so the test can check that no SIGTERM or SIGKILL
// reached the group. With TEARDOWN_EXIT=normal the fixture exits 0 on its own;
// otherwise it waits for the test to signal it.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installGatewayTeardown } from "./heartbeat-lane-fixture-teardown.mjs";

const root = process.env.TEARDOWN_DIR;
if (!root) throw new Error("TEARDOWN_DIR is not set");
mkdirSync(root, { recursive: true });

const killLog = join(root, "kill.log");
const realKill = process.kill.bind(process);
process.kill = (target, signal) => {
  appendFileSync(killLog, `${target} ${signal ?? ""}\n`);
  return realKill(target, signal);
};

const gateway = spawn(process.execPath, ["--input-type=module", "-e", "setTimeout(() => process.exit(0), 100)"], {
  stdio: "ignore",
  detached: true,
});
if (!gateway.pid) throw new Error("stub gateway did not start");
installGatewayTeardown(gateway);
writeFileSync(join(root, "gateway.pid"), String(gateway.pid));

gateway.once("exit", () => {
  writeFileSync(join(root, "gateway-exited"), "yes");
  if (process.env.TEARDOWN_EXIT === "normal") process.exit(0);
});

// Registered after the teardown, so it runs after the teardown's exit handler
// and records whether that handler removed itself and the signal handlers.
process.on("exit", () => {
  writeFileSync(
    join(root, "listeners.json"),
    JSON.stringify({
      SIGTERM: process.listenerCount("SIGTERM"),
      SIGINT: process.listenerCount("SIGINT"),
      exit: process.listenerCount("exit"),
    }),
  );
});

console.log("TEARDOWN_FIXTURE_READY");
setInterval(() => {}, 1000);
