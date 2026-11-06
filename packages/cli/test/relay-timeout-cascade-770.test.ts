/**
 * relay-timeout-cascade-770.test.ts — a timed-out relay-delivery-loss case must
 * not leave the audited environment keys for the next file in the same bun
 * process.
 *
 * The lane runs relay-delivery-loss.test.ts and then probe.fixture.ts in ONE
 * child bun process, the way scripts/test-suite.mjs runs the cli lane. A forced
 * short timeout in the relay file (TPS_RELAY_LOSS_TEST_TIMEOUT_MS) makes a case
 * and its cleanup timeout; the probe then compares the audited environment keys
 * with the one the lane started with. It fails on the unfixed file, naming the
 * leaked names.
 *
 * A second lane throws right after the receipt TTL assignment, before the case's
 * local try: the next file must still see the audited keys restored.
 *
 * A third lane runs a connect case with a baseline home whose connection-state
 * file is a sentinel: the case's cleanup must resolve paths from its own HOME,
 * so the sentinel is unchanged, with and without a forced timeout.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = ["HOME", "TPS_MAIL_DIR", "FLAIR_URL", "FLAIR_KEY_PATH", "TPS_IDENTITY_DIR", "TPS_REGISTRY_DIR", "TPS_VAULT_KEY", "TPS_BRANCH_NO_DAEMON", "TPS_ROOT", "TPS_RELAY_ACCEPT_RECEIPT_TTL_MS"] as const;
const RELAY = join(import.meta.dir, "relay-delivery-loss.test.ts");
const PROBE = join(import.meta.dir, "fixtures", "relay-timeout-cascade", "probe.fixture.ts");
const CLI = join(import.meta.dir, "..");

function baselineOfCurrentEnv(): Record<string, string | null> {
  const baseline: Record<string, string | null> = {};
  for (const key of KEYS) baseline[key] = process.env[key] ?? null;
  return baseline;
}

describe("a timed-out relay case leaves no environment for the next file (cli#770)", () => {
  test("the probe after relay-delivery-loss sees the lane's original environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-relay-cascade-"));
    const baselinePath = join(dir, "baseline.json");
    const resultPath = join(dir, "result.json");
    const baseline = baselineOfCurrentEnv();
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

  test("every environment key relay-delivery-loss.test.ts writes is in ENV_KEYS", () => {
    const source = readFileSync(RELAY, "utf8");
    const declaration = /const ENV_KEYS = \[([^\]]*)\]/.exec(source);
    expect(declaration).not.toBeNull();
    const envKeys = new Set([...declaration![1].matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]));
    const writes = [
      ...source.matchAll(/process\.env\.([A-Za-z0-9_]+)\s*=(?!=)/g),
      ...source.matchAll(/delete\s+process\.env\.([A-Za-z0-9_]+)/g),
    ].map((match) => match[1]);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.filter((key) => !envKeys.has(key))).toEqual([]);
  });

  test("a throw after the receipt TTL assignment is restored before the probe", () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-relay-ttl-"));
    const baselinePath = join(dir, "baseline.json");
    const resultPath = join(dir, "result.json");
    const baseline = baselineOfCurrentEnv();
    writeFileSync(baselinePath, JSON.stringify(baseline));
    try {
      const run = spawnSync(
        process.execPath,
        ["test", "-t", "a receipt older than the prune bound|with room the entry point writes the inbox", RELAY, PROBE],
        {
          cwd: CLI,
          encoding: "utf8",
          timeout: 90_000,
          env: {
            ...process.env,
            TPS_RELAY_LOSS_THROW_AFTER_TTL_ASSIGN: "1",
            TPS_RELAY_PROBE_BASELINE: baselinePath,
            TPS_RELAY_PROBE_RESULT: resultPath,
          },
        }
      );
      const output = `${run.stdout}\n${run.stderr}`;
      expect(run.error).toBeUndefined();
      expect(output).toContain("injected throw after the receipt TTL assignment");
      expect(existsSync(resultPath), output).toBe(true);
      expect(JSON.parse(readFileSync(resultPath, "utf8")), output).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test("a connect case's cleanup leaves the baseline home's connection state untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-relay-sentinel-"));
    const home = join(dir, "home");
    const connections = join(home, ".tps", "connections");
    const sentinel = join(connections, "remote.json");
    const sentinelContent = JSON.stringify({ pid: 424242, branch: "remote" });
    mkdirSync(connections, { recursive: true });
    try {
      for (const timeout of [undefined, "300"] as const) {
        writeFileSync(sentinel, sentinelContent);
        const run = spawnSync(
          process.execPath,
          ["test", "-t", "connect relayed local delivery retention.*with room the entry point writes the inbox", RELAY],
          {
            cwd: CLI,
            encoding: "utf8",
            timeout: 90_000,
            env: {
              ...process.env,
              HOME: home,
              ...(timeout ? { TPS_RELAY_LOSS_TEST_TIMEOUT_MS: timeout } : {}),
            },
          }
        );
        const output = `${run.stdout}\n${run.stderr}`;
        expect(run.error).toBeUndefined();
        let actual: string | null = null;
        try { actual = readFileSync(sentinel, "utf8"); } catch { actual = null; }
        expect(actual, output).toBe(sentinelContent);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
