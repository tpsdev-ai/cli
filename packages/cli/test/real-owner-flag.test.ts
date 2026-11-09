/**
 * cli#816 — the Docker lane's real-owner flag must not skip on a typo.
 *
 * The Docker Integration job runs `docker compose run --rm test` and reads the
 * exit status; the container's `test-reports/` is not mounted or read back, so
 * there is no lane report here to assert. This pins the value the lane sets to
 * the one the test honours as required.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { load } from "js-yaml";
import { GH_FLAG, parseRequireGh, parseRequireRealOwner, REAL_OWNER_FLAG } from "./helpers/real-owner-flag.js";

const repo = resolve(import.meta.dir, "../../..");

type Compose = {
  services: Record<string, { environment?: string[] }>;
};

test("the flag is required only for \"1\"; unset, empty and \"0\" are not required", () => {
  for (const value of [undefined, "", "0"]) {
    expect(parseRequireRealOwner({ [REAL_OWNER_FLAG]: value })).toBe(false);
  }
  expect(parseRequireRealOwner({ [REAL_OWNER_FLAG]: "1" })).toBe(true);
});

test("any other value throws at load, naming the variable and the accepted values", () => {
  for (const value of ["true", "yes", "2", " 1", "01", "0 "]) {
    expect(() => parseRequireRealOwner({ [REAL_OWNER_FLAG]: value })).toThrow(REAL_OWNER_FLAG);
    expect(() => parseRequireRealOwner({ [REAL_OWNER_FLAG]: value })).toThrow("{0,1}");
  }
});

test("docker-compose.yml sets a value the real-owner case honours as required", () => {
  const compose = load(readFileSync(join(repo, "docker-compose.yml"), "utf8")) as Compose;
  const environment = compose.services.test.environment ?? [];
  const set = environment.filter((entry) => entry.startsWith(`${REAL_OWNER_FLAG}=`));
  expect(set).toHaveLength(1);
  const value = set[0].slice(REAL_OWNER_FLAG.length + 1);
  expect(parseRequireRealOwner({ [REAL_OWNER_FLAG]: value })).toBe(true);
  // This service does not override the launcher's default report directory.
  expect(environment.some((entry) => entry.startsWith("TPS_TEST_REPORT_DIR="))).toBe(false);
});

test("the gh flag accepts unset, empty, zero and one; other values throw", () => {
  for (const value of [undefined, "", "0"]) {
    expect(parseRequireGh({ [GH_FLAG]: value })).toBe(false);
  }
  expect(parseRequireGh({ [GH_FLAG]: "1" })).toBe(true);
  for (const value of ["true", "yes", "2", " 1", "01", "0 "]) {
    expect(() => parseRequireGh({ [GH_FLAG]: value })).toThrow(GH_FLAG);
    expect(() => parseRequireGh({ [GH_FLAG]: value })).toThrow("{0,1}");
  }
});

test("the Unit test step requires gh and the Docker job does not", () => {
  const workflow = load(readFileSync(join(repo, ".github/workflows/test.yml"), "utf8")) as {
    jobs: Record<string, { env?: Record<string, string>; steps: Array<{ name?: string; env?: Record<string, string> }> }>;
  };
  const unitSteps = Object.values(workflow.jobs).flatMap((job) => job.steps)
    .filter((step) => step.name === "Unit + integration tests, HOME-isolated (cli#430)");
  expect(unitSteps).toHaveLength(1);
  expect(unitSteps[0].env?.[GH_FLAG]).toBe("1");
  expect(workflow.jobs.docker.env?.[GH_FLAG]).toBeUndefined();
  for (const step of workflow.jobs.docker.steps) expect(step.env?.[GH_FLAG]).toBeUndefined();
});
