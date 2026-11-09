/**
 * workflow-job-timeouts.test.ts — a CI job fails after a bounded time instead of
 * hanging (cli#799, cli#812).
 *
 * Three runs hung at once: `test` ran 3 hours and `docker` 35-50 minutes,
 * against a normal 18-23, with no `timeout-minutes` and GitHub's 6-hour
 * default. Every job in every workflow file must set one, or be named as an
 * exemption with a reason.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

interface Job {
  "timeout-minutes"?: unknown;
}

interface Workflow {
  jobs?: Record<string, Job | null>;
}

const WORKFLOW_DIR = join(import.meta.dir, "..", "..", "..", ".github", "workflows");

/**
 * The smallest timeout allowed. A job's timeout counts from job start, so
 * checkout, setup and a cold `bun install` are inside it; the floor allows
 * headroom for those on a slow day.
 */
const MIN_TIMEOUT_MINUTES = 10;

/**
 * Jobs that cannot carry `timeout-minutes`, keyed `<workflow file>:<job id>`.
 * Empty: every job in every workflow is covered. A job-level `uses:` caller
 * belongs here, with the reason it cannot set a timeout.
 */
const EXEMPT: Record<string, string> = {};

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
}

function loadWorkflow(file: string): Workflow {
  return yaml.load(readFileSync(join(WORKFLOW_DIR, file), "utf8")) as Workflow;
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
  file: string,
  wf: Workflow,
  exempt: Record<string, string> = EXEMPT,
): string[] {
  const jobs = wf.jobs ?? {};
  const ids = Object.keys(jobs);
  const problems: string[] = [];
  for (const id of ids) {
    const key = `${file}:${id}`;
    if (Object.hasOwn(exempt, key)) continue;
    const value = jobs[id]?.["timeout-minutes"];
    if (!isPositiveInteger(value)) {
      problems.push(`job "${key}" timeout-minutes ${displayValue(value)}: not a positive integer`);
    } else if (value < MIN_TIMEOUT_MINUTES) {
      problems.push(
        `job "${key}" timeout-minutes ${value}: below the ${MIN_TIMEOUT_MINUTES}-minute floor`,
      );
    }
  }
  for (const key of Object.keys(exempt)) {
    if (!key.startsWith(`${file}:`)) continue;
    const id = key.slice(file.length + 1);
    if (!ids.includes(id)) {
      problems.push(`job "${key}" timeout-minutes missing: exempt but not in this workflow`);
    }
  }
  return problems;
}

describe("every workflow job has a timeout (cli#799, cli#812)", () => {
  const files = workflowFiles();

  test("the workflow directory has at least one file", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files)("%s sets a positive integer timeout-minutes on every job", (file) => {
    const problems = timeoutProblems(file, loadWorkflow(file));
    expect(problems, problems.join("; ")).toEqual([]);
  });

  test("every exempt job carries a reason", () => {
    for (const [key, why] of Object.entries(EXEMPT)) {
      expect(why.trim().length, `${key}: the reason is a sentence`).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("the timeout rule on fixtures", () => {
  const rule = (jobs: Record<string, Job | null>): string[] =>
    timeoutProblems("fixture.yml", { jobs });

  test("a job with no timeout fails, naming the file and job", () => {
    const problems = rule({ build: {} });
    expect(problems.join("; ")).toContain(
      'job "fixture.yml:build" timeout-minutes missing: not a positive integer',
    );
  });

  test("a zero and a fractional timeout both fail, naming the file and value", () => {
    const zero = rule({ build: { "timeout-minutes": 0 } });
    const fractional = rule({ build: { "timeout-minutes": 2.5 } });
    expect(zero.join("; ")).toContain(
      'job "fixture.yml:build" timeout-minutes 0: not a positive integer',
    );
    expect(fractional.join("; ")).toContain(
      'job "fixture.yml:build" timeout-minutes 2.5: not a positive integer',
    );
  });

  test("a non-integer timeout fails, naming the file and value", () => {
    const problems = rule({ build: { "timeout-minutes": "30" } });
    expect(problems.join("; ")).toContain(
      'job "fixture.yml:build" timeout-minutes "30": not a positive integer',
    );
  });

  test("a timeout below the floor fails, naming the file and value", () => {
    const problems = rule({ build: { "timeout-minutes": 5 } });
    expect(problems.join("; ")).toContain(
      'job "fixture.yml:build" timeout-minutes 5: below the 10-minute floor',
    );
  });

  test.each([
    [".inf", "Infinity"],
    ["-.inf", "-Infinity"],
    [".nan", "NaN"],
  ])("a YAML %s timeout fails, naming the file and %s", (scalar, value) => {
    const wf = yaml.load(`jobs:\n  build:\n    timeout-minutes: ${scalar}\n`) as Workflow;
    expect(timeoutProblems("fixture.yml", wf).join("; ")).toContain(
      `job "fixture.yml:build" timeout-minutes ${value}: not a positive integer`,
    );
  });

  test("a cyclic YAML timeout names the file and prints <unprintable value>", () => {
    const wf = yaml.load("jobs:\n  build:\n    timeout-minutes: &x [*x]\n") as Workflow;
    expect(timeoutProblems("fixture.yml", wf).join("; ")).toContain(
      'job "fixture.yml:build" timeout-minutes <unprintable value>: not a positive integer',
    );
  });

  test("a positive integer timeout passes", () => {
    expect(rule({ build: { "timeout-minutes": 10 } })).toEqual([]);
  });

  test("an exempt job with a reason passes, and a missing exempt job fails", () => {
    const exempt = { "fixture.yml:build": "a reusable-workflow caller cannot take a timeout" };
    expect(timeoutProblems("fixture.yml", { jobs: { build: {} } }, exempt)).toEqual([]);
    expect(timeoutProblems("fixture.yml", { jobs: {} }, exempt).join("; ")).toContain(
      'job "fixture.yml:build" timeout-minutes missing: exempt but not in this workflow',
    );
  });
});
