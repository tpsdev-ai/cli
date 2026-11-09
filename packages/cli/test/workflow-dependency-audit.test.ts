import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

interface Step extends Record<string, unknown> {
  id?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
  env?: Record<string, string>;
  if?: unknown;
  "continue-on-error"?: unknown;
}

interface Job extends Record<string, unknown> {
  steps: Step[];
  permissions: Record<string, string>;
  needs?: string;
  if?: string;
  outputs?: Record<string, string>;
  "continue-on-error"?: unknown;
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
}

const REPO = join(import.meta.dir, "..", "..", "..");
const load = (file: string) =>
  yaml.load(readFileSync(join(REPO, ".github/workflows", file), "utf8")) as Workflow;
const scheduled = load("dependency-audit.yml");
const source = load("test.yml");
const notify = scheduled.jobs.notify.steps[0];
const title = "Dependency audit failure on main";
const runEnv = {
  REPOSITORY: "example/repo",
  SERVER_URL: "https://github.example",
  RUN_ID: "12345",
  MAIN_SHA: "a".repeat(40),
  ISSUE_TITLE: title,
};

function notificationScript(): string {
  if (!notify.run) throw new Error("missing notification script");
  return notify.run;
}

describe("scheduled dependency audit (cli#332)", () => {
  test("daily schedule and manual dispatch", () => {
    expect(Object.keys(scheduled.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(scheduled.on.schedule).toEqual([{ cron: "23 7 * * *" }]);
    expect(scheduled.concurrency).toEqual({
      group: "scheduled-dependency-audit",
      "cancel-in-progress": false,
    });
  });

  test("audit setup and checks match the PR audit in order", () => {
    expect(scheduled.jobs.audit.steps.slice(2)).toEqual(source.jobs.audit.steps.slice(1));
    const checkout = scheduled.jobs.audit.steps[0];
    expect(checkout).toEqual({
      ...source.jobs.audit.steps[0],
      with: { ...source.jobs.audit.steps[0].with, ref: "main" },
    });
    for (const field of ["runs-on", "env", "defaults", "timeout-minutes"]) {
      expect(scheduled.jobs.audit[field]).toEqual(source.jobs.audit[field]);
    }
    const capture = scheduled.jobs.audit.steps[1];
    expect(capture.id).toBe("main");
    expect(capture.run).toBe('git rev-parse HEAD | sed \'s/^/sha=/\' >> "$GITHUB_OUTPUT"');
    expect(scheduled.jobs.audit.outputs).toEqual({ "main-sha": "${{ steps.main.outputs.sha }}" });
  });

  test("audit failures remain failures", () => {
    const audit = scheduled.jobs.audit;
    expect(audit.if).toBeUndefined();
    expect(audit["continue-on-error"]).toBeUndefined();
    expect(audit.steps.some((step) => step.run === "bun audit")).toBe(true);
    for (const step of audit.steps) {
      expect(step["continue-on-error"]).toBeUndefined();
      expect(step.if).toBeUndefined();
      expect(step.run ?? "").not.toMatch(/\|\|\s*true/);
    }
  });

  test("notification needs audit failure and holds the issue write grant", () => {
    expect(scheduled.permissions).toEqual({});
    expect(scheduled.jobs.notify.needs).toBe("audit");
    expect(scheduled.jobs.notify.if).toBe("${{ failure() && needs.audit.result == 'failure' }}");
    expect(Object.keys(scheduled.jobs).sort()).toEqual(["audit", "notify"]);
    expect(scheduled.jobs.audit.permissions).toEqual({ contents: "read" });
    expect(scheduled.jobs.notify.permissions).toEqual({ issues: "write" });
    expect(scheduled.jobs.notify["continue-on-error"]).toBeUndefined();
    expect(scheduled.jobs.notify.steps).toHaveLength(1);
    expect(notify.if).toBeUndefined();
    expect(notify["continue-on-error"]).toBeUndefined();
  });

  test("actions are SHA-pinned and run values enter the notification through env", () => {
    for (const job of Object.values(scheduled.jobs)) {
      for (const step of job.steps) {
        if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
        expect(step.run ?? "").not.toContain("${{");
      }
    }
    expect(notify.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      REPOSITORY: "${{ github.repository }}",
      SERVER_URL: "${{ github.server_url }}",
      RUN_ID: "${{ github.run_id }}",
      MAIN_SHA: "${{ needs.audit.outputs.main-sha }}",
      ISSUE_TITLE: title,
    });
  });
});

function fakeGh(open: boolean, fail = "") {
  const root = mkdtempSync(join(tmpdir(), "dependency-audit-"));
  try {
    const calls = join(root, "calls.jsonl");
    const items = [
      { number: 1, title, pull_request: {} },
      { number: 2, title: `${title} extra` },
      { number: 3, title, user: { login: "someone-else" } },
      ...(open ? [{ number: 42, title, user: { login: "github-actions[bot]" } }] : []),
    ];
    writeFileSync(join(root, "issues.json"), JSON.stringify(items));
    writeFileSync(join(root, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + "\\n");
const post = args.includes("POST");
if ((!post && process.env.FAIL === "list") ||
    (post && process.env.FAIL === "post")) process.exit(7);
if (!post) {
  if (!args.includes("--paginate")) process.exit(8);
  const result = cp.spawnSync("jq", ["-r", args[args.indexOf("--jq") + 1]], {
    input: fs.readFileSync(process.env.ITEMS), encoding: "utf8"
  });
  process.stdout.write(result.stdout);
  process.exit(result.status ?? 9);
}
`, { mode: 0o700 });
    const result = spawnSync("bash", ["-c", notificationScript()], {
      encoding: "utf8",
      env: {
        ...process.env, ...runEnv,
        PATH: `${root}:${process.env.PATH}`,
        CALLS: calls,
        ITEMS: join(root, "issues.json"),
        FAIL: fail,
      },
    });
    return {
      result,
      calls: readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectBody(args: string[]) {
  const body = args.find((arg) => arg.startsWith("body="));
  expect(body).toContain("https://github.example/example/repo/actions/runs/12345");
  expect(body).toContain(`Main SHA: ${runEnv.MAIN_SHA}`);
}

describe("audit notification with a gh fixture", () => {
  test("opens an issue when no open issue with the tracking title was opened by github-actions[bot]", () => {
    const { result, calls } = fakeGh(false);
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0].slice(0, 3)).toEqual([
      "api", "--paginate", "repos/example/repo/issues?state=open&per_page=100",
    ]);
    expect(calls[1].slice(0, 4)).toEqual(["api", "--method", "POST", "repos/example/repo/issues"]);
    expect(calls[1]).toContain(`title=${title}`);
    expectBody(calls[1]);
  });

  test("comments on an open tracking issue without creating an issue", () => {
    const { result, calls } = fakeGh(true);
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].slice(0, 4)).toEqual([
      "api", "--method", "POST", "repos/example/repo/issues/42/comments",
    ]);
    expectBody(calls[1]);
  });

  test.each([false, true])("exits nonzero when the API list fails (open=%s)", (open) => {
    const { result, calls } = fakeGh(open, "list");
    expect(result.status).not.toBe(0);
    expect(calls).toHaveLength(1);
  });

  test.each([false, true])("exits nonzero when the API write fails (open=%s)", (open) => {
    const { result } = fakeGh(open, "post");
    expect(result.status).not.toBe(0);
  });
});
