/**
 * workflow-job-timeouts.test.ts — a CI job that runs tests fails after a bounded
 * time instead of hanging (cli#799).
 *
 * Three runs hung at once: `test` ran 3 hours and `docker` 35-50 minutes,
 * against a normal 18-23, with no `timeout-minutes` and GitHub's 6-hour
 * default. This holds the timeout on every job that runs a suite or a
 * test-like lane, and makes a NEW job choose a list: it must be named as a
 * timeout job, or exempt with a reason.
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

/** Jobs that run a test suite or a test-like lane (fixtures, gates, a built binary). */
const TIMEOUT_JOBS = [
  "test",
  "docker",
  "lint",
  "promote-latest-fixtures",
  "node-plugin-load",
  "heartbeat-real-openclaw",
  "github-review-gateway-boundary",
  "reviewer-image",
  "binary-smoke",
  "nono-profile-gate",
];

/** Jobs that run no tests, and why. */
const EXEMPT: Record<string, string> = {
  build: "installs dependencies and runs the TypeScript build; no test step",
  audit: "runs `bun audit` only; no test step",
  "sast-semgrep": "runs the Semgrep scanner only; no test step",
  "sast-codeql": "runs the CodeQL scanner only; no test step",
};

function loadWorkflow(): Workflow {
  return yaml.load(readFileSync(WORKFLOW, "utf8")) as Workflow;
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function timeoutProblems(
  wf: Workflow,
  timeoutJobs: readonly string[] = TIMEOUT_JOBS,
  exempt: Record<string, string> = EXEMPT,
): string[] {
  const jobs = Object.keys(wf.jobs ?? {});
  const problems: string[] = [];
  for (const id of jobs) {
    if (timeoutJobs.includes(id) || Object.hasOwn(exempt, id)) continue;
    problems.push(`job "${id}" is neither in TIMEOUT_JOBS nor exempt; add it to one`);
  }
  for (const id of timeoutJobs) {
    if (!jobs.includes(id)) {
      problems.push(`job "${id}" is in TIMEOUT_JOBS but not in test.yml`);
    } else if (!isPositiveInteger(wf.jobs?.[id]?.["timeout-minutes"])) {
      problems.push(`job "${id}" does not set a positive integer timeout-minutes`);
    }
  }
  for (const id of Object.keys(exempt)) {
    if (!jobs.includes(id)) problems.push(`job "${id}" is exempt but not in test.yml`);
  }
  return problems;
}

describe("test.yml job timeouts (cli#799)", () => {
  test("every job that runs tests sets a positive integer timeout-minutes", () => {
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

  test("a listed job with no timeout fails, naming the job", () => {
    const problems = rule({ test: {}, build: {} });
    expect(problems.join("; ")).toContain(
      'job "test" does not set a positive integer timeout-minutes',
    );
  });

  test("a new job in neither list fails, naming the job", () => {
    const problems = rule({ test: { "timeout-minutes": 50 }, build: {}, "new-lane": {} });
    expect(problems.join("; ")).toContain('job "new-lane" is neither in TIMEOUT_JOBS nor exempt');
  });

  test("a zero and a fractional timeout both fail", () => {
    const zero = rule({ test: { "timeout-minutes": 0 }, build: {} });
    const fractional = rule({ test: { "timeout-minutes": 2.5 }, build: {} });
    expect(zero.join("; ")).toContain('job "test" does not set a positive integer timeout-minutes');
    expect(fractional.join("; ")).toContain(
      'job "test" does not set a positive integer timeout-minutes',
    );
  });

  test("a listed job with a positive integer timeout and an exempt job pass", () => {
    expect(rule({ test: { "timeout-minutes": 50 }, build: {} })).toEqual([]);
  });
});
