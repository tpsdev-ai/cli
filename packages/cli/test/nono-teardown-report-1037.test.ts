import { describe, expect, test } from "bun:test";
import { formatStopFailure, type StopReport } from "./helpers/stop-real-launch.js";

describe("real-launch teardown reporting (cli#1037)", () => {
  test("a survivor is named by role and pid, with the wait", () => {
    const report: StopReport = {
      stopped: false,
      waitedMs: 6_000,
      survivors: [
        { role: "released child", pid: 4242, state: "alive" },
        { role: "launcher", pid: 4243, state: "alive" },
      ],
    };
    const message = formatStopFailure(report);
    expect(message).toContain("released child pid 4242");
    expect(message).toContain("launcher pid 4243");
    expect(message).toContain("after 6000ms");
  });

  test("a single survivor is still named", () => {
    const message = formatStopFailure({
      stopped: false,
      waitedMs: 3_000,
      survivors: [{ role: "released child", pid: 7, state: "alive" }],
    });
    expect(message).toContain("released child pid 7");
    expect(message).not.toContain("launcher pid");
  });

  test("a stopped report does not claim a survivor", () => {
    const message = formatStopFailure({ stopped: true, waitedMs: 75, survivors: [] });
    expect(message).not.toContain("could not confirm");
    expect(message).toContain("confirmed");
  });
});
