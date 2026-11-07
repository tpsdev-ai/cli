import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("../../../test/fixtures/heartbeat-lane-live-heartbeat-exit.mjs", import.meta.url));
const LANE = fileURLToPath(new URL("../../../scripts/heartbeat-real-openclaw-lane.mjs", import.meta.url));

describe("the live heartbeat reports a gateway exit that happens during it", () => {
  test("under node, a gateway that answers readiness and exits during the heartbeat fails naming the exit", () => {
    const result = spawnSync(process.env.NODE_BIN ?? "node", [FIXTURE, LANE], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    const stdout = result.stdout ?? "";
    expect(result.status).toBe(0);
    expect(stdout).toContain("LIVE_HEARTBEAT_FAILED: gateway exited with code 0 during the heartbeat");
    expect(stdout).not.toContain("LIVE_HEARTBEAT_ACCEPTED");
  });
});
