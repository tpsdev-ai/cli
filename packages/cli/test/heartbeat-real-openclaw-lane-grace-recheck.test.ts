import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { waitForGatewayExit } from "../../../scripts/heartbeat-real-openclaw-lane.mjs";

const LANE = fileURLToPath(new URL("../../../scripts/heartbeat-real-openclaw-lane.mjs", import.meta.url));
const GRACE_RECHECK_FIXTURE = fileURLToPath(
  new URL("../../../test/fixtures/heartbeat-lane-grace-recheck.mjs", import.meta.url),
);
const FAILED_HEARTBEAT_FIXTURE = fileURLToPath(
  new URL("../../../test/fixtures/heartbeat-lane-live-case-heartbeat-failure.mjs", import.meta.url),
);

function runNodeFixture(path: string) {
  return spawnSync(process.env.NODE_BIN ?? "node", [path, LANE], {
    encoding: "utf-8",
    timeout: 30_000,
  });
}

describe("waitForGatewayExit re-checks the exit after the grace timer", () => {
  test("under node, an exit during a loop block longer than the window is reported", () => {
    const result = runNodeFixture(GRACE_RECHECK_FIXTURE);
    expect(result.error).toBeUndefined();
    const stdout = result.stdout ?? "";
    expect(result.status).toBe(0);
    expect(stdout).toContain("GRACE_RECHECK_EXITED");
    expect(stdout).not.toContain("GRACE_RECHECK_SURVIVED");
  }, 30_000);
});

describe("the live case reports a failed heartbeat after the gateway exit", () => {
  test("through runLiveCase, a heartbeat that fails while the gateway exits reports both, the exit first", () => {
    const result = runNodeFixture(FAILED_HEARTBEAT_FIXTURE);
    expect(result.error).toBeUndefined();
    const stdout = result.stdout ?? "";
    expect(result.status).toBe(0);
    expect(stdout).toContain("LIVE_CASE_FAILED: gateway exited with code 0 during the heartbeat");
    expect(stdout).not.toContain("LIVE_CASE_ACCEPTED");
    const marker = "LIVE_CASE_MESSAGE_BEGIN\n";
    const begin = stdout.indexOf(marker);
    const end = stdout.indexOf("\nLIVE_CASE_MESSAGE_END", begin);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    const message = stdout.slice(begin + marker.length, end);
    const gatewayAt = message.indexOf("gateway exited with code 0 during the heartbeat");
    const heartbeatAt = message.indexOf("live gateway: heartbeat exit status must be 0");
    expect(gatewayAt).toBeGreaterThanOrEqual(0);
    expect(heartbeatAt).toBeGreaterThan(gatewayAt);
    expect(message).toContain("status=1");
    expect(message).toContain("gateway unreachable");
  }, 60_000);
});

describe("waitForGatewayExit bounds a gateway that stays up", () => {
  test("a live child that does not exit within the window resolves false and removes its exit listener", async () => {
    const child = spawn(process.env.NODE_BIN ?? "node", ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      await once(child, "spawn");
      const listenersBefore = child.listenerCount("exit");
      const started = performance.now();
      const exited = await waitForGatewayExit(child, 50);
      const elapsed = performance.now() - started;
      expect(exited).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(2000);
      expect(child.listenerCount("exit")).toBe(listenersBefore);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
    }
  }, 5000);
});
