import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

for (const runtime of ["claude-code", "codex", "gemini"]) {
  test(`${runtime}: poll-to-launch refuses bridge no-claim before launch, reply and ack`, () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-tier-"));
    try {
      const run = spawnSync(process.execPath, [join(import.meta.dir, "helpers/runtime-tier-driver.ts"), runtime, root], {
        encoding: "utf8", timeout: 8000, env: { ...process.env, HOME: root, TPS_TEST_KEYS_DIR: root, TPS_AGENT_ID: "kern" },
      });
      expect(run.status, run.stderr).toBe(0);
      const measured = run.stdout.split("\n").find((line) => line.startsWith("MEASURED "));
      expect(measured, run.stdout + run.stderr).toBeDefined();
      expect(JSON.parse(measured!.slice(9))).toEqual({ launches: 1, bridgeStill: true, ordinaryGone: true, replies: 1 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 10_000);
}
