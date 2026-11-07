/**
 * workflow-job-timeouts.test.ts — a CI job fails after a bounded time instead of
 * hanging (cli#799).
 *
 * Three runs hung at once: `test` ran 3 hours and `docker` 35-50 minutes,
 * against a normal 18-23, with no `timeout-minutes` and GitHub's 6-hour
 * default. This holds a timeout on covered jobs in test.yml, and makes a NEW job
 * choose a list: it must be named as a timeout job, or exempt with a reason.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

interface Job {
  "timeout-minutes"?: unknown;
}

interface Workflow {
  jobs?: Record<string, Job | null>;
}

const WORKFLOW = join(import.meta.dir, "..", "..", "..", ".github", "workflows", "test.yml");

/** Jobs whose timeout this test holds. */
const TIMEOUT_JOBS = [
  "build",
  "lint",
  "promote-latest-fixtures",
  "test",
  "node-plugin-load",
  "heartbeat-real-openclaw",
  "github-review-gateway-boundary",
  "reviewer-image",
  "audit",
  "docker",
  "binary-smoke",
  "nono-profile-gate",
  "sast-semgrep",
  "sast-codeql",
];

/**
 * The smallest timeout allowed. A job's timeout counts from job start, so
 * checkout, setup and a cold `bun install` are inside it; the floor allows
 * headroom for those on a slow day.
 */
const MIN_TIMEOUT_MINUTES = 10;

/** Jobs that run no tests, and why. Empty: every job is covered above. */
const EXEMPT: Record<string, string> = {};

function loadWorkflow(): Workflow {
  return yaml.load(readFileSync(WORKFLOW, "utf8")) as Workflow;
}

function displayValue(value: unknown): string {
  try {
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    return value === undefined ? "missing" : (JSON.stringify(value) ?? "<unprintable value>");
  } catch {
    return "<unprintable value>";
  }
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function timeoutProblems(
  wf: Workflow,
  timeoutJobs: readonly string[] = TIMEOUT_JOBS,
  exempt: Record<string, string> = EXEMPT,
): string[] {
  const jobs = wf.jobs ?? {};
  const ids = Object.keys(jobs);
  const problems: string[] = [];
  for (const id of ids) {
    if (timeoutJobs.includes(id) || Object.hasOwn(exempt, id)) continue;
    problems.push(
      `job "${id}" timeout-minutes ${displayValue(jobs[id]?.["timeout-minutes"])}: neither in TIMEOUT_JOBS nor exempt`,
    );
  }
  for (const id of timeoutJobs) {
    const value = jobs[id]?.["timeout-minutes"];
    if (!ids.includes(id)) {
      problems.push(
        `job "${id}" timeout-minutes ${displayValue(value)}: in TIMEOUT_JOBS but not in test.yml`,
      );
    } else if (!isPositiveInteger(value)) {
      problems.push(`job "${id}" timeout-minutes ${displayValue(value)}: not a positive integer`);
    } else if (value < MIN_TIMEOUT_MINUTES) {
      problems.push(
        `job "${id}" timeout-minutes ${value}: below the ${MIN_TIMEOUT_MINUTES}-minute floor`,
      );
    }
  }
  for (const id of Object.keys(exempt)) {
    if (!ids.includes(id)) {
      problems.push(`job "${id}" timeout-minutes missing: exempt but not in test.yml`);
    }
  }
  return problems;
}

describe("test.yml job timeouts (cli#799)", () => {
  test("covered jobs in test.yml set a positive integer timeout-minutes", () => {
    const problems = timeoutProblems(loadWorkflow());
    expect(problems, problems.join("; ")).toEqual([]);
  });

  test("every exempt job carries a reason", () => {
    for (const [id, why] of Object.entries(EXEMPT)) {
      expect(why.trim().length, `${id}: the reason is a sentence`).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("the timeout rule on fixtures", () => {
  const rule = (jobs: Record<string, Job | null>): string[] =>
    timeoutProblems({ jobs }, ["test"], { build: "this job runs no test step at all" });

  test("a listed job with no timeout fails, naming the job and value", () => {
    const problems = rule({ test: {}, build: {} });
    expect(problems.join("; ")).toContain(
      'job "test" timeout-minutes missing: not a positive integer',
    );
  });

  test("a zero and a fractional timeout both fail, naming the job and value", () => {
    const zero = rule({ test: { "timeout-minutes": 0 }, build: {} });
    const fractional = rule({ test: { "timeout-minutes": 2.5 }, build: {} });
    expect(zero.join("; ")).toContain('job "test" timeout-minutes 0: not a positive integer');
    expect(fractional.join("; ")).toContain(
      'job "test" timeout-minutes 2.5: not a positive integer',
    );
  });

  test("a non-integer timeout fails, naming the job and value", () => {
    const problems = rule({ test: { "timeout-minutes": "30" }, build: {} });
    expect(problems.join("; ")).toContain(
      'job "test" timeout-minutes "30": not a positive integer',
    );
  });

  test.each([
    [".inf", "Infinity"],
    ["-.inf", "-Infinity"],
    [".nan", "NaN"],
  ])("a YAML %s timeout fails, naming the job and %s", (scalar, value) => {
    const wf = yaml.load(`jobs:\n  test:\n    timeout-minutes: ${scalar}\n`) as Workflow;
    expect(timeoutProblems(wf, ["test"], {}).join("; ")).toContain(
      `job "test" timeout-minutes ${value}: not a positive integer`,
    );
  });

  test("a cyclic YAML timeout fails, naming the job and a readable value", () => {
    const wf = yaml.load("jobs:\n  test:\n    timeout-minutes: &x [*x]\n") as Workflow;
    expect(timeoutProblems(wf, ["test"], {}).join("; ")).toContain(
      'job "test" timeout-minutes <unprintable value>: not a positive integer',
    );
  });

  test("a new job in neither list fails, naming the job and value", () => {
    const problems = rule({ test: { "timeout-minutes": 50 }, build: {}, "new-lane": {} });
    expect(problems.join("; ")).toContain(
      'job "new-lane" timeout-minutes missing: neither in TIMEOUT_JOBS nor exempt',
    );
  });

  test("a listed job with a positive integer timeout and an exempt job pass", () => {
    expect(rule({ test: { "timeout-minutes": 50 }, build: {} })).toEqual([]);
  });
});
