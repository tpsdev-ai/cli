import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { isolatedChildEnv } from "../scripts/test-home-guard.mjs";

test("Unit & Integration Tests requires npm through the isolated launcher", () => {
  type Step = { name?: string; run?: string; if?: unknown; "continue-on-error"?: unknown };
  type Job = { steps: Step[]; if?: unknown; "continue-on-error"?: unknown };
  const workflow = load(readFileSync(join(import.meta.dir, "../.github/workflows/test.yml"), "utf8")) as { jobs: Record<string, Job> };
  const job = workflow.jobs.test;
  const steps = job.steps.filter((step) => step.name === "Unit + integration tests, HOME-isolated (cli#430)");
  expect(steps).toHaveLength(1);
  const step = steps[0];
  const value = step.run?.match(/^HOME="\$iso_home" TPS_TEST_REQUIRE_NPM=(\S+) bun run test$/m)?.[1];
  expect(value).toBe("1");
  for (const target of [job, step]) {
    expect(target).not.toHaveProperty("if");
    expect(target).not.toHaveProperty("continue-on-error");
  }
  const { env } = isolatedChildEnv({ TPS_TEST_REQUIRE_NPM: value }, { root: "/isolated", token: "fixture" });
  expect(env.TPS_TEST_REQUIRE_NPM).toBe("1");
});

test.each([
  [undefined, 0, ""],
  ["1", 1, "TPS_TEST_REQUIRE_NPM=1 requires executable npm on PATH"],
  ["yes", 1, "invalid TPS_TEST_REQUIRE_NPM"],
  ["", 1, "invalid TPS_TEST_REQUIRE_NPM"],
  ["0", 1, "invalid TPS_TEST_REQUIRE_NPM"],
  ["1/", 1, "invalid TPS_TEST_REQUIRE_NPM"],
] as const)("the launcher enforces TPS_TEST_REQUIRE_NPM=%j without npm", (value, status, diagnostic) => {
  const root = mkdtempSync(join(tmpdir(), "npm-requirement-"));
  try {
    const bin = join(root, "bin");
    const home = join(root, "home");
    mkdirSync(bin);
    mkdirSync(home);
    const node = Bun.which("node");
    if (!node) throw new Error("node is required to run the test launcher");
    symlinkSync(process.execPath, join(bin, "bun"));
    const env: Record<string, string> = {
      PATH: bin, HOME: home, TMPDIR: "/tmp", TPS_TEST_REPORT_DIR: join(root, "reports"),
    };
    if (value !== undefined) env.TPS_TEST_REQUIRE_NPM = value;
    const result = spawnSync(node, [
      join(import.meta.dir, "../scripts/test-suite.mjs"), "npm-requirement",
      join(import.meta.dir, "check-dep-ages.test.ts"),
      "--test-name-pattern", "validates TPS_TEST_REQUIRE_NPM",
    ], { env, encoding: "utf8", timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(status);
    if (diagnostic) expect(result.stdout + result.stderr).toContain(diagnostic);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
