import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const TPS_BIN = resolve(import.meta.dir, "../dist/bin/tps.js");

describe("branch start self-daemonization", () => {
  test("returns immediately and writes PID file when not already daemonized", () => {
    const home = mkdtempSync(join(tmpdir(), "tps-branch-daemon-"));

    const start = Date.now();
    const r = spawnSync("bun", [TPS_BIN, "branch", "start"], {
      encoding: "utf-8",
      env: { ...process.env, HOME: home, NODE_ENV: "production" },
      timeout: 3000,
    });
    const elapsed = Date.now() - start;

    expect(r.status).toBe(0);
    expect(elapsed).toBeLessThan(2000);
    expect(existsSync(join(home, ".tps", "branch.pid"))).toBe(true);

    // best-effort cleanup
    try {
      const pid = Number(require("node:fs").readFileSync(join(home, ".tps", "branch.pid"), "utf-8").trim());
      if (pid > 0) process.kill(pid, "SIGTERM");
    } catch {}
    rmSync(home, { recursive: true, force: true });
  });
});
