/**
 * relay-timeout-cascade-770.test.ts — a timed-out relay-delivery-loss case must
 * not leave the audited environment keys for the next file in the same bun
 * process.
 *
 * The lane runs relay-delivery-loss.test.ts and then probe.fixture.ts in ONE
 * child bun process, the way scripts/test-suite.mjs runs the cli lane. A short
 * hook deadline (--timeout=1000) makes the case's cleanup exceed its deadline;
 * the probe then compares the audited environment keys with the one the lane
 * started with. It fails on the unfixed file, naming the leaked names.
 *
 * A second lane throws right after the receipt TTL assignment, before the case's
 * local try: the next file must still see the audited keys restored.
 *
 * A third lane runs a connect case with a baseline home whose connection-state
 * file is a sentinel: the case's cleanup must resolve paths from its own HOME,
 * so the sentinel is unchanged, with and without a forced timeout.
 *
 * A fourth lane makes one case's cleanup outlast its afterEach deadline and
 * settle while the next case runs: the next case's environment must still be
 * its own.
 *
 * Every child run that is expected to select a case must show that case ran:
 * a load failure, a preload refusal or a filter that matched nothing is not a
 * pass.
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
const CASE = "with room the entry point writes the inbox and acknowledges the source";
const SYNC_CASE = `sync relayed local delivery retention.*${CASE}`;
const CONNECT_CASE = `connect relayed local delivery retention.*${CASE}`;
const PROBE_CASE = "the next file sees the audited environment keys restored";

/** Output that means the child never reached a selected case. */
const LOAD_FAILURE = /Unhandled error between tests|Cannot find module|Cannot find package|HOME-ISOLATION GUARD: refusing|matched 0 tests|error: preload/;

function assertNoLoadFailure(output: string): void {
  expect(LOAD_FAILURE.test(output), output).toBe(false);
}

function caseLine(output: string, name: string): string {
  const line = output.split("\n").find((candidate) => /^\((pass|fail|skip|todo)\)/.test(candidate) && candidate.includes(name));
  expect(line, `case ${name} did not run:\n${output}`).toBeDefined();
  return line!;
}

function assertCasePassed(output: string, name: string): void {
  assertNoLoadFailure(output);
  const passes = Number(/^\s*(\d+) pass\s*$/m.exec(output)?.[1] ?? 0);
  expect(passes, output).toBeGreaterThanOrEqual(1);
  expect(caseLine(output, name).startsWith("(pass)"), output).toBe(true);
}

function assertCaseTimedOut(output: string, name: string): void {
  assertNoLoadFailure(output);
  const line = caseLine(output, name);
  expect(line.startsWith("(fail)"), output).toBe(true);
  const at = output.split("\n").indexOf(line);
  expect(
    output.split("\n").slice(at, at + 3).join("\n"),
    output
  ).toMatch(/this test timed out after|a beforeEach\/afterEach hook timed out for this test/);
}

function baselineOfCurrentEnv(): Record<string, string | null> {
  const baseline: Record<string, string | null> = {};
  for (const key of KEYS) baseline[key] = process.env[key] ?? null;
  return baseline;
}

function runChild(args: string[], env: Record<string, string>): { output: string; status: number | null } {
  const run = spawnSync(process.execPath, args, {
    cwd: CLI,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
  expect(run.error).toBeUndefined();
  return { output: `${run.stdout}\n${run.stderr}`, status: run.status };
}

describe("a timed-out relay case leaves no environment for the next file (cli#770)", () => {
  test("the probe after relay-delivery-loss sees the lane's original environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-relay-cascade-"));
    const baselinePath = join(dir, "baseline.json");
    const resultPath = join(dir, "result.json");
    const markerPath = join(dir, "cleanup.marker");
    const baseline = baselineOfCurrentEnv();
    writeFileSync(baselinePath, JSON.stringify(baseline));
    try {
      const { output } = runChild(
        ["test", "--timeout=1000", "-t", `${SYNC_CASE}|${PROBE_CASE}`, RELAY, PROBE],
        {
          TPS_RELAY_LOSS_TEST_TIMEOUT_MS: "300",
          TPS_RELAY_LOSS_CLEANUP_MARKER: markerPath,
          TPS_RELAY_PROBE_BASELINE: baselinePath,
          TPS_RELAY_PROBE_RESULT: resultPath,
        }
      );
      assertCaseTimedOut(output, CASE);
      assertCasePassed(output, PROBE_CASE);
      expect(readFileSync(markerPath, "utf8"), output).toContain("sync");
      expect(existsSync(resultPath), output).toBe(true);
      const diff = JSON.parse(readFileSync(resultPath, "utf8"));
      expect(diff, output).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

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
      const { output } = runChild(
        ["test", "-t", "a receipt older than the prune bound|with room the entry point writes the inbox", RELAY, PROBE],
        {
          TPS_RELAY_LOSS_THROW_AFTER_TTL_ASSIGN: "1",
          TPS_RELAY_PROBE_BASELINE: baselinePath,
          TPS_RELAY_PROBE_RESULT: resultPath,
        }
      );
      assertNoLoadFailure(output);
      expect(output).toContain("injected throw after the receipt TTL assignment");
      assertCasePassed(output, PROBE_CASE);
      expect(existsSync(resultPath), output).toBe(true);
      expect(JSON.parse(readFileSync(resultPath, "utf8")), output).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

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
        const markerPath = join(dir, `cleanup-${timeout ?? "none"}.marker`);
        const { output } = runChild(
          ["test", ...(timeout ? ["--timeout=1000"] : []), "-t", CONNECT_CASE, RELAY],
          {
            HOME: home,
            TPS_RELAY_LOSS_CLEANUP_MARKER: markerPath,
            ...(timeout ? { TPS_RELAY_LOSS_TEST_TIMEOUT_MS: timeout } : {}),
          }
        );
        if (timeout) {
          assertCaseTimedOut(output, CASE);
          expect(readFileSync(markerPath, "utf8"), output).toContain("connect");
        } else {
          assertCasePassed(output, CASE);
        }
        let actual: string | null = null;
        try { actual = readFileSync(sentinel, "utf8"); } catch { actual = null; }
        expect(actual, output).toBe(sentinelContent);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  test("the run checks reject a child whose selected case never executed", () => {
    const dir = mkdtempSync(join(tmpdir(), "tps-relay-negative-"));
    try {
      const broken = join(dir, "load-failure.test.ts");
      writeFileSync(broken, [
        'import { test } from "bun:test";',
        'import "./does-not-exist.js";',
        `test(${JSON.stringify(CONNECT_CASE)}, () => {});`,
        "",
      ].join("\n"));
      const skipped = join(dir, "case-skipped.test.ts");
      writeFileSync(skipped, [
        'import { test } from "bun:test";',
        'test("an unrelated case", () => {});',
        `test.skip(${JSON.stringify(CONNECT_CASE)}, () => {});`,
        "",
      ].join("\n"));
      const brokenRun = runChild(["test", broken], {});
      expect(() => assertCasePassed(brokenRun.output, CASE)).toThrow();
      const skippedRun = runChild(["test", skipped], {});
      expect(() => assertCasePassed(skippedRun.output, CASE)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test("a later case keeps its environment while an earlier cleanup settles late", () => {
    const { output } = runChild(
      ["test", "--timeout=1000", "-t", `(a cleanup that outlasts its hook deadline|environment stays with the case while the previous cleanup settles)`, RELAY],
      { TPS_RELAY_LOSS_SLOW_CLEANUP_MS: "1500" }
    );
    assertNoLoadFailure(output);
    const donor = output.split("\n").find((line) => line.includes("> a cleanup that outlasts its hook deadline"));
    expect(donor, output).toBeDefined();
    expect(donor!.startsWith("(fail)"), output).toBe(true);
    expect(output).toContain("a beforeEach/afterEach hook timed out for this test");
    assertCasePassed(output, "environment stays with the case while the previous cleanup settles");
  }, 120_000);
});
