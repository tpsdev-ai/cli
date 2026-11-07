import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("../../../test/fixtures/heartbeat-lane-readiness-exit.mjs", import.meta.url));
const LANE = fileURLToPath(new URL("../../../scripts/heartbeat-real-openclaw-lane.mjs", import.meta.url));

describe("readiness rechecks the launched gateway after a successful probe", () => {
  test("under node, a gateway that answers the probe and exits immediately fails readiness", () => {
    const result = spawnSync(process.env.NODE_BIN ?? "node", [FIXTURE, LANE], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    const stdout = result.stdout ?? "";
    expect(result.status).toBe(0);
    expect(stdout).toContain("READINESS_FAILED: gateway exited with code 0 after answering --require-rpc");
    expect(stdout).not.toContain("READINESS_ACCEPTED");
  });
});
