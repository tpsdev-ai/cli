import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LANE = fileURLToPath(new URL("../../../scripts/heartbeat-real-openclaw-lane.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../../../test/fixtures/heartbeat-lane-post-heartbeat-rpc.mjs", import.meta.url));

function runCase(status: number, heartbeatStatus = 0) {
  const result = spawnSync(process.env.NODE_BIN ?? "node", [FIXTURE, LANE, String(status), String(heartbeatStatus)], {
    encoding: "utf-8",
    timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("runLiveCase probes RPC after the heartbeat", () => {
  test("a non-zero post-heartbeat RPC status fails the live case with diagnostics", () => {
    const stdout = runCase(1);
    expect(stdout).toContain("POST_HEARTBEAT_FAILED: gateway did not answer --require-rpc after the heartbeat");
    expect(stdout).toContain("status=1 signal=none");
    expect(stdout).toContain("RPC_PROBE_STDOUT");
    expect(stdout).toContain("RPC_PROBE_STDERR");
    expect(stdout).toContain("POST_HEARTBEAT_GATEWAY_LOG");
    expect(stdout).not.toContain("POST_HEARTBEAT_ACCEPTED");
    expect(stdout).toContain("STATUS_PROBES: 2");
  }, 20_000);

  test("a zero post-heartbeat RPC status passes the live case", () => {
    const stdout = runCase(0);
    expect(stdout).toContain("POST_HEARTBEAT_ACCEPTED");
    expect(stdout).not.toContain("POST_HEARTBEAT_FAILED");
    expect(stdout).toContain("STATUS_PROBES: 2");
  }, 20_000);

  test("RPC failure keeps the heartbeat result assertion running", () => {
    const stdout = runCase(1, 1);
    expect(stdout).toContain("gateway did not answer --require-rpc after the heartbeat");
    expect(stdout).toContain("live gateway: heartbeat exit status must be 0");
    expect(stdout).not.toContain("POST_HEARTBEAT_ACCEPTED");
  }, 20_000);
});
