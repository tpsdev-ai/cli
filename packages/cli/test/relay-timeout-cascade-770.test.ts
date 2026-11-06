/**
 * relay-timeout-cascade-770.test.ts — a timed-out relay-delivery-loss case must
 * not leave its environment for the next file in the same bun process.
 *
 * The lane runs relay-delivery-loss.test.ts and then probe.fixture.ts in ONE
 * child bun process, the way scripts/test-suite.mjs runs the cli lane. A forced
 * short timeout in the relay file (TPS_RELAY_LOSS_TEST_TIMEOUT_MS) makes a case
 * and its cleanup timeout; the probe then compares the environment with the one
 * the lane started with. It fails on the unfixed file, naming the leaked names.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = ["HOME", "TPS_MAIL_DIR", "FLAIR_URL", "FLAIR_KEY_PATH", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_VAULT_KEY", "TPS_BRANCH_NO_DAEMON", "TPS_ROOT"] as const;
const RELAY = join(import.meta.dir, "relay-delivery-loss.test.ts");
const PROBE = join(import.meta.dir, "fixtures", "relay-timeout-cascade", "probe.fixture.ts");
const CLI = join(import.meta.dir, "..");

describe("a timed-out relay case leaves no environment for the next file (cli#770)", () => {
  test("the probe after relay-delivery-loss sees the lane's original environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-relay-cascade-"));
    const baselinePath = join(dir, "baseline.json");
    const resultPath = join(dir, "result.json");
    const baseline: Record<string, string | null> = {};
    for (const key of KEYS) baseline[key] = process.env[key] ?? null;
    writeFileSync(baselinePath, JSON.stringify(baseline));
    try {
      const run = spawnSync(
        process.execPath,
        ["test", "--timeout=1000", "-t", "with room the entry point writes the inbox", RELAY, PROBE],
        {
          cwd: CLI,
          encoding: "utf8",
          timeout: 90_000,
          env: {
            ...process.env,
            TPS_RELAY_LOSS_TEST_TIMEOUT_MS: "300",
            TPS_RELAY_PROBE_BASELINE: baselinePath,
            TPS_RELAY_PROBE_RESULT: resultPath,
          },
        }
      );
      const output = `${run.stdout}\n${run.stderr}`;
      expect(run.error).toBeUndefined();
      expect(output).toContain("timed out");
      expect(existsSync(resultPath), output).toBe(true);
      const diff = JSON.parse(readFileSync(resultPath, "utf8"));
      expect(diff, output).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
