/**
 * probe.fixture.ts — the second file in the relay timeout-cascade lane
 * (test/relay-timeout-cascade-770.test.ts). It is run by an explicit path in
 * the same bun process as relay-delivery-loss.test.ts, after that file. It
 * compares the environment it sees with the environment the lane started with
 * and writes the difference for the lane's outer test.
 */
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";

const KEYS = ["HOME", "TPS_MAIL_DIR", "FLAIR_URL", "FLAIR_KEY_PATH", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_VAULT_KEY", "TPS_BRANCH_NO_DAEMON", "TPS_ROOT"] as const;

test("with room the entry point writes the inbox: the next file sees the environment restored", () => {
  const baselinePath = process.env.TPS_RELAY_PROBE_BASELINE;
  const resultPath = process.env.TPS_RELAY_PROBE_RESULT;
  if (!baselinePath) throw new Error("TPS_RELAY_PROBE_BASELINE is not set");
  if (!resultPath) throw new Error("TPS_RELAY_PROBE_RESULT is not set");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, string | null>;
  const diff: Record<string, { expected: string | null; actual: string | null }> = {};
  for (const key of KEYS) {
    const actual = process.env[key] ?? null;
    if (actual !== baseline[key]) diff[key] = { expected: baseline[key], actual };
  }
  writeFileSync(resultPath, JSON.stringify(diff));
  expect(diff).toEqual({});
});
